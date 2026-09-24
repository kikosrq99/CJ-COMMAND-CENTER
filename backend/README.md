# CJ Command API

A Cloudflare Worker with a D1 database. No runtime dependencies.

## How data stays fresh without a refresh button

A cron trigger runs every 15 minutes and pulls each source when it is due:

| Source | Every | What |
|---|---|---|
| `meta` | 15 min | Daily spend, impressions, reach, clicks, leads, video views for both ad accounts, last 90 days |
| `web` | 30 min | Wix visits, visitors, form submissions, clicks to contact (30 days); Google Search Console daily totals (90 days) and top searches (28 days) |
| `floco` | 60 min | Floco's active and past ads from the Meta Ad Library (needs `ADLIB_TOKEN`) |

Results are stored once in D1. Every signed-in phone reads the same copy, so everyone sees the same numbers. The app polls `/api/snapshot` about once a minute; when nothing changed the server answers `304 Not Modified`, which costs almost nothing.

If a source fails, its last good data stays and the error is reported next to it. If one ad account fails, the other still updates.

## Sign-in and roles

Cloudflare Access (free for up to 50 people) handles sign-in with a one-time email code. The Worker verifies Access's signed token on every request, then looks the email up in the `users` table:

- `owner` — everything, including job P&L, team management and manual refresh.
- `team` — ad results, website and Google data, Floco, leads. No P&L.

## API

All routes need a signed-in user except `/api/health`.

| Method | Path | Who | |
|---|---|---|---|
| GET | `/api/health` | anyone | Liveness check |
| GET | `/api/me` | all | Email and role |
| GET | `/api/snapshot` | all | All source data + change counters. Supports `If-None-Match` |
| GET/POST | `/api/leads` | all | List / create leads |
| GET/PATCH/DELETE | `/api/leads/:id` | all | Read / update / delete a lead |
| GET/POST | `/api/jobs` | owner | List / create jobs |
| GET/PATCH/DELETE | `/api/jobs/:id` | owner | Read / update / delete a job |
| GET/POST | `/api/users` | owner | List / add or change a team member (`{email, role, name}`) |
| DELETE | `/api/users/:email` | owner | Remove a team member |
| POST | `/api/refresh` | owner | Pull everything now (at most once a minute) |

`PATCH` accepts only the fields being changed. Send `expectUpdatedAt` (the `updatedAt` you loaded) to get `409` instead of overwriting someone else's newer edit.

Lead stages: `contacted`, `qualified`, `won`, `lost`. `apptDay` is 0 (Monday) to 6 (Sunday).

## Configuration

Plain settings live in `wrangler.toml` (`[vars]`). Secrets are added in the Cloudflare dashboard (Worker → Settings → Variables and Secrets) and are never committed:

| Secret | Required | |
|---|---|---|
| `META_TOKEN` | yes | Meta system user token with `ads_read` on both ad accounts |
| `WIX_API_KEY` | yes | Wix API key with Site Analytics and SEO read access |
| `ADLIB_TOKEN` | no | Meta Ad Library token, after Meta ID verification. Floco shows "not connected" without it |

## Tests

```bash
npm install
npm run test:unit   # data conversion + sign-in token checks
npm run test:e2e    # full Worker in the local Cloudflare runtime against a fake Meta/Wix server
```

## Free-plan budget

Roughly 2,000 requests and 300 database writes a day for a small team, against free limits of 100,000 requests and 100,000 writes a day.
