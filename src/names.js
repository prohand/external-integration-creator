// -----------------------------------------------------------------------------
// Name helpers: comparison keys (lowercase, no accents, no punctuation) and
// repository slugs.
// -----------------------------------------------------------------------------

/** Lowercase, accent-free, alphanumeric-only key: "Météo-France" -> "meteofrance". */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Words that do not identify an integration ("gladys-airplay" == "AirPlay").
const NOISE_WORDS = new Set(['gladys', 'assistant', 'integration', 'integrations', 'plugin', 'service']);

function words(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Comparison keys of a name: the full key, plus the key without the noise
 * words (so "gladys-google-cast" matches "Google Cast").
 */
export function nameKeys(value) {
  const keys = new Set();
  const full = normalizeName(value);
  if (full) keys.add(full);
  const meaningful = words(value).filter((w) => !NOISE_WORDS.has(w)).join('');
  if (meaningful) keys.add(meaningful);
  return [...keys];
}

/** True when two names (or any of their keywords) designate the same thing. */
export function namesMatch(a, b) {
  const keysA = new Set(nameKeys(a));
  return nameKeys(b).some((key) => keysA.has(key));
}

/** Repository slug: "Météo France (Vigilance)" -> "meteo-france-vigilance". */
export function slugify(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** Default repository name for an integration: "gladys-" + slug. */
export function defaultRepoName(displayName) {
  const slug = slugify(displayName).replace(/^gladys-/, '');
  return slug ? `gladys-${slug}` : 'gladys-';
}

/** GitHub repository name rules (simplified, conservative). */
export function isValidRepoName(name) {
  return (
    typeof name === 'string' &&
    name.length >= 1 &&
    name.length <= 100 &&
    /^[A-Za-z0-9._-]+$/.test(name) &&
    !/^\.+$/.test(name) &&
    !name.endsWith('.git')
  );
}
