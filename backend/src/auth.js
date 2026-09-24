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

export async function currentUser(request, env) {
  let email;
  if (env.DEV_MODE === 'true') {
    // Local testing only; refused anywhere but localhost so it can never open the live app.
    if (!isLocal(request)) throw new HttpError(500, 'DEV_MODE must not be enabled on the live app');
    email = (request.headers.get('x-dev-user') || env.DEV_USER_EMAIL || '').toLowerCase();
  } else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(503, 'Login is not set up yet');
    const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
    if (!token) throw new HttpError(401, 'Sign in required');
    try {
      email = await verifyAccessJwt(token, env);
    } catch {
      throw new HttpError(401, 'Your sign-in expired. Reload the app to sign in again.');
    }
  }
  if (!email) throw new HttpError(401, 'Sign in required');
  const user = await env.DB.prepare('SELECT email, role, name FROM users WHERE email = ?').bind(email).first();
  if (!user) throw new HttpError(403, `${email} is not on the team list. Ask the owner to add you.`);
  return user;
}
