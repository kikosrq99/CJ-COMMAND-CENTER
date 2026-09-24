import { fetchJson } from '../util.js';

const FIELDS = [
  'id',
  'page_name',
  'ad_creation_time',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_creative_link_titles',
  'ad_creative_bodies',
].join(',');

export function cityFromTitle(title) {
  const m = /Free\s+(.+?)\s+Quote/i.exec(title || '');
  return m ? m[1].trim() : null;
}

// ad_snapshot_url from the API embeds the access token, so it is never stored; link to the public page instead.
export function normalizeAd(ad, active) {
  const title = (Array.isArray(ad.ad_creative_link_titles) && ad.ad_creative_link_titles[0]) || '';
  return {
    id: String(ad.id),
    title,
    body: ((Array.isArray(ad.ad_creative_bodies) && ad.ad_creative_bodies[0]) || '').slice(0, 500),
    city: cityFromTitle(title),
    createdAt: ad.ad_creation_time || null,
    startedAt: ad.ad_delivery_start_time || null,
    stoppedAt: ad.ad_delivery_stop_time || null,
    active,
    url: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(String(ad.id))}`,
  };
}

async function fetchStatus(env, status) {
  const base = env.META_BASE_URL || 'https://graph.facebook.com';
  const params = new URLSearchParams({
    search_page_ids: JSON.stringify([env.FLOCO_PAGE_ID]),
    ad_reached_countries: JSON.stringify(['US']),
    ad_active_status: status,
    ad_type: 'ALL',
    fields: FIELDS,
    limit: '100',
  });
  let url = `${base}/${env.META_API_VERSION}/ads_archive?${params}`;
  const ads = [];
  for (let page = 0; url && page < 3; page++) {
    const body = await fetchJson(url, { headers: { Authorization: `Bearer ${env.ADLIB_TOKEN}` } }, 'Meta Ad Library');
    ads.push(...(body.data || []));
    url = (body.paging && body.paging.next) || null;
  }
  return ads;
}

export async function fetchFloco(env) {
  if (!env.ADLIB_TOKEN) return { configured: false, ads: [], activeCount: 0 };
  const [active, all] = await Promise.all([fetchStatus(env, 'ACTIVE'), fetchStatus(env, 'ALL')]);
  const activeIds = new Set(active.map((a) => String(a.id)));
  const ads = all.map((a) => normalizeAd(a, activeIds.has(String(a.id))));
  for (const a of active) if (!ads.some((x) => x.id === String(a.id))) ads.push(normalizeAd(a, true));
  ads.sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  return { configured: true, activeCount: activeIds.size, ads };
}
