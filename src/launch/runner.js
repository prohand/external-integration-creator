// -----------------------------------------------------------------------------
// Runs a list of steps of an integration (the launch, or the publication),
// one after the other, saves every state change in /data and pushes it live
// to the browser (SSE).
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { log, redact } from '../log.js';
import { ApiError } from '../web.js';
import { STEPS } from './steps.js';

const MAX_LOG_LINES = 200;
const FINISHED = ['done', 'warning', 'skipped'];
// Fields owned by the runners: never overwritten by a step's draft.
const STEP_FIELDS = ['steps', 'publishSteps'];

export const channelOf = (id) => `launch:${id}`;

export function emptySteps(defs = STEPS) {
  return Object.fromEntries(
    defs.map((s) => [s.id, { status: 'todo', message: '', log: [], startedAt: null, finishedAt: null }]),
  );
}

/** Global state of a list of steps. */
export function overallStatus(integ, running = false, defs = STEPS, field = 'steps') {
  if (running) return 'running';
  const steps = defs.map((s) => ({ ...s, state: integ[field]?.[s.id] }));
  if (steps.some((s) => s.state?.status === 'error')) return 'error';
  if (steps.some((s) => s.state?.status === 'todo' || s.state?.status === 'running')) return 'todo';
  if (steps.some((s) => s.state?.status === 'warning')) return 'warning';
  return 'done';
}

export function stepEnabled(step, integ) {
  return !step.option || integ.actions?.[step.option] !== false;
}

export class Runner {
  /**
   * @param {object} opts
   * @param {import('../db.js').Db} opts.db
   * @param {import('../sse.js').Hub} opts.hub
   * @param {(integ, log) => Promise<object>} opts.context - builds the step context
   */
  constructor({ db, hub, context, steps = STEPS, field = 'steps', label = 'Ce lancement' }) {
    this.db = db;
    this.hub = hub;
    this.context = context;
    this.steps = steps;
    this.field = field;
    this.label = label;
    this.active = new Map(); // id -> promise
    this.decorate = (view) => view; // adds the other runner's summary
    this.onChange = null; // replaces publish() when set
  }

  find(id) {
    const integ = this.db.read().integrations.find((i) => i.id === id);
    if (!integ) throw new ApiError(404, 'Intégration introuvable.');
    return integ;
  }

  /** Status and steps of this runner for one integration. */
  summary(integ) {
    if (!integ[this.field]) return { status: null, stepList: [] };
    return {
      status: overallStatus(integ, this.active.has(integ.id), this.steps, this.field),
      stepList: this.steps.map((s) => ({
        id: s.id,
        title: s.title,
        essential: Boolean(s.essential),
        ...integ[this.field][s.id],
      })),
    };
  }

  /** Public view of a launch (no secret is ever stored in it). */
  view(integ) {
    return this.decorate({ ...integ, ...this.summary(integ) }, integ);
  }

  publish(id) {
    if (this.onChange) return this.onChange(id);
    this.hub.publish(channelOf(id), 'launch', this.view(this.find(id)));
    return undefined;
  }

  /** Starts over with fresh steps (a new publication). */
  async reset(id, fields = {}) {
    await this.patchInteg(id, (integ) => {
      Object.assign(integ, fields);
      integ[this.field] = emptySteps(this.steps);
    });
  }

  async create(fields) {
    const integ = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      links: {},
      ...fields,
      steps: emptySteps(),
    };
    await this.db.update((state) => {
      state.integrations.push(integ);
    });
    return integ;
  }

  async patchInteg(id, mutate) {
    await this.db.update((state) => {
      const integ = state.integrations.find((i) => i.id === id);
      if (integ) mutate(integ);
    });
  }

  async patchStep(id, stepId, changes) {
    await this.patchInteg(id, (integ) => {
      integ[this.field][stepId] = { ...integ[this.field][stepId], ...changes };
    });
    this.publish(id);
  }

  /** Runs every step not run yet, starting at index `from` (always run). */
  start(id, from = 0) {
    if (this.active.has(id)) throw new ApiError(409, `${this.label} est déjà en cours.`);
    const promise = this.run(id, from)
      .catch((err) => log.error(`${this.label} ${id} interrompu`, { error: err.message }))
      .finally(() => {
        this.active.delete(id);
        this.publish(id);
      });
    this.active.set(id, promise);
    this.publish(id);
    return promise;
  }

  /** "Relancer" button: runs this step again, then the ones never run. */
  retry(id, stepId) {
    const index = this.steps.findIndex((s) => s.id === stepId);
    if (index < 0) throw new ApiError(404, 'Étape inconnue.');
    const integ = this.find(id);
    if (!integ[this.field]) throw new ApiError(409, 'Rien à relancer.');
    const blocking = this.steps.slice(0, index).find(
      (s) => s.essential && !FINISHED.includes(integ[this.field][s.id]?.status) && stepEnabled(s, integ),
    );
    if (blocking) {
      throw new ApiError(409, `Il faut d’abord réussir l’étape « ${blocking.title} ».`);
    }
    return this.start(id, index);
  }

  async run(id, from) {
    for (let i = from; i < this.steps.length; i += 1) {
      const step = this.steps[i];
      let integ = this.find(id);
      if (i > from && integ[this.field][step.id].status !== 'todo') continue;

      if (!stepEnabled(step, integ)) {
        await this.patchStep(id, step.id, {
          status: 'skipped',
          message: 'Désactivée dans le formulaire.',
          finishedAt: new Date().toISOString(),
        });
        continue;
      }

      const lines = [];
      const addLine = (message, level = 'info') => {
        const entry = { t: new Date().toISOString(), level, message: redact(String(message)) };
        lines.push(entry);
        this.hub.publish(channelOf(id), 'log', { step: step.id, ...entry });
      };
      await this.patchStep(id, step.id, {
        status: 'running',
        message: 'En cours…',
        log: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });

      integ = this.find(id);
      const draft = structuredClone(integ);
      const saveInteg = () =>
        this.patchInteg(id, (target) => {
          const fields = { ...draft };
          for (const f of STEP_FIELDS) delete fields[f];
          Object.assign(target, fields);
        });
      let outcome;
      try {
        const ctx = await this.context(draft, addLine);
        ctx.saveInteg = saveInteg;
        const result = (await step.run(ctx)) ?? {};
        outcome = { status: result.status ?? 'done', message: result.message ?? '', data: result.data };
      } catch (err) {
        addLine(err.message, 'error');
        outcome = { status: step.essential ? 'error' : 'warning', message: redact(err.message) };
      }
      await saveInteg();
      await this.patchStep(id, step.id, {
        ...outcome,
        log: lines.slice(-MAX_LOG_LINES),
        finishedAt: new Date().toISOString(),
      });
      if (outcome.status === 'error') return;
    }
  }

  /** After a restart, steps left "running" are marked as interrupted. */
  async recover() {
    await this.db.update((state) => {
      for (const integ of state.integrations) {
        for (const step of Object.values(integ[this.field] ?? {})) {
          if (step.status === 'running') {
            step.status = 'error';
            step.message = 'Interrompue par un redémarrage de l’appli : relancez-la.';
          }
        }
      }
    });
  }
}
