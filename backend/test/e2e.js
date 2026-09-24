// End-to-end: real Cloudflare runtime (wrangler dev --local) + local D1 + a fake Meta/Wix server.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORKER = 'http://127.0.0.1:8787';
const MOCK_PORT = 8788;
const OWNER = 'owner@test.local';
const TEAM = 'team@test.local';
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' };

// ---------- fake upstream ----------
const mock = { failPool: false, failMetaAll: false, seen: [] };
const pad = (n) => String(n).padStart(2, '0');
function daysBetween(since, until) {
  const out = [];
  for (let d = new Date(since + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= until; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  mock.seen.push({ path: url.pathname, auth: req.headers.authorization, site: req.headers['wix-site-id'], q: url.search });
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const insights = /\/v24\.0\/act_(\d+)\/insights/.exec(url.pathname);
  if (insights) {
    if (req.headers.authorization !== 'Bearer meta-test-token') return send(400, { error: { message: 'Invalid OAuth access token' } });
    if (mock.failMetaAll || (mock.failPool && insights[1] === '1171862311644217')) return send(500, { error: { message: 'Service temporarily unavailable' } });
    const tr = JSON.parse(url.searchParams.get('time_range'));
    const all = daysBetween(tr.since, tr.until);
    const page = Number(url.searchParams.get('page') || 0);
    const slice = all.slice(page * 50, page * 50 + 50);
    const data = slice.map((date, i) => ({
      date_start: date, date_stop: date, spend: (5 + (i % 7)).toFixed(2), impressions: String(100 + i), reach: '80', clicks: '6',
      actions: i % 5 ? [] : [{ action_type: 'lead', value: '1' }],
      video_play_actions: [{ action_type: 'video_view', value: '90' }],
      video_continuous_2_sec_watched_actions: [{ action_type: 'video_view', value: '40' }],
      video_thruplay_watched_actions: [{ action_type: 'video_view', value: '12' }],
    }));
    const next = (page + 1) * 50 < all.length ? `http://127.0.0.1:${MOCK_PORT}${url.pathname}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(page + 1) })}` : undefined;
    return send(200, { data, paging: next ? { next } : {} });
  }
  if (url.pathname === '/v24.0/ads_archive') {
    const status = url.searchParams.get('ad_active_status');
    const ads = [
      { id: '1869328000706762', page_name: 'FLOCO Decking Systems', ad_creative_link_titles: ['Get Your Free Punta Gorda Quote'], ad_creation_time: '2026-09-13', ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=1869328000706762&access_token=SECRET_TOKEN' },
      { id: '841081808993993', page_name: 'FLOCO Decking Systems', ad_creative_link_titles: ['Get Your Free Cape Coral Quote'], ad_creation_time: '2026-08-26' },
    ];
    const stopped = { id: '5550001', page_name: 'FLOCO Decking Systems', ad_creative_link_titles: ['Get Your Free Naples Quote'], ad_creation_time: '2026-05-01', ad_delivery_stop_time: '2026-06-01' };
    return send(200, { data: status === 'ACTIVE' ? ads : [...ads, stopped] });
  }
  if (url.pathname === '/analytics/v2/site-analytics/data') {
    if (req.headers.authorization !== 'wix-test-key' || req.headers['wix-site-id'] !== '95383499-b3e1-4f6b-ae71-6a84f8e194bf') return send(401, { message: 'unauthorized' });
    const start = url.searchParams.get('dateRange.startDate');
    const dates = daysBetween(start, url.searchParams.get('dateRange.endDate')).slice(0, -1);
    return send(200, { data: url.searchParams.getAll('measurementTypes').map((t) => ({ type: t, values: dates.map((date) => ({ date, value: t === 'TOTAL_SESSIONS' ? 7 : 1 })), total: 0 })) });
  }
  if (url.pathname === '/gsc/connection/v1/search-analytics') {
    if (url.searchParams.get('dimensions') === 'date') {
      const days = daysBetween(url.searchParams.get('startDate'), url.searchParams.get('endDate')).slice(0, -3);
      return send(200, { results: days.map((d) => ({ keys: [d], clicks: 1, impressions: 40, ctr: 0.025, position: 6 })) });
    }
    return send(200, { results: [
      { keys: ['cj flooring'], clicks: 0, impressions: 5, ctr: 0, position: 4 },
      { keys: ['flooring installer'], clicks: 0, impressions: 141, ctr: 0, position: 1 },
      { keys: ['pool deck resurfacing sarasota'], clicks: 0, impressions: 52, ctr: 0, position: 12.9 },
    ] });
  }
  send(404, { error: { message: 'mock: no route ' + url.pathname } });
});

// ---------- helpers ----------
async function api(method, p, { user = OWNER, body, headers = {} } = {}) {
  const res = await fetch(WORKER + p, {
    method,
    headers: { 'x-dev-user': user, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag'), body: text ? JSON.parse(text) : null };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// wrangler's local trigger always uses the real clock, so time passing is simulated by backdating the last attempt.
function age(minutes, keys = ['meta', 'web', 'floco']) {
  wr(['d1', 'execute', 'cj-command', '--local', '--command',
    `UPDATE snapshots SET attempted_at = attempted_at - ${minutes * 60 * 1000} WHERE key IN (${keys.map((k) => `'${k}'`).join(',')});`]);
}
async function cron() {
  const res = await fetch(`${WORKER}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`);
  assert.equal(res.status, 200, 'scheduled handler ran');
  await wait(600);
}
let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}

// ---------- run ----------
const devVars = path.join(ROOT, '.dev.vars');
fs.writeFileSync(devVars, [
  'DEV_MODE=true', `DEV_USER_EMAIL=${OWNER}`, 'META_TOKEN=meta-test-token', 'WIX_API_KEY=wix-test-key', 'ADLIB_TOKEN=adlib-test-token',
  `META_BASE_URL=http://127.0.0.1:${MOCK_PORT}`, `WIX_BASE_URL=http://127.0.0.1:${MOCK_PORT}`,
].join('\n') + '\n');
fs.rmSync(path.join(ROOT, '.wrangler/state'), { recursive: true, force: true });
const wr = (args) => execFileSync('npx', ['wrangler', ...args], { cwd: ROOT, env, stdio: 'pipe' }).toString();
wr(['d1', 'execute', 'cj-command', '--local', '--file', 'schema.sql']);
wr(['d1', 'execute', 'cj-command', '--local', '--command',
  `INSERT INTO users (email, role, name, added_at) VALUES ('${OWNER}', 'owner', 'Owner', 0), ('${TEAM}', 'team', 'Team', 0);`]);

try {
  await fetch(WORKER + '/api/health');
  console.error('Port 8787 is already in use by another server. Stop it and run again.');
  process.exit(1);
} catch {}
await new Promise((r) => upstream.listen(MOCK_PORT, '127.0.0.1', r));
const dev = spawn('npx', ['wrangler', 'dev', '--local', '--test-scheduled', '--port', '8787', '--ip', '127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', (d) => (devLog += d));
dev.stderr.on('data', (d) => (devLog += d));

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(WORKER + '/api/health')).ok) break; } catch {}
    await wait(500);
    if (i === 59) throw new Error('worker did not start\n' + devLog);
  }
  console.log('Worker running. Tests:');

  await step('empty snapshot before first refresh', async () => {
    const r = await api('GET', '/api/snapshot');
    assert.equal(r.status, 200);
    assert.equal(r.body.sources.meta.data, null);
  });

  await cron();
  let snap;
  await step('cron fills Meta (both accounts, 90 days, paging followed, token in header)', async () => {
    snap = (await api('GET', '/api/snapshot')).body;
    const m = snap.sources.meta;
    assert.equal(m.error, null);
    assert.equal(m.data.accounts.flooring.rows.length, 90);
    assert.equal(m.data.accounts.pool.rows.length, 90);
    assert.equal(m.data.accounts.flooring.rows.at(-1).date, m.data.today);
    assert.ok(m.data.accounts.flooring.rows.some((r) => r.leads === 1));
    assert.equal(m.data.accounts.flooring.rows[0].video2s, 40);
    assert.ok(mock.seen.some((s) => s.q.includes('page=1')), 'second page fetched');
    assert.ok(!mock.seen.some((s) => s.q.includes('meta-test-token')), 'token never in URL');
  });
  await step('cron fills website visits and Google Search Console', async () => {
    const w = snap.sources.web.data;
    assert.equal(w.visits.days.length, 30);
    assert.equal(w.visits.days.at(-1).sessions, 7);
    assert.equal(w.google.queries[0].query, 'flooring installer');
    assert.ok(w.google.through < snap.sources.meta.data.today);
  });
  await step('cron fills Floco; stopped ads kept; no token leaks to phones', async () => {
    const f = snap.sources.floco.data;
    assert.equal(f.configured, true);
    assert.equal(f.activeCount, 2);
    assert.equal(f.ads.length, 3);
    assert.equal(f.ads.find((a) => a.id === '5550001').active, false);
    assert.ok(!JSON.stringify(snap).includes('SECRET_TOKEN'));
  });

  await step('unchanged data returns 304 (phones poll cheaply)', async () => {
    const a = await api('GET', '/api/snapshot');
    const b = await api('GET', '/api/snapshot', { headers: { 'if-none-match': a.etag } });
    assert.equal(b.status, 304);
  });

  await step('a cron run 1 minute later does not re-pull (not due yet)', async () => {
    const before = mock.seen.length;
    await cron();
    assert.equal(mock.seen.length, before);
  });

  await step('16 minutes later: Meta refreshes, website waits for its 30-minute slot', async () => {
    const before = mock.seen.length;
    age(16);
    await cron();
    const calls = mock.seen.slice(before).map((s) => s.path);
    assert.ok(calls.some((p) => p.includes('/insights')));
    assert.ok(!calls.some((p) => p.includes('site-analytics')));
  });

  await step('pool account fails: it keeps its last numbers, flooring still updates', async () => {
    mock.failPool = true;
    age(16, ['meta']);
    await cron();
    const m = (await api('GET', '/api/snapshot')).body.sources.meta;
    assert.equal(m.error, null);
    assert.match(m.data.accounts.pool.error, /500/);
    assert.equal(m.data.accounts.pool.rows.length, 90);
    assert.equal(m.data.accounts.flooring.error, null);
    mock.failPool = false;
  });

  await step('all of Meta fails: old data stays, error is reported', async () => {
    mock.failMetaAll = true;
    age(16, ['meta']);
    await cron();
    const m = (await api('GET', '/api/snapshot')).body.sources.meta;
    assert.match(m.error, /Meta 500/);
    assert.equal(m.data.accounts.flooring.rows.length, 90);
    mock.failMetaAll = false;
  });

  await step('roles: team sees snapshot and leads, not jobs, users, or refresh', async () => {
    assert.equal((await api('GET', '/api/me', { user: TEAM })).body.role, 'team');
    assert.equal((await api('GET', '/api/snapshot', { user: TEAM })).body.revisions.jobs, undefined);
    assert.equal((await api('GET', '/api/jobs', { user: TEAM })).status, 403);
    assert.equal((await api('GET', '/api/users', { user: TEAM })).status, 403);
    assert.equal((await api('POST', '/api/refresh', { user: TEAM, body: {} })).status, 403);
  });

  await step('people not on the team list are refused', async () => {
    const r = await api('GET', '/api/snapshot', { user: 'stranger@test.local' });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /not on the team list/);
  });

  await step('owner refresh works, then is rate-limited', async () => {
    age(2);
    assert.equal((await api('POST', '/api/refresh', { body: {} })).status, 200);
    const again = await api('POST', '/api/refresh', { body: {} });
    assert.equal(again.status, 429);
  });

  let lead;
  await step('team adds a lead; everyone sees the change counter move', async () => {
    const before = (await api('GET', '/api/snapshot')).body.revisions.leads;
    const r = await api('POST', '/api/leads', { user: TEAM, body: { name: 'Test Lead', stage: 'qualified', budget: 9000, source: 'Facebook Ad', city: 'Sarasota', apptDay: 3, apptTime: '3pm' } });
    assert.equal(r.status, 201);
    lead = r.body.lead;
    assert.equal(lead.updatedBy, TEAM);
    assert.equal((await api('GET', '/api/snapshot')).body.revisions.leads, before + 1);
    assert.equal((await api('GET', '/api/leads')).body.leads.length, 1);
  });

  await step('bad lead input is refused with a clear message', async () => {
    assert.match((await api('POST', '/api/leads', { body: { name: 'X', stage: 'maybe' } })).body.error, /stage must be one of/);
    assert.match((await api('POST', '/api/leads', { body: { stage: 'won' } })).body.error, /name is required/);
    assert.equal((await api('POST', '/api/leads', { body: { name: 'X', budget: -5 } })).status, 400);
  });

  await step('editing an outdated copy is refused (409), current copy saves', async () => {
    const ok = await api('PATCH', `/api/leads/${lead.id}`, { body: { stage: 'won', expectUpdatedAt: lead.updatedAt } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.lead.stage, 'won');
    assert.equal(ok.body.lead.city, 'Sarasota');
    const stale = await api('PATCH', `/api/leads/${lead.id}`, { user: TEAM, body: { stage: 'lost', expectUpdatedAt: lead.updatedAt } });
    assert.equal(stale.status, 409);
  });

  await step('cross-site write attempts are refused', async () => {
    const r = await api('POST', '/api/leads', { body: { name: 'X' }, headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  await step('owner manages jobs (P&L)', async () => {
    const c = await api('POST', '/api/jobs', { body: { name: 'Test Job A', date: '2026-08-01', total: 10000, labor: 3000, materials: 4000, transportation: 100, other: 200 } });
    assert.equal(c.status, 201);
    const u = await api('PATCH', `/api/jobs/${c.body.job.id}`, { body: { total: 12000 } });
    assert.equal(u.body.job.total, 12000);
    assert.equal(u.body.job.labor, 3000);
    assert.equal((await api('POST', '/api/jobs', { body: { name: 'Bad', date: 'yesterday' } })).status, 400);
    assert.equal((await api('DELETE', `/api/jobs/${c.body.job.id}`)).status, 200);
  });

  await step('owner adds and removes a team member', async () => {
    assert.equal((await api('POST', '/api/users', { body: { email: 'New@Test.local', role: 'team' } })).status, 201);
    assert.equal((await api('GET', '/api/me', { user: 'new@test.local' })).status, 200);
    assert.equal((await api('DELETE', '/api/users/new%40test.local')).status, 200);
    assert.equal((await api('GET', '/api/me', { user: 'new@test.local' })).status, 403);
    assert.equal((await api('DELETE', `/api/users/${encodeURIComponent(OWNER)}`)).status, 400);
  });

  await step('lead delete', async () => {
    assert.equal((await api('DELETE', `/api/leads/${lead.id}`)).status, 200);
    assert.equal((await api('GET', `/api/leads/${lead.id}`)).status, 404);
  });

  console.log(`\nAll ${passed} end-to-end checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e && e.stack ? e.stack : e);
  console.error('\n--- worker log (tail) ---\n' + devLog.split('\n').slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  dev.kill('SIGTERM');
  upstream.close();
  fs.rmSync(devVars, { force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}
