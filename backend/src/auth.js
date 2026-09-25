import { HttpError, fetchJson } from './util.js';

let certCache = { domain: null, keys: null, at: 0 };

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function accessKeys(domain, forceReload) {
  if (!forceReload && certCache.domain === domain && certCache.keys && Date.now() - certCache.at < 60 * 60 * 1000) {
    return certCache.keys;
  }
  const body = await fetchJson(`https://${domain}/cdn-cgi/access/certs`, {}, 'Cloudflare Access');
  certCache = { domain, keys: body.keys || [], at: Date.now() };
  return certCache.keys;
}

// Verify the login token Cloudflare Access attaches to every request; returns the signed-in email.
export async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');

  let keys = await accessKeys(env.ACCESS_TEAM_DOMAIN, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await accessKeys(env.ACCESS_TEAM_DOMAIN, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('expired');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw new Error('not yet valid');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new Error('wrong audience');
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new Error('wrong issuer');
  if (!payload.email) throw new Error('no email in token');
  return String(payload.email).toLowerCase();
}

function cookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function isLocal(request) {
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

// ---------- app login: email + access code, then a long-lived session cookie ----------

export const SESSION_COOKIE = 'cj_session';
const SESSION_DAYS = 90;
// Per email: stops guessing one person's code. Per network: higher, since a crew often shares one Wi-Fi.
const MAX_ATTEMPTS_EMAIL = 8;
const MAX_ATTEMPTS_IP = 30;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
// No 0/O or 1/I/L, so codes are easy to read aloud and type on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// 15 random characters (about 74 bits), shown as XXXXX-XXXXX-XXXXX.
export function newAccessCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10)}`;
}

// Codes are random and long, so a salted SHA-256 is enough and stays inside the free plan's CPU budget.
export async function hashAccessCode(code, salt) {
  return sha256Hex(`${salt}:${normalizeCode(code)}`);
}

export async function setAccessCode(env, email) {
  const code = newAccessCode();
  const salt = randomToken(12);
  const hash = await hashAccessCode(code, salt);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET code_hash = ?2, code_salt = ?3 WHERE email = ?1').bind(email, hash, salt),
    env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(email),
  ]);
  return code;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function tooManyAttempts(env, keys, now) {
  const { results } = await env.DB.prepare(
    `SELECT key, count, window_start FROM login_attempts WHERE key IN (${keys.map(() => '?').join(',')})`,
  ).bind(...keys).all();
  return results.some(
    (r) => now - r.window_start < ATTEMPT_WINDOW_MS && r.count >= (r.key.startsWith('ip:') ? MAX_ATTEMPTS_IP : MAX_ATTEMPTS_EMAIL),
  );
}

async function recordFailure(env, keys, now) {
  await env.DB.batch(
    keys.map((k) =>
      env.DB.prepare(
        `INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
      ).bind(k, now, ATTEMPT_WINDOW_MS),
    ),
  );
}

export async function login(env, request, email, code) {
  const now = Date.now();
  const keys = [`ip:${clientIp(request)}`, `email:${email}`];
  if (await tooManyAttempts(env, keys, now)) {
    throw new HttpError(429, 'Too many wrong tries. Wait 15 minutes and try again.');
  }
  const user = await env.DB.prepare('SELECT email, role, name, code_hash, code_salt FROM users WHERE email = ?').bind(email).first();
  const ok = user && user.code_hash && sameString(await hashAccessCode(code, user.code_salt), user.code_hash);
  if (!ok) {
    await recordFailure(env, keys, now);
    throw new HttpError(401, 'That email and access code do not match.');
  }
  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(
      await sha256Hex(token), email, now, now + SESSION_DAYS * 86400 * 1000,
    ),
    env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(`email:${email}`),
  ]);
  return {
    user: { email: user.email, role: user.role, name: user.name },
    cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  };
}

export async function logout(env, request) {
  const token = cookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function sessionEmail(env, request) {
  const token = cookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare('SELECT email, expires_at FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).first();
  if (!row || row.expires_at < Date.now()) return null;
  return row.email;
}

export async function currentUser(request, env) {
  let email = await sessionEmail(env, request);
  if (!email && env.DEV_MODE === 'true') {
    // Local testing only; refused anywhere but localhost so it can never open the live app.
    if (!isLocal(request)) throw new HttpError(500, 'DEV_MODE must not be enabled on the live app');
    email = (request.headers.get('x-dev-user') || '').toLowerCase() || null;
  }
  if (!email && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
    if (token) {
      try {
        email = await verifyAccessJwt(token, env);
      } catch {
        email = null;
      }
    }
  }
  if (!email) throw new HttpError(401, 'Sign in required');
  const user = await env.DB.prepare('SELECT email, role, name FROM users WHERE email = ?').bind(email).first();
  if (!user) throw new HttpError(403, `${email} is not on the team list. Ask the owner to add you.`);
  return user;
}
