# Auralis chat server

Self-hosted chat backend for Auralis: chat accounts, direct and group conversations, persistent history, and live delivery
over WebSockets. Node 24 (TypeScript run directly via type stripping), Fastify 5, PostgreSQL 18, Docker Compose.
The design and its reasoning are in [`CHAT.md`](../../CHAT.md). This file is the operator runbook.

It is separate from the lyrics backend in `server/` (own package, lockfile, image, port and Compose project) and from
your music server: chat accounts are its own, never your Navidrome/Subsonic login.

> Messages are stored unencrypted in PostgreSQL. Whoever runs the server can read them. There is no end-to-end encryption.

## First deployment

```sh
cd server/chat
install -d -m 700 secrets && openssl rand -base64 32 > secrets/db_password && chmod 600 secrets/db_password
sudo chown 1000 secrets/db_password # the image runs as node (uid 1000); skip if your own uid is 1000
cp .env.example .env && $EDITOR .env          # CHAT_ALLOWED_ORIGINS, CHAT_BIND_ADDRESS, CHAT_REGISTRATION…
docker compose build
docker compose up -d --wait                   # db → migrate (one-shot) → chat, waits until healthy
docker compose run --rm chat node src/cli.ts create-admin <name>   # password is read from stdin, hidden
./scripts/smoke.sh                            # end-to-end + persistence check (see below)
```

Then pick the network route (LAN, Tailscale, public) from `CHAT.md` §9 and point Auralis at it in
**Settings → Chat server**.

