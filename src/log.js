// -----------------------------------------------------------------------------
// Minimal logger. Secrets never reach the output: every registered secret value
// is masked, and fields whose name looks like a credential are dropped.
// -----------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(token|password|secret|api[-_]?key|authorization|cookie)/i;

const secretValues = new Set();
let minLevel = LEVELS.info;

export function setLogLevel(level) {
  minLevel = LEVELS[level] ?? LEVELS.info;
}

/** Registers a value that must never appear in the logs. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) {
    secretValues.add(value);
  }
}

export function redact(value, depth = 0) {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secretValues) {
      out = out.split(secret).join('***');
    }
    // Tokens that look like GitHub / OAuth credentials, even if not registered.
    return out.replace(/\b(gh[pousr]_|github_pat_|sk-ant-)[A-Za-z0-9_-]{8,}/g, '$1***');
  }
  if (value instanceof Error) {
    return redact(value.message, depth);
  }
  if (Array.isArray(value)) {
    return depth > 4 ? '[…]' : value.map((v) => redact(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth > 4) return '[…]';
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level, message, data) {
  if (LEVELS[level] < minLevel) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(message)}`;
  const extra = data === undefined ? '' : ` ${JSON.stringify(redact(data))}`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(
    `${line}${extra}\n`,
  );
}

export const log = {
  debug: (msg, data) => write('debug', msg, data),
  info: (msg, data) => write('info', msg, data),
  warn: (msg, data) => write('warn', msg, data),
  error: (msg, data) => write('error', msg, data),
};
