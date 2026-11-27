// -----------------------------------------------------------------------------
// Runs the launch steps of an integration, one after the other, saves every
// state change in /data and pushes it live to the browser (SSE).
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { log, redact } from '../log.js';
import { ApiError } from '../web.js';
import { STEPS } from './steps.js';

const MAX_LOG_LINES = 200;
const FINISHED = ['done', 'warning', 'skipped'];

export const channelOf = (id) => `launch:${id}`;

export function emptySteps() {
  return Object.fromEntries(
    STEPS.map((s) => [s.id, { status: 'todo', message: '', log: [], startedAt: null, finishedAt: null }]),
  );
}

/** Global state of a launch, from its steps. */
export function overallStatus(integ, running = false) {
  if (running) return 'running';
  const steps = STEPS.map((s) => ({ ...s, state: integ.steps?.[s.id] }));
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
  constructor({ db, hub, context }) {
    this.db = db;
    this.hub = hub;
    this.context = context;
    this.active = new Map(); // id -> promise
  }

  find(id) {
    const integ = this.db.read().integrations.find((i) => i.id === id);
    if (!integ) throw new ApiError(404, 'Intégration introuvable.');
    return integ;
  }

  /** Public view of a launch (no secret is ever stored in it). */
  view(integ) {
    return {
      ...integ,
      status: overallStatus(integ, this.active.has(integ.id)),
      stepList: STEPS.map((s) => ({
        id: s.id,
        title: s.title,
        essential: Boolean(s.essential),
        ...integ.steps[s.id],
      })),
    };
  }

  publish(id) {
    this.hub.publish(channelOf(id), 'launch', this.view(this.find(id)));
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
      integ.steps[stepId] = { ...integ.steps[stepId], ...changes };
    });
    this.publish(id);
  }

  /** Runs every step not run yet, starting at index `from` (always run). */
  start(id, from = 0) {
    if (this.active.has(id)) throw new ApiError(409, 'Ce lancement est déjà en cours.');
    const promise = this.run(id, from)
      .catch((err) => log.error(`Lancement ${id} interrompu`, { error: err.message }))
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
    const index = STEPS.findIndex((s) => s.id === stepId);
    if (index < 0) throw new ApiError(404, 'Étape inconnue.');
    const integ = this.find(id);
    const blocking = STEPS.slice(0, index).find(
      (s) => s.essential && !FINISHED.includes(integ.steps[s.id]?.status) && stepEnabled(s, integ),
    );
    if (blocking) {
      throw new ApiError(409, `Il faut d’abord réussir l’étape « ${blocking.title} ».`);
    }
    return this.start(id, index);
  }

  async run(id, from) {
    for (let i = from; i < STEPS.length; i += 1) {
      const step = STEPS[i];
      let integ = this.find(id);
      if (i > from && integ.steps[step.id].status !== 'todo') continue;

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
          const { steps, ...fields } = draft;
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
        for (const step of Object.values(integ.steps ?? {})) {
          if (step.status === 'running') {
            step.status = 'error';
            step.message = 'Interrompue par un redémarrage de l’appli : relancez-la.';
          }
        }
      }
    });
  }
}
