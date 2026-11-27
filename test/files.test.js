import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTopLevel, splitTopLevel } from '../src/launch/json-edit.js';
import { buildFiles, raiseGladysVersion, renamePackage } from '../src/launch/files.js';
import { ciWithDispatch, claudeMdText, mdFenced, mdInline } from '../src/launch/texts.js';
import { TEMPLATE_FILES } from './fakes/github.js';

const INTEG = {
  owner: 'Alice',
  repoName: 'gladys-oral-b',
  displayName: 'Oral-B',
  description: {
    fr: 'Brosses à dents Oral-B : état, mode et durée du brossage.',
    en: 'Oral-B toothbrushes: status, mode and brushing time.',
    de: 'Oral-B Zahnbürsten: Status, Modus und Putzzeit.',
    es: 'Cepillos Oral-B: estado, modo y tiempo de cepillado.',
  },
  categories: ['services', 'appliances'],
  keywords: ['oral-b', 'toothbrush'],
  spec: 'Lire l’état des brosses en Bluetooth.\n```\ncode\n```',
  claude: true,
  maxTurns: 25,
};

test('splitTopLevel keeps the raw text of each member', () => {
  const members = splitTopLevel('{\n  "a": { "x": "}" },\n  "b": [1, 2],\n  "c": "s,\\"q"\n}\n');
  assert.deepEqual(members, [
    { key: 'a', raw: '{ "x": "}" }' },
    { key: 'b', raw: '[1, 2]' },
    { key: 'c', raw: '"s,\\"q"' },
  ]);
});

test('editTopLevel changes and inserts members, leaving the rest untouched', () => {
  const text = '{\n  "name": "x",\n  "categories": ["a"],\n  "inline": { "k": 1 }\n}\n';
  const out = editTopLevel(text, { name: 'y', keywords: ['k1', 'k2'] }, { keywords: 'categories' });
  assert.equal(out, '{\n  "name": "y",\n  "categories": ["a"],\n  "keywords": ["k1", "k2"],\n  "inline": { "k": 1 }\n}\n');
  const long = editTopLevel(text, { categories: Array.from({ length: 12 }, (_, i) => `category-${i}`) });
  assert.match(long, /"categories": \[\n    "category-0",\n/);
});

test('the manifest is personalized without touching config_schema or version', () => {
  const { files, manifest } = buildFiles(INTEG, TEMPLATE_FILES, 'main');
  const template = JSON.parse(TEMPLATE_FILES['gladys-assistant-integration.json']);
  assert.equal(manifest.name, 'Oral-B');
  assert.deepEqual(manifest.description, INTEG.description);
  assert.deepEqual(manifest.categories, ['services', 'appliances']);
  assert.deepEqual(manifest.keywords, ['oral-b', 'toothbrush']);
  assert.equal(manifest.docker_image, `ghcr.io/alice/gladys-oral-b:${template.version}`);
  assert.equal(manifest.cover_image, 'https://raw.githubusercontent.com/Alice/gladys-oral-b/main/cover.png');
  assert.equal(manifest.gladys_version, '>=5.3.0', 'keywords need Gladys 5.3.0');
  assert.equal(manifest.version, template.version);
  assert.deepEqual(manifest.config_schema, template.config_schema);
  assert.deepEqual(manifest.actions, template.actions);
  // Untouched members keep their exact original text.
  const raw = TEMPLATE_FILES['gladys-assistant-integration.json'];
  const configSchema = splitTopLevel(raw).find((m) => m.key === 'config_schema').raw;
  assert.ok(files['gladys-assistant-integration.json'].includes(configSchema));
});

test('without keywords, gladys_version is left alone', () => {
  const { manifest } = buildFiles({ ...INTEG, keywords: [] }, TEMPLATE_FILES, 'main');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.gladys_version, JSON.parse(TEMPLATE_FILES['gladys-assistant-integration.json']).gladys_version);
  assert.equal(raiseGladysVersion('>=5.4.0', '5.3.0'), '>=5.4.0');
  assert.equal(raiseGladysVersion('>=4.99.9', '5.3.0'), '>=5.3.0');
  assert.equal(raiseGladysVersion('^5.0.0', '5.3.0'), '^5.0.0');
});

