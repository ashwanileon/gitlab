# httpstream

A multi-source [Stremio](https://www.stremio.com/) addon that scrapes HTTP
stream links from several sources (HDHub4u, 4KHDHub, ExtraFlix, MoviesDrives,
UHDRodeo) and exposes them through the Stremio stream API.

## How it works

- `index.js` is an Express server exposing the Stremio endpoints
  (`/manifest.json`, `/stream/:type/:id.json`) plus diagnostics
  (`/health`, `/livetest`, `/debug-search`, `/debug-md`).
- `src/providers/*` implement search + link extraction per source.
- `src/extractors.js` resolves intermediate hosts (HubCloud, DriveHub,
  Pixeldrain, etc.) into playable URLs.
- `src/cloudflare-bypass.js` fetches Cloudflare-protected pages using a
  fallback chain: **CF Worker proxy → system curl → curl-impersonate**.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Install in Stremio via `http://localhost:3000/manifest.json`.

## Deploy on Koyeb (free)

1. Connect this repo to a Koyeb Web Service.
2. Build: none required. Run command: `npm start`. Node `>=18`.
3. Set the environment variables below.
4. Install the addon in Stremio using `https://<your-app>.koyeb.app/manifest.json`.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `CF_WORKER_URL` | Recommended | URL of the Cloudflare Worker proxy (see below). Primary Cloudflare bypass. |
| `FLARESOLVERR_ENDPOINT` | Optional | Base URL of an external FlareSolverr (e.g. `http://<vm-ip>:8191`) on an always-on box such as an Oracle Cloud Always-Free VM. Solves challenge-mode Cloudflare sites (hubcloud, 4khdhub, hdhub4u) that a fetch proxy cannot. Used as the last-resort bypass method. |
| `TMDB_KEY` | Optional | TMDB API key used as a metadata fallback when Cinemeta is unavailable. |
| `PORT` | Optional | Defaults to `3000`. |

### Challenge-mode sources (hubcloud / 4khdhub / hdhub4u)

The CF Worker proxy defeats IP-based blocking but cannot solve interactive
Cloudflare JS challenges (Turnstile). Sites in challenge mode therefore need a
headless-browser solver. Run **FlareSolverr** on a free always-on VM (Oracle
Cloud Always-Free) and set `FLARESOLVERR_ENDPOINT` to its URL. The addon then
uses it as the final bypass step, serialized so a small VM is not overwhelmed.

## Cloudflare bypass (the free, permanent fix)

Most target sites sit behind Cloudflare, which blocks **datacenter IPs** like
Koyeb's. On a datacenter host you cannot run a headless-browser solver (needs
Chromium / ~1GB RAM), so that approach will not work on Koyeb free.

The reliable free method is a **Cloudflare Worker proxy**: a Worker's outbound
requests originate from Cloudflare's own edge network, which Cloudflare zones
generally trust. The Worker is included in `worker/cf-proxy-worker.js`.

The Cloudflare Workers free plan allows 100,000 requests/day, which is ample
for personal use.

### Deploy the Worker

Using Wrangler:

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

Or paste the contents of `worker/cf-proxy-worker.js` into a new Worker in the
Cloudflare dashboard.

Then set `CF_WORKER_URL` on Koyeb to the deployed Worker URL, for example:

```
CF_WORKER_URL=https://httpstream-cf-proxy.<your-subdomain>.workers.dev
```

The addon will automatically route Cloudflare-blocked fetches through the
Worker (`?target=<url>`, forwarding `header_*` params), falling back to the
other methods if needed.

## Diagnostics

- `/health` — liveness check.
- `/livetest` — runs each provider's search and reports counts.
- `/debug-search?url=...` — fetch raw HTML from a URL.
- `/debug-md?id=ttXXXXXXX` — step-by-step MoviesDrives extraction trace.

## License

MIT
