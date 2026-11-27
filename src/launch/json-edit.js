// -----------------------------------------------------------------------------
// Edits the top-level members of a JSON document while keeping the original
// layout of every untouched member, so the result stays Prettier-clean (the
// template CI runs `prettier --check`, JSON included).
// -----------------------------------------------------------------------------

const PRINT_WIDTH = 100;

/** Splits `{ "a": ..., "b": ... }` into [{ key, raw }] (raw = original value text). */
export function splitTopLevel(text) {
  const members = [];
  let i = text.indexOf('{');
  if (i < 0) throw new Error('Not a JSON object');
  i += 1;

  const skipWs = () => {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
  };
  const readString = () => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i));
  };

  for (;;) {
    skipWs();
    if (text[i] === '}') break;
    if (text[i] !== '"') throw new Error(`Unexpected character at ${i}`);
    const key = readString();
    while (/[\s:]/.test(text[i])) i += 1;
    const start = i;
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        readString();
        continue;
      }
      if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ',' && depth === 0) break;
      i += 1;
    }
    members.push({ key, raw: text.slice(start, i).trimEnd() });
  }
  return members;
}

/** Prettier-like rendering of a value at one level of indentation. */
export function formatValue(key, value, indent = '  ') {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    const inline = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    if (`${indent}"${key}": ${inline},`.length <= PRINT_WIDTH) return inline;
    return `[\n${value.map((v) => `${indent}  ${JSON.stringify(v)}`).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Kept expanded: Prettier preserves an object broken after its "{".
    const lines = Object.entries(value).map(
      ([k, v]) => `${indent}  ${JSON.stringify(k)}: ${formatValue(k, v, `${indent}  `)}`,
    );
    return lines.length ? `{\n${lines.join(',\n')}\n${indent}}` : '{}';
  }
  return JSON.stringify(value);
}

/**
 * Applies `changes` ({ key: value }) to the top-level members of `text`.
 * New keys are inserted after the key named in `insertAfter[key]`, or at the end.
 */
export function editTopLevel(text, changes, insertAfter = {}) {
  JSON.parse(text); // fail early on invalid input
  const members = splitTopLevel(text);
  for (const [key, value] of Object.entries(changes)) {
    const raw = formatValue(key, value);
    const existing = members.find((m) => m.key === key);
    if (existing) {
      existing.raw = raw;
    } else {
      const after = members.findIndex((m) => m.key === insertAfter[key]);
      members.splice(after >= 0 ? after + 1 : members.length, 0, { key, raw });
    }
  }
  const body = members.map((m) => `  ${JSON.stringify(m.key)}: ${m.raw}`).join(',\n');
  const out = `{\n${body}\n}\n`;
  JSON.parse(out); // never write a broken manifest
  return out;
}
