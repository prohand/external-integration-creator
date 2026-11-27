// -----------------------------------------------------------------------------
// The personalization commit: every file written into the new repository.
// `config_schema`, `version` and the code are never touched (the template's
// test/manifest.test.js ties the manifest to the code).
// -----------------------------------------------------------------------------

import { editTopLevel } from './json-edit.js';
import {
  DOC_LANGS,
  actionVersions,
  changelogText,
  ciWithDispatch,
  claudeMdText,
  claudeWorkflow,
  docText,
  readmeText,
  storeCheckWorkflow,
} from './texts.js';

// Files read from the template (or the freshly generated repository).
export const SOURCE_FILES = [
  'gladys-assistant-integration.json',
  'package.json',
  'package-lock.json',
  'CHANGELOG.md',
  'CLAUDE.md',
  '.github/workflows/ci.yml',
];

// The store refuses `keywords` in a manifest that allows older cores.
export const KEYWORDS_MIN_GLADYS = '5.3.0';

/** ">=5.1.0" -> ">=5.3.0" when lower than `min` (other ranges left alone). */
export function raiseGladysVersion(range, min) {
  const match = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(String(range ?? ''));
  if (!match) return range;
  const current = match.slice(1).map(Number);
  const wanted = min.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (current[i] !== wanted[i]) return current[i] > wanted[i] ? range : `>=${min}`;
  }
  return range;
}

export function dockerImage(owner, repo, version) {
  return `ghcr.io/${owner}/${repo}:${version}`.toLowerCase();
}

export function coverImage(owner, repo, branch) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/cover.png`;
}

/** package.json / package-lock.json: only the package name changes. */
export function renamePackage(text, newName) {
  if (!text) return null;
  const current = JSON.parse(text).name;
  if (!current) return null;
  const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`("name":\\s*)"${escaped}"`, 'g'), `$1${JSON.stringify(newName)}`);
}

/**
 * @param {object} integ - { owner, repoName, displayName, description, categories, keywords, spec, claude, maxTurns }
 * @param {object} sources - template file contents, by path (null when missing)
 * @param {string} branch - default branch of the new repository
 * @returns {{ files: Record<string,string>, manifest: object }}
 */
export function buildFiles(integ, sources, branch) {
  const { owner, repoName } = integ;
  const repoUrl = `https://github.com/${owner}/${repoName}`;
  const files = {};

  // Manifest: name, descriptions, categories, keywords, image, cover.
  const manifestText = sources['gladys-assistant-integration.json'];
  if (!manifestText) throw new Error('gladys-assistant-integration.json introuvable dans le modèle.');
  const template = JSON.parse(manifestText);
  const image = dockerImage(owner, repoName, template.version);
  files['gladys-assistant-integration.json'] = editTopLevel(
    manifestText,
    {
      name: integ.displayName,
      description: Object.fromEntries(['en', 'fr', 'de', 'es'].map((l) => [l, integ.description[l]])),
      docker_image: image,
      cover_image: coverImage(owner, repoName, branch),
      categories: integ.categories,
      ...(integ.keywords.length
        ? {
            keywords: integ.keywords,
            gladys_version: raiseGladysVersion(template.gladys_version, KEYWORDS_MIN_GLADYS),
          }
        : {}),
    },
    { keywords: 'categories' },
  );

  const packageName = repoName.toLowerCase();
  for (const path of ['package.json', 'package-lock.json']) {
    const renamed = renamePackage(sources[path], packageName);
    if (renamed) files[path] = renamed;
  }

  files['README.md'] = readmeText({ ...integ, repoUrl, image, owner, repo: repoName });
  for (const lang of DOC_LANGS) {
    files[`docs/${lang}.md`] = docText(lang, { ...integ, repoUrl });
  }
  files['CHANGELOG.md'] = changelogText(sources['CHANGELOG.md'], { ...integ, repoUrl, branch });
  files['CLAUDE.md'] = claudeMdText(sources['CLAUDE.md'], integ);

  const ci = sources['.github/workflows/ci.yml'];
  const versions = actionVersions(ci);
  const ciDispatch = ciWithDispatch(ci);
  if (ciDispatch) files['.github/workflows/ci.yml'] = ciDispatch;
  files['.github/workflows/store-check.yml'] = storeCheckWorkflow(versions);
  if (integ.claude) {
    files['.github/workflows/claude.yml'] = claudeWorkflow({ ...versions, maxTurns: integ.maxTurns });
  }

  return { files, manifest: JSON.parse(files['gladys-assistant-integration.json']) };
}
