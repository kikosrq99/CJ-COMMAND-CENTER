export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

// YYYY-MM-DD for the given instant in a named time zone.
export function ymdInTz(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Fetch JSON, turning upstream failures into readable errors that never include credentials.
export async function fetchJson(url, init, label) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`${label} could not be reached`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body && body.error && (body.error.message || body.error.error_user_msg)) || (body && body.message) || text.slice(0, 200);
    throw new Error(`${label} ${res.status}: ${msg}`);
  }
  if (body === null) throw new Error(`${label} returned a response that was not JSON`);
  return body;
}

export async function readJsonBody(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Send JSON');
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

export function newId(prefix) {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  return prefix + Date.now().toString(36) + Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
}