test('package names, docs, changelog, CLAUDE.md and workflows', () => {
  const { files } = buildFiles(INTEG, TEMPLATE_FILES, 'main');
  assert.equal(JSON.parse(files['package.json']).name, 'gladys-oral-b');
  const lock = JSON.parse(files['package-lock.json']);
  assert.equal(lock.name, 'gladys-oral-b');
  assert.equal(lock.packages[''].name, 'gladys-oral-b');
  assert.equal(renamePackage('{"x":1}', 'n'), null);

  for (const lang of ['fr', 'en', 'de', 'es']) {
    const doc = files[`docs/${lang}.md`];
    assert.ok(doc.length >= 300, `docs/${lang}.md has ${doc.length} characters`);
    assert.ok(doc.includes(INTEG.description[lang]));
  }
  assert.match(files['CHANGELOG.md'], /^# Changelog/);
  assert.match(files['CHANGELOG.md'], /\n## \[Unreleased\]\n\n### Added\n\n- First version of the Oral-B/);
  assert.match(files['CHANGELOG.md'], /\[Unreleased\]: https:\/\/github.com\/Alice\/gladys-oral-b\/commits\/main\n$/);
  assert.ok(!files['CHANGELOG.md'].includes('Demo'), 'template entries are reset');

  assert.ok(files['CLAUDE.md'].startsWith(TEMPLATE_FILES['CLAUDE.md'].trimEnd()));
  assert.match(files['CLAUDE.md'], /## Objectif\n\nCette intégration s'appelle \*\*Oral-B\*\*/);
  assert.match(files['CLAUDE.md'], /````text\nLire l’état/, 'the spec is fenced, longer fence than its own');

  assert.match(files['.github/workflows/ci.yml'], /^on:\n  workflow_dispatch:\n/m);
  assert.match(files['.github/workflows/claude.yml'], /anthropics\/claude-code-action@v1/);
  assert.match(files['.github/workflows/claude.yml'], /claude_code_oauth_token: \$\{\{ secrets.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.match(files['.github/workflows/claude.yml'], /github_token: \$\{\{ secrets.GITHUB_TOKEN \}\}/);
  assert.match(files['.github/workflows/claude.yml'], /--max-turns 25/);
  assert.ok(!/ANTHROPIC_API_KEY/.test(Object.values(files).join('\n')), 'never an API key');
  assert.match(files['.github/workflows/store-check.yml'], /integration-store \. --skip-image-check/);

  const noClaude = buildFiles({ ...INTEG, claude: false }, TEMPLATE_FILES, 'main').files;
  assert.equal(noClaude['.github/workflows/claude.yml'], undefined);
  // Code files are never part of the commit.
  assert.ok(!Object.keys(files).some((p) => p.startsWith('src/') || p.startsWith('test/') || p === 'index.js'));
});

test('helpers keep Markdown safe and the Objectif section unique', () => {
  assert.equal(mdInline('  a *b*  [c] <d> `e` '), 'a \\*b\\* \\[c\\] \\<d\\> \\`e\\`');
  assert.equal(mdInline('- item'), '\\- item');
  assert.equal(mdInline('1. un'), '1\\. un');
  assert.equal(mdFenced('x  \r\ny'), '```text\nx\ny\n```');
  const once = claudeMdText('# CLAUDE.md\n\n## Rules\n\nr\n', { ...INTEG, spec: 'v1' });
  const twice = claudeMdText(once, { ...INTEG, spec: 'v2' });
  assert.equal(twice.match(/## Objectif/g).length, 1);
  assert.ok(twice.includes('v2') && !twice.includes('v1'));
  assert.ok(twice.includes('## Rules'));
  assert.equal(ciWithDispatch('on:\n  workflow_dispatch:\n'), null);
});
