# Lyrics backend

> The chat server is a separate service with its own runbook: [`server/chat/README.md`](../server/chat/README.md).

`server/` is a dependency-free Node service (Node 20.12+). `server/index.mjs` serves the built web app *and* `/api/spicy/*`; the Docker image runs the same file with no `web/dist/`, so it serves only the API.

What it does, from the source: three fixed GET routes (`/api/spicy/health`, `/lyrics/<22-char Spotify id>`, `/match?title&artist&isrc`), a server-held Spicy Lyrics key and Spotify client credentials, 8 s upstream timeout, 2 MB cap, per-client rate limit (default 30/min), bounded in-memory cache, same-origin-only unless `AURALIS_ALLOWED_ORIGINS`. Auralis web falls back to server lyrics and LRCLIB when the backend is absent or unconfigured.

## Local development
```sh
cp .env.example .env     # fill SPICY_LYRICS_SECRET_KEY (and optionally SPOTIFY_*); .env is git-ignored
npm run dev              # the Vite dev servers (web, tauri, android) mount the same handler via server/vite-plugin.mjs
npm test -w @auralis/server   # server tests with mocked upstream
```
Docker, locally:
```sh
docker build -t auralis-backend .
docker run --rm --read-only --cap-drop ALL -p 127.0.0.1:8787:8787 --env-file .env auralis-backend
curl http://127.0.0.1:8787/api/spicy/health      # {"enabled":true,...}
```

## Deploying to `alwaysonpc` (NOT done: run these yourself, nothing here has been executed on the server)
Path: client → HTTPS (Cloudflare) → Cloudflare Tunnel → container on `127.0.0.1:8787`. Replace `<tunnel>`.
What *was* tested (locally, see `PROGRESS.md`): the image builds, runs read-only with all capabilities dropped, passes its health check and serves real lyrics. What was *not*: `docker compose up`, the tunnel, or anything on the server.

### 0. Prerequisites on `alwaysonpc` (Arch)
```sh
sudo pacman -S --needed docker docker-compose git      # skip what you have
sudo systemctl enable --now docker
docker compose version                                  # v2 plugin; if only `docker-compose` exists, use that spelling below
```

### 1. Get the code and secrets there
```sh
git clone <your-repo-url> ~/auralis && cd ~/auralis     # or rsync the repo; only Dockerfile, package.json, server/, docker-compose.yml are needed
install -m 600 /dev/null .env && $EDITOR .env           # paste SPICY_LYRICS_SECRET_KEY (+ SPOTIFY_CLIENT_ID/SECRET if you use matching)
```
Never commit `.env`. Add `AURALIS_ALLOWED_ORIGINS=` here too (step 4).

### 2. Start it, bound to loopback
```sh
docker compose up -d --build
docker compose ps                                       # wait for "healthy" (up to ~30 s)
curl -s http://127.0.0.1:8787/api/spicy/health          # {"enabled":true,"matching":true}
```
`restart: unless-stopped` brings it back after reboots. The port is published on `127.0.0.1` only, so nothing else can reach it until the tunnel does.

### 3. Add the hostname to your existing tunnel
First check how the tunnel is managed:
- **Config-file tunnel** (`/etc/cloudflared/config.yml` or `~/.cloudflared/config.yml`): add this *above* the final catch-all `http_status:404` rule, then `cloudflared tunnel route dns <tunnel> lyrics.folk3s.com` and `sudo systemctl restart cloudflared`.
  ```yaml
  - hostname: lyrics.folk3s.com
    service: http://127.0.0.1:8787
  ```
- **Dashboard-managed tunnel** (Zero Trust → Networks → Tunnels → your tunnel → Public Hostname): add hostname `lyrics.folk3s.com`, service `HTTP`, URL `127.0.0.1:8787`. The DNS record is created for you. No config file edit.
If `cloudflared` itself runs in Docker, `127.0.0.1` is the cloudflared container, not the host: use the host's LAN IP or put both containers on one Docker network and use the service name.

**If Caddy already fronts the tunnel** (tunnel ingress points at Caddy, not at services): leave the tunnel hostname pointing at Caddy and add a site block instead. Cloudflare terminates TLS, so match whatever your other blocks use (plain-HTTP site address if they do):
```caddy
http://lyrics.folk3s.com {
	reverse_proxy 127.0.0.1:8787
}
```
`caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`. Only one of the two paths (tunnel to 8787 directly, or tunnel to Caddy to 8787) should serve the hostname. Don't enable Caddy compression/caching rules for this host that strip `Vary`. Review before applying: nothing here has been changed on your server.

### 4. Allow the callers
`AURALIS_ALLOWED_ORIGINS` is a comma-separated allow-list (exact origins, never `*`):
- Tauri desktop on Linux/macOS: `tauri://localhost`; on Windows: `http://tauri.localhost`.
- The hosted web app, if you serve it elsewhere: its origin, e.g. `https://music.example.com`.
Restart after changing: `docker compose up -d`. Production builds of the app already default to `https://lyrics.folk3s.com`; users can point at another server in Settings → Lyrics (see `DESKTOP.md`).

### 5. Verify from outside the server
```sh
curl -s https://lyrics.folk3s.com/api/spicy/health                               # {"enabled":true,"matching":true}
curl -s "https://lyrics.folk3s.com/api/spicy/match?title=Peace%20Sign&artist=Usher"  # candidates with a Spotify id
curl -sI -H 'Origin: tauri://localhost' https://lyrics.folk3s.com/api/spicy/health | grep -i access-control   # present only for allowed origins
```
Health returns HTTP 200 when the Spicy key is loaded and 503 (same JSON, `enabled:false`) when it is not, so uptime monitors can alert on it; it exposes no secrets. `enabled:false` means the key did not load: check `docker compose logs` and `.env`.

### Update / rollback / stop
```sh
cd ~/auralis && git pull && docker compose up -d --build        # update
docker compose logs -f --tail=100                                 # logs (secrets are not logged)
git checkout <previous-commit> && docker compose up -d --build    # roll back
docker compose down                                               # stop; remove the tunnel hostname to unpublish
```

### Known limitations to decide on before going public
- **Client address for rate limiting.** With `TRUST_PROXY=1` the limiter keys on `CF-Connecting-IP` (set by Cloudflare), falling back to the *last* `X-Forwarded-For` entry (appended by the nearest proxy). A caller-supplied first entry no longer helps (covered by tests). Still unverified against a real tunnel: send repeated requests with a fake `X-Forwarded-For` and confirm you get 429s. A Cloudflare WAF rate-limit rule on the hostname is a worthwhile second layer.
- `TRUST_PROXY=1` is only safe because the port is loopback-only behind the tunnel. Never enable it on a port reachable from the internet.
- Native apps send no `Origin`, so the origin check does not protect them: see the note below.

**Native apps:** the SwiftUI apps do not call this backend yet. When they do, native `URLSession` requests carry no `Origin`, so they pass the browser-oriented origin check, which means the rate limiter is then the only protection. Consider a shared token before exposing the endpoint publicly.

## Secrets
`SPICY_LYRICS_SECRET_KEY`, `SPOTIFY_CLIENT_SECRET` live only in the server environment. Only `VITE_AURALIS_BACKEND_URL` (a public address) is client-visible. `server/tests/no-secret-in-bundle.test.ts` guards the bundle.
