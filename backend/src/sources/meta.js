import { addDays, fetchJson, num, round2 } from '../util.js';

// Account-level daily insights. Meta has no 3-second view field; 2-second continuous views are the closest.
const FIELDS = [
  'spend',
  'impressions',
  'reach',
  'clicks',
  'actions',
  'video_play_actions',
  'video_continuous_2_sec_watched_actions',
  'video_p25_watched_actions',
  'video_thruplay_watched_actions',
];
const HISTORY_DAYS = 90;
const LEAD_TYPES = ['lead', 'onsite_conversion.lead_grouped'];

function actionValue(list, types) {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const hit = list.find((a) => a && a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

function actionSum(list) {
  return Array.isArray(list) ? list.reduce((s, a) => s + num(a && a.value), 0) : 0;
}

export function normalizeInsightRow(r) {
  return {
    date: r.date_start,
    spend: round2(num(r.spend)),
    impressions: num(r.impressions),
    reach: num(r.reach),
    clicks: num(r.clicks),
    leads: actionValue(r.actions, LEAD_TYPES),
    videoPlays: actionSum(r.video_play_actions),
    video2s: actionSum(r.video_continuous_2_sec_watched_actions),
    videoP25: actionSum(r.video_p25_watched_actions),
    thruplays: actionSum(r.video_thruplay_watched_actions),
  };
}

export async function fetchAccountDaily(env, accountId, today) {
  const base = env.META_BASE_URL || 'https://graph.facebook.com';
  const params = new URLSearchParams({
    level: 'account',
    time_increment: '1',
    time_range: JSON.stringify({ since: addDays(today, -(HISTORY_DAYS - 1)), until: today }),
    fields: FIELDS.join(','),
    limit: '100',
  });
  let url = `${base}/${env.META_API_VERSION}/act_${accountId}/insights?${params}`;
  const rows = [];
  for (let page = 0; url && page < 5; page++) {
    const body = await fetchJson(url, { headers: { Authorization: `Bearer ${env.META_TOKEN}` } }, 'Meta');
    for (const r of body.data || []) if (r && r.date_start) rows.push(normalizeInsightRow(r));
    url = (body.paging && body.paging.next) || null;
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

// Pull both accounts. A failed account keeps its previous rows and reports its own error.
export async function fetchMeta(env, today, previous) {
  if (!env.META_TOKEN) throw new Error('Meta is not connected yet (META_TOKEN missing)');
  const accounts = {
    flooring: { id: env.META_FLOORING_ACCOUNT, label: 'CJ Flooring' },
    pool: { id: env.META_POOL_ACCOUNT, label: 'Pool Resurfacing' },
  };
  const keys = Object.keys(accounts);
  const results = await Promise.allSettled(keys.map((k) => fetchAccountDaily(env, accounts[k].id, today)));
  const out = { today, accounts: {} };
  let okCount = 0;
  keys.forEach((k, i) => {
    const r = results[i];
    const prev = previous && previous.accounts && previous.accounts[k];
    if (r.status === 'fulfilled') {
      okCount++;
      out.accounts[k] = { ...accounts[k], rows: r.value, error: null, fetchedAt: Date.now() };
    } else {
      out.accounts[k] = {
        ...accounts[k],
        rows: prev ? prev.rows : [],
        error: r.reason.message,
        fetchedAt: prev ? prev.fetchedAt : null,
      };
    }
  });
  if (!okCount) throw new Error(results[0].reason.message);
  return out;
}
