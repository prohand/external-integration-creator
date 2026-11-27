// Fake community tracker serving the CSV fixtures (overridable per test).

import { readFileSync } from 'node:fs';
import { startFake } from './server.js';

export const FIXTURES = {
  'liste-ha-gladys.csv': readFileSync(new URL('../fixtures/liste-ha-gladys.csv', import.meta.url), 'utf8'),
  'integrations-gladys.csv': readFileSync(new URL('../fixtures/integrations-gladys.csv', import.meta.url), 'utf8'),
};

export async function startFakeTracker(files = {}) {
  const content = { ...FIXTURES, ...files };
  const fake = await startFake(({ path }) => {
    const name = path.split('/').pop();
    return content[name] !== undefined ? { body: content[name], headers: { 'content-type': 'text/csv; charset=utf-8' } } : undefined;
  });
  fake.content = content;
  return fake;
}
