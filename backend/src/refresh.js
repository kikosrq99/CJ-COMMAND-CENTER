import { fetchMeta } from './sources/meta.js';
import { fetchWeb } from './sources/wix.js';
import { fetchFloco } from './sources/floco.js';
import { ymdInTz } from './util.js';

// Meta updates its reporting about every 15 minutes; Google publishes daily; Floco changes rarely.
export const SOURCES = {
  meta: { everyMs: 15 * 60 * 1000, run: (env, today, prev) => fetchMeta(env, today, prev) },
  web: { everyMs: 30 * 60 * 1000, run: (env, today) => fetchWeb(env, today) },
  floco: { everyMs: 60 * 60 * 1000, run: (env) => fetchFloco(env) },
};
// Cron runs drift by a few seconds; without slack a 15-minute source would skip every other run.
const SLACK_MS = 90 * 1000;

export async function readSnapshots(env) {
  const { results } = await env.DB.prepare('SELECT key, data, fetched_at, attempted_at, error FROM snapshots').all();
  const out = {};
  for (const r of results) {
    let data = null;
    try {
      data = r.data ? JSON.parse(r.data) : null;
    } catch {
      data = null;
    }
    out[r.key] = { data, fetchedAt: r.fetched_at, attemptedAt: r.attempted_at, error: r.error };
  }
  return out;
}

export async function refreshAll(env, { now = Date.now(), force = false } = {}) {
  const today = ymdInTz(new Date(now), env.BUSINESS_TZ);
  const snaps = await readSnapshots(env);
  const due = Object.keys(SOURCES).filter((k) => {
    if (force) return true;
    const s = snaps[k];
    return !s || !s.attemptedAt || now - s.attemptedAt >= SOURCES[k].everyMs - SLACK_MS;
  });
  const results = await Promise.allSettled(due.map((k) => SOURCES[k].run(env, today, snaps[k] && snaps[k].data)));

  const statements = [];
  const errors = {};
  due.forEach((k, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') {
      statements.push(
        env.DB.prepare(
          `INSERT INTO snapshots (key, data, fetched_at, attempted_at, error) VALUES (?1, ?2, ?3, ?3, NULL)
           ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at,
             attempted_at = excluded.attempted_at, error = NULL`,
        ).bind(k, JSON.stringify(r.value), now),
      );
    } else {
      const message = String((r.reason && r.reason.message) || r.reason).slice(0, 300);
      errors[k] = message;
      statements.push(
        env.DB.prepare(
          `INSERT INTO snapshots (key, attempted_at, error) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET attempted_at = excluded.attempted_at, error = excluded.error`,
        ).bind(k, now, message),
      );
    }
  });
  if (statements.length) await env.DB.batch(statements);
  return { today, refreshed: due, errors };
}
