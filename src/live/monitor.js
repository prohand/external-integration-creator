// -----------------------------------------------------------------------------
// Polls GitHub every 20 s for the integrations whose "Développement" page is
// open (SSE channel "dev:<id>"), and pushes the changes. Nothing runs when no
// page is open.
// -----------------------------------------------------------------------------

import { log } from '../log.js';
import { devSnapshot, ensureBranchCi } from './dev.js';

export const DEV_POLL_MS = 20_000;
export const devChannel = (id) => `dev:${id}`;

export class DevMonitor {
  constructor({ hub, findInteg, gh, intervalMs = DEV_POLL_MS }) {
    this.hub = hub;
    this.findInteg = findInteg;
    this.gh = gh;
    this.intervalMs = intervalMs;
    this.timers = new Map(); // id -> interval
    this.last = new Map(); // id -> { snap, key }
    this.memo = new Map(); // id -> per-integration memory
    this.running = new Map(); // id -> pending poll
    hub.onChange((channel, count) => {
      if (!channel.startsWith('dev:')) return;
      const id = channel.slice(4);
      if (count > 0) this.watch(id);
      else this.unwatch(id);
    });
  }

  watch(id) {
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setInterval(() => this.poll(id), this.intervalMs),
    );
    this.poll(id);
  }

  unwatch(id) {
    clearInterval(this.timers.get(id));
    this.timers.delete(id);
  }

  stopAll() {
    for (const id of [...this.timers.keys()]) this.unwatch(id);
  }

  /** Polls now (one poll at a time per integration). */
  poll(id) {
    if (this.running.has(id)) return this.running.get(id);
    const promise = this.#poll(id).finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return promise;
  }

  async #poll(id) {
    const integ = this.findInteg(id);
    if (!integ) return null;
    let snap;
    try {
      if (integ.simulate) {
        snap = { updatedAt: new Date().toISOString(), simulated: true, alerts: [], activity: [] };
      } else {
        if (!this.memo.has(id)) this.memo.set(id, {});
        const memo = this.memo.get(id);
        snap = await devSnapshot(this.gh, integ, memo);
        if (await ensureBranchCi(this.gh, integ, snap, memo)) {
          snap.ci = { ...snap.ci, status: 'requested' };
          snap.activity.unshift({
            t: new Date().toISOString(),
            kind: 'ci',
            text: `CI lancée sur ${snap.branch} (${snap.ci.headSha.slice(0, 7)})`,
            url: null,
          });
        }
      }
    } catch (err) {
      log.warn(`Suivi du développement ${id} : ${err.message}`);
      this.hub.publish(devChannel(id), 'dev-error', { message: err.message, at: new Date().toISOString() });
      return this.last.get(id)?.snap ?? null;
    }
    const { updatedAt, ...rest } = snap;
    const key = JSON.stringify(rest);
    if (this.last.get(id)?.key !== key) {
      this.last.set(id, { snap, key });
      this.hub.publish(devChannel(id), 'dev', snap);
    } else {
      this.last.get(id).snap.updatedAt = updatedAt;
      this.hub.publish(devChannel(id), 'dev-ping', { updatedAt });
    }
    return snap;
  }

  /** Last snapshot, or a fresh one. */
  async latest(id) {
    return this.last.get(id)?.snap ?? this.poll(id);
  }

  /** After an action (message, PR…), look again a few seconds later. */
  soon(id, ms = 4000) {
    setTimeout(() => this.poll(id), ms).unref?.();
  }
}
