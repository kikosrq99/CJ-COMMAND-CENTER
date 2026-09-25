// Access keys can live in the Cloudflare dashboard (Worker secrets) or in the settings table.
// A dashboard secret wins when both exist. Keys are only ever read here, never sent to phones.
export const SECRET_KEYS = ['META_TOKEN', 'WIX_API_KEY', 'ADLIB_TOKEN'];

export async function withSettings(env) {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${SECRET_KEYS.map(() => '?').join(',')})`,
  ).bind(...SECRET_KEYS).all();
  const merged = { ...env };
  for (const r of results) if (!merged[r.key] && r.value) merged[r.key] = r.value;
  return merged;
}
