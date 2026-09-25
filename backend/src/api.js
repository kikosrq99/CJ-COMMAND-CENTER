import { currentUser, login, logout, setAccessCode } from './auth.js';
import { readSnapshots, refreshAll, SOURCES } from './refresh.js';
import { HttpError, json, newId, readJsonBody } from './util.js';

const STAGES = ['contacted', 'qualified', 'won', 'lost'];
const REFRESH_COOLDOWN_MS = 60 * 1000;

// ---------- validation ----------

function text(body, key, max, { required = false, fallback = '' } = {}) {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `${key} is required`);
    return fallback;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be text`);
  const t = v.trim();
  if (required && !t) throw new HttpError(400, `${key} is required`);
  if (t.length > max) throw new HttpError(400, `${key} must be ${max} characters or fewer`);
  return t;
}

function money(body, key, { nullable = false } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (nullable) return null;
    return 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new HttpError(400, `${key} must be a number from 0 to 10,000,000`);
  return Math.round(n * 100) / 100;
}

function pick(body, key, fallback, parse) {
  return Object.prototype.hasOwnProperty.call(body, key) ? parse() : fallback;
}

function leadFromBody(body, prev) {
  const stage = pick(body, 'stage', prev ? prev.stage : 'contacted', () => text(body, 'stage', 20));
  if (!STAGES.includes(stage)) throw new HttpError(400, `stage must be one of: ${STAGES.join(', ')}`);
  const apptDay = pick(body, 'apptDay', prev ? prev.appt_day : null, () => {
    const v = body.apptDay;
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new HttpError(400, 'apptDay must be 0 (Monday) to 6 (Sunday)');
    return n;
  });
  return {
    name: prev ? pick(body, 'name', prev.name, () => text(body, 'name', 120, { required: true })) : text(body, 'name', 120, { required: true }),
    phone: pick(body, 'phone', prev ? prev.phone : '', () => text(body, 'phone', 40)),
    city: pick(body, 'city', prev ? prev.city : '', () => text(body, 'city', 80)),
    source: pick(body, 'source', prev ? prev.source : '', () => text(body, 'source', 40)),
    budget: pick(body, 'budget', prev ? prev.budget : null, () => money(body, 'budget', { nullable: true })),
    budget_text: pick(body, 'budgetText', prev ? prev.budget_text : '', () => text(body, 'budgetText', 40)),
    stage,
    notes: pick(body, 'notes', prev ? prev.notes : '', () => text(body, 'notes', 4000)),
    appt_day: apptDay,
    appt_time: pick(body, 'apptTime', prev ? prev.appt_time : '', () => text(body, 'apptTime', 20)),
  };
}

function jobFromBody(body, prev) {
  const date = pick(body, 'date', prev && prev.date, () => text(body, 'date', 10, { required: true }));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'date must look like 2026-09-24');
  const out = {
    name: prev ? pick(body, 'name', prev.name, () => text(body, 'name', 120, { required: true })) : text(body, 'name', 120, { required: true }),
    date,
    notes: pick(body, 'notes', prev ? prev.notes : '', () => text(body, 'notes', 2000)),
  };
  if (!out.name) throw new HttpError(400, 'name is required');
  for (const k of ['total', 'labor', 'materials', 'transportation', 'utilities', 'other']) {
    out[k] = pick(body, k, prev ? prev[k] : 0, () => money(body, k));
  }
  return out;
}

const leadOut = (r) => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  city: r.city,
  source: r.source,
  budget: r.budget,
  budgetText: r.budget_text,
  stage: r.stage,
  notes: r.notes,
  apptDay: r.appt_day,
  apptTime: r.appt_time,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

const jobOut = (r) => ({
  id: r.id,
  name: r.name,
  date: r.date,
  total: r.total,
  labor: r.labor,
  materials: r.materials,
  transportation: r.transportation,
  utilities: r.utilities,
  other: r.other,
  notes: r.notes,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

// ---------- helpers ----------

function requireOwner(user) {
  if (user.role !== 'owner') throw new HttpError(403, 'Only the owner can do this');
}

function bump(env, key) {
  return env.DB.prepare('UPDATE revisions SET value = value + 1 WHERE key = ?').bind(key);
}

async function revisions(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM revisions').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

// Two people editing the same record: refuse the older copy instead of silently overwriting.
function checkVersion(body, row) {
  if (body.expectUpdatedAt !== undefined && Number(body.expectUpdatedAt) !== row.updated_at) {
    throw new HttpError(409, `Someone else changed this since you opened it (${row.updated_by || 'unknown'}). Reload and try again.`);
  }
}

async function etagFor(parts) {
  const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(JSON.stringify(parts)));
  return 'W/"' + Array.from(new Uint8Array(bytes).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('') + '"';
}

// Refuse cross-site writes: the browser always sends Origin on these requests.
function checkOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Cross-site request refused');
}

// ---------- routes ----------

async function snapshot(request, env, user) {
  const [snaps, revs] = await Promise.all([readSnapshots(env), revisions(env)]);
  const sources = {};
  for (const k of Object.keys(SOURCES)) {
    const s = snaps[k] || { data: null, fetchedAt: null, attemptedAt: null, error: null };
    sources[k] = { data: s.data, fetchedAt: s.fetchedAt, attemptedAt: s.attemptedAt, error: s.error, everyMinutes: SOURCES[k].everyMs / 60000 };
  }
  const visibleRevs = user.role === 'owner' ? revs : { leads: revs.leads };
  const tag = await etagFor([
    user.role,
    visibleRevs,
    Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, [v.fetchedAt, v.attemptedAt, v.error]])),
  ]);
  if (request.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers: { etag: tag, 'cache-control': 'no-store' } });
  return json({ generatedAt: Date.now(), sources, revisions: visibleRevs }, { headers: { etag: tag } });
}

async function leadsRoute(request, env, user, id) {
  const now = Date.now();
  if (request.method === 'GET' && !id) {
    const { results } = await env.DB.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all();
    return json({ leads: results.map(leadOut) });
  }
  if (request.method === 'POST' && !id) {
    const body = await readJsonBody(request);
    const lead = leadFromBody(body, null);
    const newLeadId = newId('lead_');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO leads (id, name, phone, city, source, budget, budget_text, stage, notes, appt_day, appt_time, created_at, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13)`,
      ).bind(newLeadId, lead.name, lead.phone, lead.city, lead.source, lead.budget, lead.budget_text, lead.stage, lead.notes, lead.appt_day, lead.appt_time, now, user.email),
      bump(env, 'leads'),
    ]);
    const row = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(newLeadId).first();
    return json({ lead: leadOut(row) }, { status: 201 });
  }
  if (!id) throw new HttpError(405, 'Method not allowed');
  const row = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Lead not found');
  if (request.method === 'GET') return json({ lead: leadOut(row) });
  if (request.method === 'PATCH') {
    const body = await readJsonBody(request);
    checkVersion(body, row);
    const lead = leadFromBody(body, row);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE leads SET name = ?2, phone = ?3, city = ?4, source = ?5, budget = ?6, budget_text = ?7, stage = ?8, notes = ?9,
           appt_day = ?10, appt_time = ?11, updated_at = ?12, updated_by = ?13 WHERE id = ?1`,
      ).bind(id, lead.name, lead.phone, lead.city, lead.source, lead.budget, lead.budget_text, lead.stage, lead.notes, lead.appt_day, lead.appt_time, now, user.email),
      bump(env, 'leads'),
    ]);
    return json({ lead: leadOut(await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first()) });
  }
  if (request.method === 'DELETE') {
    await env.DB.batch([env.DB.prepare('DELETE FROM leads WHERE id = ?').bind(id), bump(env, 'leads')]);
    return json({ deleted: id });
  }
  throw new HttpError(405, 'Method not allowed');
}

async function jobsRoute(request, env, user, id) {
  requireOwner(user);
  const now = Date.now();
  if (request.method === 'GET' && !id) {
    const { results } = await env.DB.prepare('SELECT * FROM jobs ORDER BY date DESC').all();
    return json({ jobs: results.map(jobOut) });
  }
  if (request.method === 'POST' && !id) {
    const body = await readJsonBody(request);
    const job = jobFromBody(body, null);
    const jobId = newId('job_');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jobs (id, name, date, total, labor, materials, transportation, utilities, other, notes, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(jobId, job.name, job.date, job.total, job.labor, job.materials, job.transportation, job.utilities, job.other, job.notes, now, user.email),
      bump(env, 'jobs'),
    ]);
    return json({ job: jobOut(await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first()) }, { status: 201 });
  }
  if (!id) throw new HttpError(405, 'Method not allowed');
  const row = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Job not found');
  if (request.method === 'GET') return json({ job: jobOut(row) });
  if (request.method === 'PATCH') {
    const body = await readJsonBody(request);
    checkVersion(body, row);
    const job = jobFromBody(body, row);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE jobs SET name = ?2, date = ?3, total = ?4, labor = ?5, materials = ?6, transportation = ?7, utilities = ?8,
           other = ?9, notes = ?10, updated_at = ?11, updated_by = ?12 WHERE id = ?1`,
      ).bind(id, job.name, job.date, job.total, job.labor, job.materials, job.transportation, job.utilities, job.other, job.notes, now, user.email),
      bump(env, 'jobs'),
    ]);
    return json({ job: jobOut(await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first()) });
  }
  if (request.method === 'DELETE') {
    await env.DB.batch([env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id), bump(env, 'jobs')]);
    return json({ deleted: id });
  }
  throw new HttpError(405, 'Method not allowed');
}

