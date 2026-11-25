/**
 * zkteco-js rejects with `ZkError` objects shaped `{ err, ip, command }`.
 * They are not `Error` instances and are often nested several levels deep
 * (e.g. createSocket wraps the socket error twice). Template strings turn
 * them into "[object Object]", so always format unknown errors with errMsg().
 *
 * Also handles plain Errors, Node system errors (`code`), AggregateError
 * (e.g. "localhost" resolving to both ::1 and 127.0.0.1) and fetch errors,
 * whose real reason sits in `cause`.
 */
export function errMsg(e: unknown): string {
  const context: string[] = [];
  let cur: unknown = e;

  // Unwrap ZkError layers, collecting the command names for context.
  for (let depth = 0; depth < 10 && isZkErrorLike(cur); depth++) {
    const cmd = typeof cur.command === 'string' ? cur.command.trim() : '';
    if (cmd && !context.includes(cmd)) context.push(cmd);
    cur = cur.err;
  }

  const msg = describe(cur);
  return context.length ? `${msg} (during ${context.reverse().join(' > ')})` : msg;
}

function isZkErrorLike(v: unknown): v is { err: unknown; command?: unknown } {
  return typeof v === 'object' && v !== null && !(v instanceof Error) && 'err' in v;
}

function describe(e: unknown, depth = 0): string {
  if (e === null || e === undefined) return 'unknown error';
  if (typeof e === 'string') return e;
  if (typeof e !== 'object') return String(e);

  const o = e as { message?: unknown; code?: unknown; errors?: unknown; cause?: unknown; name?: unknown };
  let msg = typeof o.message === 'string' ? o.message : '';
  const code = typeof o.code === 'string' || typeof o.code === 'number' ? String(o.code) : '';

  // AggregateError from net.connect has an empty message; use the inner errors.
  if (!msg && Array.isArray(o.errors) && o.errors.length) {
    msg = o.errors.map((x) => describe(x, depth + 1)).join('; ');
  }
  if (!msg && typeof o.name === 'string') msg = o.name;
  if (code && !msg.includes(code)) msg = msg ? `${code}: ${msg}` : code;

  // fetch() throws "TypeError: fetch failed" and hides the useful part in `cause`.
  if (o.cause !== undefined && depth < 3) {
    const inner = isZkErrorLike(o.cause) ? errMsg(o.cause) : describe(o.cause, depth + 1);
    if (inner && !msg.includes(inner)) msg = msg ? `${msg}: ${inner}` : inner;
  }

  if (msg) return msg;
  try {
    return JSON.stringify(e);
  } catch {
    return 'unknown error';
  }
}
