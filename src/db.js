// -----------------------------------------------------------------------------
// Storage: one JSON file in DATA_DIR. Writes are serialized and atomic
// (temporary file + rename), the file is readable by the app user only.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EMPTY = () => ({
  version: 1,
  settings: {},
  secrets: {},
  reservations: [],
  integrations: [],
});

export class Db {
  constructor(dataDir) {
    this.file = join(dataDir, 'state.json');
    this.dataDir = dataDir;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.state = { ...EMPTY(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`Impossible de lire ${this.file} : ${err.message}`);
      }
      this.state = EMPTY();
    }
    return this;
  }

  /** Read-only view (deep copy) of the state. */
  read() {
    return structuredClone(this.state);
  }

  /** Applies `mutator(state)` and saves; calls are run one after the other. */
  update(mutator) {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await mutator(draft);
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.file);
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
