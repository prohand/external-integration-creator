// -----------------------------------------------------------------------------
// One-click launch: every field of the launch form filled from the tracker
// idea. Claude writes the real fr/de/es descriptions afterwards (asked in
// the tracking issue and in CLAUDE.md).
// -----------------------------------------------------------------------------

import { defaultRepoName } from '../names.js';

/** "A long sentence…" cut at a word boundary to fit `max` characters. */
export function shorten(text, max = 100) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** Generic but valid store descriptions (10 to 100 characters). */
export function genericDescriptions(name) {
  const n = shorten(name, 60);
  return {
    fr: `Intégration ${n} pour Gladys Assistant.`,
    en: `${n} integration for Gladys Assistant.`,
    de: `${n}-Integration für Gladys Assistant.`,
    es: `Integración de ${n} para Gladys Assistant.`,
  };
}

export function autoSpec(idea) {
  const lines = [
    `Reproduire dans Gladys l'intégration Home Assistant « ${idea.name} ».`,
    idea.description ? `Ce qu'elle fait : ${idea.description}` : null,
    idea.docUrl ? `Documentation Home Assistant : ${idea.docUrl}` : null,
    idea.access ? `Accès : ${idea.access}.` : null,
    '',
    'Commencer par les fonctions principales, en local quand c’est possible, avec des tests.',
    'Rédiger aussi de vraies descriptions fr, de et es dans le manifeste (10 à 100 caractères) : celles du lancement sont génériques.',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/** Launch request built from a tracker idea (same shape as the form). */
export function autofillFromIdea(idea) {
  const generic = genericDescriptions(idea.name);
  const en = shorten(idea.description, 100);
  return {
    ideaKey: idea.key,
    displayName: shorten(idea.name, 60),
    repoName: defaultRepoName(idea.name),
    description: { ...generic, ...(en.length >= 10 ? { en } : {}) },
    categories: idea.categories?.length ? idea.categories : ['services'],
    keywords: [],
    spec: autoSpec(idea),
    autoFilled: true,
  };
}
