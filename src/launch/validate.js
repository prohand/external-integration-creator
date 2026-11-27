// -----------------------------------------------------------------------------
// Validation of the launch form (same rules as the store validator).
// -----------------------------------------------------------------------------

import { STORE_CATEGORY_KEYS } from '../categories.js';
import { isValidRepoName } from '../names.js';
import { ApiError } from '../web.js';
import { OPTIONS } from './steps.js';

export const LANGS = ['fr', 'en', 'de', 'es'];
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 100;

export function parseKeywords(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map((k) => String(k).replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

/** Returns a clean launch request, or throws ApiError(400) listing every problem. */
export function validateLaunch(body) {
  const errors = {};
  const displayName = String(body.displayName ?? '').replace(/\s+/g, ' ').trim();
  if (displayName.length < 2 || displayName.length > 60) errors.displayName = 'De 2 à 60 caractères.';

  const repoName = String(body.repoName ?? '').trim();
  if (!isValidRepoName(repoName)) {
    errors.repoName = 'Lettres, chiffres, points, tirets et soulignés seulement (100 caractères au plus).';
  }

  const description = {};
  for (const lang of LANGS) {
    const text = String(body.description?.[lang] ?? '').replace(/\s+/g, ' ').trim();
    description[lang] = text;
    if (text.length < DESCRIPTION_MIN || text.length > DESCRIPTION_MAX) {
      errors[`description.${lang}`] = `De ${DESCRIPTION_MIN} à ${DESCRIPTION_MAX} caractères (actuellement ${text.length}).`;
    }
  }

  const categories = [...new Set(Array.isArray(body.categories) ? body.categories : [])];
  if (categories.length < 1 || categories.length > 3 || categories.some((c) => !STORE_CATEGORY_KEYS.includes(c))) {
    errors.categories = 'Choisissez de 1 à 3 catégories.';
  }

  const keywords = parseKeywords(body.keywords);
  if (keywords.length > 10 || keywords.some((k) => k.length < 2 || k.length > 40)) {
    errors.keywords = '10 mots-clés au plus, de 2 à 40 caractères chacun.';
  }

  const spec = String(body.spec ?? '').replace(/\r\n?/g, '\n');
  if (spec.length > 20_000) errors.spec = '20 000 caractères au plus.';

  const actions = {};
  for (const { key } of OPTIONS) actions[key] = body.actions?.[key] !== false;

  const ideaKey = body.ideaKey ? String(body.ideaKey).slice(0, 120) : null;

  if (Object.keys(errors).length) {
    throw new ApiError(400, 'Le formulaire contient des erreurs.', errors);
  }
  return {
    ideaKey,
    displayName,
    repoName,
    description,
    categories,
    keywords,
    spec,
    actions,
    simulate: body.simulate === true,
    autoFilled: body.autoFilled === true,
  };
}
