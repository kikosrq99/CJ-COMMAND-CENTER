# CJ Command

Internal operations app for CJ Floor Style / CJ Pool Resurfacing: live Meta ad results, website visits, Google Search, Floco competitor ads, leads pipeline and job P&L, shared by the whole team.

- `backend/` — Cloudflare Worker (free plan). Pulls Meta, Wix and Google data every 15 minutes into one shared database and serves it to the app. See [backend/README.md](backend/README.md).
- `docs/SETUP.md` — one-time setup, click by click.

The phone app comes next and will be served by the same Worker.
