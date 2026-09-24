import { addDays, fetchJson, num } from '../util.js';

const MEASURES = {
  TOTAL_SESSIONS: 'sessions',
  TOTAL_UNIQUE_VISITORS: 'visitors',
  TOTAL_FORMS_SUBMITTED: 'forms',
  CLICKS_TO_CONTACT: 'contactClicks',
};

function wixGet(env, path) {
  const base = env.WIX_BASE_URL || 'https://www.wixapis.com';
  return fetchJson(
    base + path,
    { headers: { Authorization: env.WIX_API_KEY, 'wix-site-id': env.WIX_SITE_ID } },
    'Wix',
  );
}

export function normalizeVisits(body) {
  const byDate = new Map();
  for (const m of (body && body.data) || []) {
    const field = MEASURES[m.type];
    if (!field) continue;
    for (const v of m.values || []) {
      if (!byDate.has(v.date)) byDate.set(v.date, { date: v.date, sessions: 0, visitors: 0, forms: 0, contactClicks: 0 });
      byDate.get(v.date)[field] = num(v.value);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function normalizeGscRows(body, key) {
  return ((body && body.results) || []).map((r) => ({
    [key]: (r.keys && r.keys[0]) || '',
    clicks: num(r.clicks),
    impressions: num(r.impressions),
    ctr: num(r.ctr),
    position: num(r.position),
  }));
}

// Website visits (through today) and Google Search Console (Google publishes 2-3 days late).
export async function fetchWeb(env, today) {
  if (!env.WIX_API_KEY) throw new Error('Wix is not connected yet (WIX_API_KEY missing)');
  const a = new URLSearchParams();
  a.append('dateRange.startDate', addDays(today, -29));
  a.append('dateRange.endDate', addDays(today, 1));
  for (const t of Object.keys(MEASURES)) a.append('measurementTypes', t);
  a.append('timeZone', env.BUSINESS_TZ);
  const daily = new URLSearchParams({ startDate: addDays(today, -89), endDate: today, dimensions: 'date' });
  const queries = new URLSearchParams({ startDate: addDays(today, -27), endDate: today, dimensions: 'query', rowLimit: '500' });

  const [visits, gscDaily, gscQueries] = await Promise.allSettled([
    wixGet(env, '/analytics/v2/site-analytics/data?' + a),
    wixGet(env, '/gsc/connection/v1/search-analytics?' + daily),
    wixGet(env, '/gsc/connection/v1/search-analytics?' + queries),
  ]);
  if (visits.status === 'rejected' && gscDaily.status === 'rejected' && gscQueries.status === 'rejected') {
    throw new Error(visits.reason.message);
  }
  const days = gscDaily.status === 'fulfilled' ? normalizeGscRows(gscDaily.value, 'date').sort((x, y) => (x.date < y.date ? -1 : 1)) : [];
  return {
    visits: {
      days: visits.status === 'fulfilled' ? normalizeVisits(visits.value) : [],
      error: visits.status === 'rejected' ? visits.reason.message : null,
    },
    google: {
      days,
      through: days.length ? days[days.length - 1].date : null,
      queries:
        gscQueries.status === 'fulfilled'
          ? normalizeGscRows(gscQueries.value, 'query').sort((x, y) => y.impressions - x.impressions || y.clicks - x.clicks).slice(0, 100)
          : [],
      error:
        gscDaily.status === 'rejected' ? gscDaily.reason.message : gscQueries.status === 'rejected' ? gscQueries.reason.message : null,
    },
  };
}
