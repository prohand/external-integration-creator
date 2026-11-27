// -----------------------------------------------------------------------------
// Texts written into the new repository (docs, README, CHANGELOG, CLAUDE.md,
// workflows) and posted on GitHub / the forum. Markdown and YAML stay
// Prettier-clean: the template CI runs `prettier --check` on them.
// -----------------------------------------------------------------------------

/** One-line user text made safe for a Markdown paragraph. */
export function mdInline(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .replace(/^([#>+-])(?=\s|$)/, '\\$1')
    .replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2');
}

/** Free text in a fenced block: kept verbatim, whatever it contains. */
export function mdFenced(value, info = 'text') {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '');
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${info}\n${text}\n${fence}`;
}

const FORUM = 'https://community.gladysassistant.com';

// --- user documentation (docs/<lang>.md, 300 characters minimum each) --------

const DOCS = {
  fr: (n, d, repo) => `# ${n}

${d}

## Installation

1. Dans Gladys, ouvrez **Intégrations**, puis le store des intégrations externes.
2. Cherchez **${n}** et cliquez sur **Installer**.
3. Attendez que le conteneur démarre : l'intégration apparaît dans la liste.

## Configuration

Ouvrez l'onglet **Configuration** de l'intégration et remplissez les champs demandés. Chaque champ est expliqué directement à l'écran. Enregistrez : l'intégration se connecte et affiche son état.

## Utilisation

Les appareils trouvés par l'intégration apparaissent dans Gladys. Vous pouvez les ajouter à vos tableaux de bord et les utiliser dans vos scènes.

## Aide

Une question ou un problème ? Posez-la sur le [forum de la communauté Gladys](${FORUM}) ou ouvrez une issue sur le [dépôt GitHub](${repo}/issues).
`,
  en: (n, d, repo) => `# ${n}

${d}

## Installation

1. In Gladys, open **Integrations**, then the external integrations store.
2. Search for **${n}** and click **Install**.
3. Wait for the container to start: the integration shows up in the list.

## Configuration

Open the **Configuration** tab of the integration and fill in the requested fields. Each field is explained on the screen. Save: the integration connects and shows its status.

## Usage

The devices found by the integration show up in Gladys. You can add them to your dashboards and use them in your scenes.

## Help

A question or a problem? Ask on the [Gladys community forum](${FORUM}) or open an issue on the [GitHub repository](${repo}/issues).
`,
  de: (n, d, repo) => `# ${n}

${d}

## Installation

1. Öffnen Sie in Gladys **Integrationen** und dann den Store für externe Integrationen.
2. Suchen Sie **${n}** und klicken Sie auf **Installieren**.
3. Warten Sie, bis der Container gestartet ist: Die Integration erscheint in der Liste.

## Konfiguration

Öffnen Sie den Reiter **Konfiguration** der Integration und füllen Sie die angeforderten Felder aus. Jedes Feld wird direkt auf dem Bildschirm erklärt. Speichern Sie: Die Integration verbindet sich und zeigt ihren Status an.

## Verwendung

Die von der Integration gefundenen Geräte erscheinen in Gladys. Sie können sie zu Ihren Dashboards hinzufügen und in Ihren Szenen verwenden.

## Hilfe

Eine Frage oder ein Problem? Fragen Sie im [Forum der Gladys-Community](${FORUM}) oder eröffnen Sie ein Issue im [GitHub-Repository](${repo}/issues).
`,
  es: (n, d, repo) => `# ${n}

${d}

## Instalación

1. En Gladys, abra **Integraciones** y luego la tienda de integraciones externas.
2. Busque **${n}** y haga clic en **Instalar**.
3. Espere a que el contenedor arranque: la integración aparece en la lista.

## Configuración

Abra la pestaña **Configuración** de la integración y rellene los campos solicitados. Cada campo se explica directamente en la pantalla. Guarde: la integración se conecta y muestra su estado.

## Uso

Los dispositivos encontrados por la integración aparecen en Gladys. Puede añadirlos a sus paneles y usarlos en sus escenas.

## Ayuda

¿Una pregunta o un problema? Pregunte en el [foro de la comunidad Gladys](${FORUM}) o abra un issue en el [repositorio de GitHub](${repo}/issues).
`,
};

export const DOC_LANGS = ['fr', 'en', 'de', 'es'];

export function docText(lang, { displayName, description, repoUrl }) {
  return DOCS[lang](mdInline(displayName), mdInline(description[lang]), repoUrl);
}

// --- README / CHANGELOG / CLAUDE.md ------------------------------------------

export function readmeText({ displayName, description, repoUrl, image, owner, repo }) {
  const n = mdInline(displayName);
  return `# ${n}

${mdInline(description.en)}

_${mdInline(description.fr)}_

An external integration for [Gladys Assistant](https://gladysassistant.com), built on the [official JavaScript template](https://github.com/GladysAssistant/integration-template-js).

> Status: in development. Follow the progress in the [issues](${repoUrl}/issues).

## Install

From Gladys: **Integrations** → external integrations store → **${n}** → **Install**.

User documentation: [English](docs/en.md) · [Français](docs/fr.md) · [Deutsch](docs/de.md) · [Español](docs/es.md).

## Develop

\`\`\`bash
npm install
npm test
npm run lint
npm run format:check
\`\`\`

Open in a codespace: https://codespaces.new/${owner}/${repo}

The Docker image is published by the **Release** workflow as \`${image}\`. The template documentation (SDK, manifest, release process) is in the [template README](https://github.com/GladysAssistant/integration-template-js#readme).

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
`;
}

/** Keeps the template intro, starts a fresh `## [Unreleased]` section. */
export function changelogText(templateChangelog, { displayName, repoUrl, branch }) {
  const intro = String(templateChangelog ?? '').split(/^## /m)[0].trim() || '# Changelog';
  return `${intro}

## [Unreleased]

### Added

- First version of the ${mdInline(displayName)} integration, created from the Gladys JavaScript template.

[Unreleased]: ${repoUrl}/commits/${branch}
`;
}

export function claudeObjectiveSection({ displayName, description, spec }) {
  const specBlock = String(spec ?? '').trim()
    ? mdFenced(spec)
    : '_Pas de cahier des charges détaillé : partir de la description._';
  return `## Objectif

Cette intégration s'appelle **${mdInline(displayName)}**. ${mdInline(description.fr)}

Cahier des charges écrit au lancement du projet :

${specBlock}

Règles pour ce projet :

- Garder la structure du template : \`index.js\`, \`src/\`, \`test/\`.
- Mettre à jour \`gladys-assistant-integration.json\` en même temps que le code : \`test/manifest.test.js\` vérifie que les deux restent cohérents.
- Ne pas modifier \`version\` ni \`docker_image\` : le workflow Release s'en charge.
- Tenir à jour \`docs/fr.md\`, \`docs/en.md\`, \`docs/de.md\` et \`docs/es.md\` (300 caractères minimum chacune) et la section \`## [Unreleased]\` de \`CHANGELOG.md\`.
- Avant chaque push : \`npm run format\`, \`npm run lint\` et \`npm test\`.
- Travailler sur une branche et ouvrir une pull request ; ne jamais pousser sur la branche principale.
`;
}

/** Appends (or replaces) the "## Objectif" section of CLAUDE.md. */
export function claudeMdText(templateClaudeMd, info) {
  const base = String(templateClaudeMd ?? '# CLAUDE.md\n').replace(/\n## Objectif\n[\s\S]*?(?=\n## |$)/, '\n');
  return `${base.trimEnd()}\n\n${claudeObjectiveSection(info)}`;
}

// --- workflows -----------------------------------------------------------------

export function claudeWorkflow({ maxTurns, checkout, setupNode }) {
  return `# -----------------------------------------------------------------------------
# Claude Code answers "@claude" in issues, comments and pull request reviews.
#
# It runs on the Claude subscription (Pro or Max) of the repository owner:
# secret CLAUDE_CODE_OAUTH_TOKEN, created with \`claude setup-token\`. No API key.
# Only the owner, members and collaborators can start it. --max-turns limits
# each run, to spare the subscription limits.
# -----------------------------------------------------------------------------
name: Claude

on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

concurrency:
  group: claude-\${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  claude:
    if: >-
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association || github.event.review.author_association || github.event.issue.author_association) &&
      contains(github.event.comment.body || github.event.review.body || github.event.issue.body, '@claude')
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      contents: write
      issues: write
      pull-requests: write
      actions: read
    steps:
      - name: Checkout
        uses: ${checkout}
        with:
          fetch-depth: 1

      - name: Set up Node.js
        uses: ${setupNode}
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Claude Code
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          github_token: \${{ secrets.GITHUB_TOKEN }}
          additional_permissions: |
            actions: read
          claude_args: >-
            --max-turns ${maxTurns}
            --allowedTools "Bash(npm ci),Bash(npm install *),Bash(npm test),Bash(npm run *),Bash(node --test *),Bash(npx --yes github:GladysAssistant/integration-store *)"
`;
}

export function storeCheckWorkflow({ checkout, setupNode }) {
  return `# -----------------------------------------------------------------------------
# Gladys store admission checks, started by External Integration Creator before a
# release (the image check is skipped: the image does not exist yet).
# -----------------------------------------------------------------------------
name: Store check

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  store-check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: ${checkout}
        with:
          persist-credentials: false

      - name: Set up Node.js
        uses: ${setupNode}
        with:
          node-version: 24

      - name: Store admission checks
        run: npx --yes github:GladysAssistant/integration-store . --skip-image-check
`;
}

/** Adds `workflow_dispatch:` to the template CI so the app can start it. */
export function ciWithDispatch(ciYaml) {
  const text = String(ciYaml ?? '');
  if (!text || /^\s+workflow_dispatch:/m.test(text)) return null;
  if (!/^on:\s*$/m.test(text)) return null;
  return text.replace(/^on:\s*\n/m, 'on:\n  workflow_dispatch:\n');
}

/** Action versions used by the template (kept in step with Dependabot there). */
export function actionVersions(ciYaml) {
  const find = (name, fallback) =>
    new RegExp(`uses:\\s*(${name}@[\\w.-]+)`).exec(String(ciYaml ?? ''))?.[1] ?? fallback;
  return {
    checkout: find('actions/checkout', 'actions/checkout@v4'),
    setupNode: find('actions/setup-node', 'actions/setup-node@v4'),
  };
}

// --- tracking issue / forum topic ----------------------------------------------

export const ISSUE_CHECKLIST = [
  'Code de l’intégration (appareils, configuration)',
  'Tests à jour (`npm test`)',
  '`npm run lint` et `npm run format:check` passent',
  'Documentation `docs/fr.md`, `docs/en.md`, `docs/de.md`, `docs/es.md`',
  'Image de couverture `cover.png`',
  '`CHANGELOG.md` à jour',
  'Pull request fusionnée',
  'Contrôle du store OK',
  'Release publiée et image ghcr publique',
  'Topic `gladys-assistant-integration` ajouté',
  'Intégration visible dans le store',
];

export function issueTitle(displayName) {
  return `Développement de l'intégration ${displayName}`;
}

export function issueBody({ displayName, description, spec, claude, autoFilled }) {
  const checklist = autoFilled
    ? ['Descriptions fr, de et es rédigées dans le manifeste (10 à 100 caractères)', ...ISSUE_CHECKLIST]
    : ISSUE_CHECKLIST;
  const intro = claude
    ? "@claude Développe cette intégration Gladys en suivant le cahier des charges ci-dessous et les règles de `CLAUDE.md`. Travaille sur une branche, ouvre une pull request quand les tests passent, et coche la check-list au fur et à mesure.\n\n"
    : '';
  return `${intro}## Intégration

**${mdInline(displayName)}** : ${mdInline(description.fr)}

## Cahier des charges

${String(spec ?? '').trim() || '_Pas de cahier des charges détaillé._'}

## Check-list jusqu'à la publication

${checklist.map((item) => `- [ ] ${item}`).join('\n')}

---
_Issue créée par External Integration Creator._
`;
}

/**
 * "Je prends :" message, posted in batch in the community topic, like the
 * other contributors do. One line per integration.
 */
export function reserveBatchMessage(items) {
  const lines = items.map((i) => `- ${mdInline(i.displayName)} : ${mdInline(i.description.fr)}`);
  return `Je prends :\n\n${lines.join('\n')}\n`;
}