async function usersRoute(request, env, user, email) {
  requireOwner(user);
  if (request.method === 'GET' && !email) {
    const { results } = await env.DB.prepare('SELECT email, role, name, added_at FROM users ORDER BY role, email').all();
    return json({ users: results.map((u) => ({ email: u.email, role: u.role, name: u.name, addedAt: u.added_at })) });
  }
  if (request.method === 'POST' && !email) {
    const body = await readJsonBody(request);
    const newEmail = text(body, 'email', 200, { required: true }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) throw new HttpError(400, 'Enter a valid email address');
    const role = text(body, 'role', 10, { fallback: 'team' });
    if (!['owner', 'team'].includes(role)) throw new HttpError(400, 'role must be owner or team');
    const existing = await env.DB.prepare('SELECT code_hash FROM users WHERE email = ?').bind(newEmail).first();
    await env.DB.prepare(
      `INSERT INTO users (email, role, name, added_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(email) DO UPDATE SET role = excluded.role, name = excluded.name`,
    ).bind(newEmail, role, text(body, 'name', 80), Date.now()).run();
    // A new person, or newCode: true, gets a fresh access code. It is shown once and only its hash is stored.
    const accessCode = !existing || !existing.code_hash || body.newCode === true ? await setAccessCode(env, newEmail) : undefined;
    return json({ user: { email: newEmail, role }, accessCode }, { status: 201 });
  }
  if (request.method === 'DELETE' && email) {
    const target = decodeURIComponent(email).toLowerCase();
    if (target === user.email) throw new HttpError(400, 'You cannot remove yourself');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM users WHERE email = ?').bind(target),
      env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(target),
    ]);
    return json({ deleted: target });
  }
  throw new HttpError(405, 'Method not allowed');
}