`secrets/`, `backups/` and `.env` are git-ignored. PostgreSQL has no published port; it is reachable only on the
project's internal network.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `CHAT_SERVER_NAME` | `Auralis Chat` | Shown in the app. Quote it if it has spaces. |
| `CHAT_BIND_ADDRESS` | `127.0.0.1` | Host address the port is published on. `127.0.0.1` behind Tailscale Serve / a tunnel / Caddy; the LAN IP for direct LAN access. |
| `CHAT_PORT` | `8790` | Host port. Inside the container the app always listens on `0.0.0.0:8790`. |
| `CHAT_REGISTRATION` | `closed` | `closed` (CLI/admin only), `invite` (invite code required), `open`. |
| `CHAT_NAVIDROME_URL` | – | Navidrome/Subsonic URL reachable from the container. When set, any Navidrome user can sign in with their Navidrome username and password; the chat account is created on first sign-in (and its password kept in sync, signing out its other sessions), and joins the Lobby. Accounts created locally, admins and disabled accounts are never changed this way. Works with `CHAT_REGISTRATION=closed`; `open` is refused with this set (anyone could claim a Navidrome user's name first) and `invite` starts with a warning. The app only signs in automatically when the chat server is HTTPS and this URL's origin matches the user's music server. |
| `CHAT_ALLOWED_ORIGINS` | – | Exact web origins allowed to call the API and open sockets. `*` is refused. Desktop: `tauri://localhost` (Linux/macOS), `http://tauri.localhost` (Windows; Android assumed, verify). Web dev: `http://localhost:5173`. Native apps send no Origin. |
| `CHAT_TRUST_PROXY` | `0` | `1` takes the client address from the last `X-Forwarded-For` hop; `cloudflare` from `CF-Connecting-IP` (use only when Cloudflare, e.g. a Cloudflare Tunnel, is the proxy). Refused unless `CHAT_BIND_ADDRESS` is loopback. |
| `CHAT_LOG_LEVEL` | `info` | pino level. Logs never contain tokens, passwords, invite codes or message text. |
| `CHAT_SESSION_IDLE_DAYS` / `CHAT_SESSION_MAX_DAYS` | `30` / `180` | Session expiry (idle / absolute). |
| `CHAT_MAX_MESSAGE_CHARS` | `4000` | At most 4000 (database limit). |
| `CHAT_MAX_GROUP_MEMBERS` | `64` | |
| `CHAT_MAX_SOCKETS_PER_USER` | `10` | |
| `CHAT_DELETED_RETENTION_DAYS` | `30` | Deleted messages keep their text this long (for moderation), then an hourly job blanks it. |
| `CHAT_VERSION` | `local` | Image tag used by `compose.yaml`. |

The server refuses to start on unknown `CHAT_*` keys (typos), non-exact origins, `CHAT_TRUST_PROXY` set with a
non-loopback bind, or a missing/empty password file. For development without Docker, `DATABASE_URL` replaces the
`DATABASE_*` settings: `DATABASE_URL=postgres://… npm run migrate && npm start`.

## Everyday operations

```sh
docker compose ps                              # status + health
docker compose logs -f --tail=100 chat         # logs
curl -fsS http://127.0.0.1:8790/readyz         # 200 when the DB answers and the schema is current
curl -fsS http://127.0.0.1:8790/api/v1/server-info
docker compose stop                            # stop, keep containers
docker compose down                            # remove containers, KEEP data
# docker compose down -v                       # DESTROYS the database volume; never in routine use
```

Admin CLI (`docker compose run --rm chat node src/cli.ts <command>`):

| Command | Effect |
|---|---|
| `create-admin <user>` / `create-user <user>` | New account; password from stdin. |
| `reset-password <user>` | New password from stdin; signs out every session. |
| `disable-user <user>` / `enable-user <user>` | Disabling blocks sign-in and revokes sessions. A running server closes that user's sockets within a minute. |
| `create-invite [maxUses] [hours]` | Prints an invite code once (only its hash is stored). Admins can also create one in the app. |
| `revoke-sessions <user>` / `revoke-sessions --all` | Signs out one user, or everyone (suspected token leak). |
| `list-users` | |
| `maintenance` | Runs the deleted-message scrub and session cleanup now (it also runs hourly). |

Shutdown is graceful: on `SIGTERM` the server reports not ready, closes sockets with code 1001 (clients reconnect with
backoff), finishes in-flight requests and exits 0 (forced after 15 s; Compose waits 20 s).

## Smoke and persistence check

`./scripts/smoke.sh` starts the stack if needed, creates two throwaway users, sends a message, then checks after
`docker compose down` → `up` and after `up --force-recreate` that the message, the session and the `instanceId` are still
there, that the named volume holds the data (no new anonymous volume, which would mean a wrong PostgreSQL mount point),
and that `db` has no published port. The throwaway users are disabled at the end (rows are never hard-deleted).
`SMOKE_URL` overrides the address it talks to.

## Backup and restore

```sh
./scripts/backup.sh                            # backups/chat-<UTC time>.dump, mode 600, last 14 kept, written atomically
./scripts/restore.sh backups/chat-….dump       # asks first, takes a safety dump, restores, re-runs migrations
```

Backups contain every message: copy them off-host encrypted (e.g. with `age`), and schedule `backup.sh` daily (systemd
timer). They include the server's `instanceId`, so apps still recognise a restored server and keep their sessions.

## Upgrade and rollback

1. Read the release notes; take a backup (`./scripts/backup.sh`).
2. `git fetch && git checkout <tag>`, set `CHAT_VERSION=<tag>` in `.env`.
3. `docker compose build && docker compose up -d --wait`: `migrate` runs before the new `chat` starts; `/readyz` stays 503
   while the schema is older than the image expects.
4. `./scripts/smoke.sh`.

Migrations follow expand/contract: a release only adds, removals come a release later, so the previous image keeps
working against the new schema. App-only rollback: set the previous `CHAT_VERSION`, `docker compose up -d --wait`. After an
incompatible migration: stop `chat`, restore the pre-upgrade backup, start the previous tag (messages since the backup are
lost). PostgreSQL major upgrades are dump → new volume → restore, never just a new image tag on the old volume.

## Development

```sh
npm ci
npm run typecheck
npm test               # unit + integration against a real PostgreSQL started by Testcontainers (needs Docker)
```

`CHAT_TEST_DATABASE_URL` points the tests at an existing PostgreSQL (a role that may `CREATE DATABASE`) instead of
Docker. Each test file gets its own fresh database.
