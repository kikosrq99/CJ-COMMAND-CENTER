import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInsightRow } from '../src/sources/meta.js';
import { normalizeVisits, normalizeGscRows } from '../src/sources/wix.js';
import { cityFromTitle, normalizeAd } from '../src/sources/floco.js';
import { addDays, ymdInTz } from '../src/util.js';
import { verifyAccessJwt } from '../src/auth.js';

test('Meta insight row: spend, leads from actions, video sums', () => {
  const row = normalizeInsightRow({
    date_start: '2026-09-17',
    spend: '8.23',
    impressions: '130',
    reach: '101',
    clicks: '11',
    actions: [
      { action_type: 'link_click', value: '7' },
      { action_type: 'onsite_conversion.lead_grouped', value: '1' },
      { action_type: 'lead', value: '2' },
    ],
    video_play_actions: [{ action_type: 'video_view', value: '113' }],
    video_continuous_2_sec_watched_actions: [{ action_type: 'video_view', value: '60' }],
    video_thruplay_watched_actions: [{ action_type: 'video_view', value: '22' }],
  });
  assert.deepEqual(row, {
    date: '2026-09-17', spend: 8.23, impressions: 130, reach: 101, clicks: 11, leads: 2,
    videoPlays: 113, video2s: 60, videoP25: 0, thruplays: 22,
  });
});

test('Meta insight row: no leads and missing fields become zero', () => {
  const row = normalizeInsightRow({ date_start: '2026-09-24', spend: '1.36', impressions: '9' });
  assert.equal(row.leads, 0);
  assert.equal(row.clicks, 0);
  assert.equal(row.thruplays, 0);
});

test('Wix visits merge four measures by date', () => {
  const days = normalizeVisits({
    data: [
      { type: 'TOTAL_SESSIONS', values: [{ date: '2026-09-23', value: 5 }, { date: '2026-09-24', value: 0 }] },
      { type: 'TOTAL_FORMS_SUBMITTED', values: [{ date: '2026-09-23', value: 1 }] },
      { type: 'TOTAL_SALES', values: [{ date: '2026-09-23', value: 99 }] },
    ],
  });
  assert.deepEqual(days, [
    { date: '2026-09-23', sessions: 5, visitors: 0, forms: 1, contactClicks: 0 },
    { date: '2026-09-24', sessions: 0, visitors: 0, forms: 0, contactClicks: 0 },
  ]);
});

test('Search Console rows', () => {
  const rows = normalizeGscRows({ results: [{ keys: ['pool deck resurfacing sarasota'], clicks: 0, impressions: 52, ctr: 0, position: 12.88 }] }, 'query');
  assert.deepEqual(rows, [{ query: 'pool deck resurfacing sarasota', clicks: 0, impressions: 52, ctr: 0, position: 12.88 }]);
});

test('Floco city and link never carry the token', () => {
  assert.equal(cityFromTitle('Get Your Free Punta Gorda Quote'), 'Punta Gorda');
  assert.equal(cityFromTitle(''), null);
  const ad = normalizeAd({ id: 123, ad_creative_link_titles: ['Get Your Free Tampa Quote'], ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=123&access_token=SECRET' }, true);
  assert.equal(ad.url, 'https://www.facebook.com/ads/library/?id=123');
  assert.ok(!JSON.stringify(ad).includes('SECRET'));
  assert.equal(ad.city, 'Tampa');
});

test('Dates in Florida time', () => {
  assert.equal(ymdInTz(new Date('2026-09-25T02:30:00Z'), 'America/New_York'), '2026-09-24');
  assert.equal(addDays('2026-09-24', -89), '2026-06-27');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
});

// ---------- login token verification ----------

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const env = { ACCESS_TEAM_DOMAIN: 'cjtest.cloudflareaccess.com', ACCESS_AUD: 'aud-123' };
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
globalThis.fetch = async (url) => {
  assert.equal(url, 'https://cjtest.cloudflareaccess.com/cdn-cgi/access/certs');
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
};

async function sign(payload, kid = 'k1') {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { email: 'Owner@Example.com', aud: ['aud-123'], iss: 'https://cjtest.cloudflareaccess.com', exp: now + 3600, iat: now };

test('login: valid token gives lower-cased email', async () => {
  assert.equal(await verifyAccessJwt(await sign(good), env), 'owner@example.com');
});

test('login: expired, wrong audience, wrong issuer, unknown key are refused', async () => {
  await assert.rejects(verifyAccessJwt(await sign({ ...good, exp: now - 5 }), env), /expired/);
  await assert.rejects(verifyAccessJwt(await sign({ ...good, aud: ['other'] }), env), /audience/);
  await assert.rejects(verifyAccessJwt(await sign({ ...good, iss: 'https://evil.example' }), env), /issuer/);
  await assert.rejects(verifyAccessJwt(await sign(good, 'nope'), env), /unknown signing key/);
});

test('login: edited payload fails the signature check', async () => {
  const token = await sign(good);
  const [h, , s] = token.split('.');
  const forged = b64url(JSON.stringify({ ...good, email: 'attacker@example.com' }));
  await assert.rejects(verifyAccessJwt(`${h}.${forged}.${s}`, env), /bad signature/);
});