async function refreshRoute(request, env, user) {
  requireOwner(user);
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const snaps = await readSnapshots(env);
  const last = Math.max(0, ...Object.values(snaps).map((s) => s.attemptedAt || 0));
  const wait = REFRESH_COOLDOWN_MS - (Date.now() - last);
  if (wait > 0) throw new HttpError(429, `Just refreshed. Try again in ${Math.ceil(wait / 1000)} seconds.`);
  return json(await refreshAll(env, { force: true }));
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  if (parts[0] === 'health') return json({ ok: true });

  if (request.method !== 'GET' && request.method !== 'HEAD') checkOrigin(request);
  if (parts[0] === 'login' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const email = text(body, 'email', 200, { required: true }).toLowerCase();
    const code = text(body, 'code', 40, { required: true });
    const { user, cookie } = await login(env, request, email, code);
    return json(user, { headers: { 'set-cookie': cookie } });
  }
  if (parts[0] === 'logout' && request.method === 'POST') {
    return json({ ok: true }, { headers: { 'set-cookie': await logout(env, request) } });
  }
  const user = await currentUser(request, env);
  const [resource, id] = parts;
  if (parts.length > 2) throw new HttpError(404, 'Not found');
  switch (resource) {
    case 'me':
      return json({ email: user.email, role: user.role, name: user.name });
    case 'snapshot':
      return snapshot(request, env, user);
    case 'leads':
      return leadsRoute(request, env, user, id);
    case 'jobs':
      return jobsRoute(request, env, user, id);
    case 'users':
      return usersRoute(request, env, user, id);
    case 'refresh':
      return refreshRoute(request, env, user);
    default:
      throw new HttpError(404, 'Not found');
  }
}
