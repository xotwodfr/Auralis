# Auralis Chat Server — Implementation Plan

> **Status (2026-10-20): implemented for the server, web, Tauri and the Android phone UI.** The sections below are the
> original plan, kept as the design record; the labels in them describe the repository *before* the work. What was built,
> the decisions taken and every place the code departs from the plan are in **§0** directly below. Operator runbook:
> [`server/chat/README.md`](server/chat/README.md).

## 0. Implementation status

**Built:** `server/chat` (Phases 1–5 and 7), `shared/chat-protocol`, the shared client (Phase 8), Settings → Chat server
on web and phone (Phase 9), chat-server conversations in Social (Phase 10), CSP `ws: wss:`, CI job `chat-server` and the
chat e2e in the `web` job.

**Verified on this machine (Linux, Docker 29, Node 22.23, PostgreSQL 18.6 image):** server unit + integration suite
against real PostgreSQL (route inventory, concurrency, idempotency, pagination, WebSocket security, revocation, logging);
`docker compose up -d --wait`, `scripts/smoke.sh` (persistence across `down`/`up` and `--force-recreate`, no anonymous
volume, no published `db` port), backup → wipe → restore (data and `instanceId` kept), SIGTERM → exit 0; client unit and
MSW integration tests (incl. server-switch isolation of the `auralis` database); Playwright e2e with two browser
contexts against the real server. PostgreSQL 18's volume layout (§8.3 assumption) was confirmed from the image:
`VOLUME /var/lib/postgresql`, `PGDATA=/var/lib/postgresql/18/docker`.

**Decisions (§14):** every default was taken: scrypt, foreign keys, camelCase, path parameters, full history for new
group members, deleted bodies scrubbed after `CHAT_DELETED_RETENTION_DAYS` (30), Subsonic Disconnect does not sign out
of chat, tokens in IndexedDB on Tauri/Android, `gen_random_uuid()`, image tag (digest pinning left to the release
build), Cloudflare Tunnel recommended, `server/chat/`.

**Departures from the plan:**
- **Shared login (2026-10-21):** chat accounts use the Navidrome credentials and the app signs in to chat by itself.
  This replaces the plan's "independent accounts" rule; see §7.1. Every account is also put in one server-wide **Lobby**
  group (`joinLobby` in `server/chat/src/conversations.ts`) so everyone can talk to everyone.
- One migration (`0001_initial`) instead of `0001`–`0004`: the schema shipped at once. Later changes add migrations.
- Fewer dependencies: no `@fastify/rate-limit`, `@fastify/cors` or the TypeBox type provider. A small sliding-window
  limiter (also needed for WebSocket frames and per-username login failures) and an exact-origin CORS hook replace the
  first two; route schemas use `typebox` 1.x directly. Runtime deps: `fastify`, `@fastify/websocket`, `kysely`, `pg`, `typebox`.
- Files are grouped by area (`auth.ts`, `conversations.ts` incl. `can()`/`requireMember()`, `messages.ts`, `admin.ts`,
  `hub.ts`, `http.ts`, `crypto.ts`, `db.ts`) rather than the plan's per-concern folders. Client: `lib/chatStorage.ts` became
  `chatKv` (a `createKv('auralis-chat')` factory in `lib/storage.ts`); `uuid.ts`/`errors.ts` live in `api/chat/client.ts`.
- Group ownership: there is no transfer endpoint. When the owner leaves, the longest-standing admin (else member) becomes
  owner. There is no role-change endpoint yet, so the `admin` role exists in the schema and permissions but is not grantable.
- Revocations made from the CLI (another process) reach open sockets through a re-validation every ~50 s rather than
  instantly; API-driven revocation closes sockets immediately.
- No persistent message cache on the client: `auralis-chat` holds config, session and, for a remembered session only, the
  unsent outbox (tagged `instanceId|userId`, deleted with the session). History is refetched.
- No client-side heartbeat watchdog: browsers cannot see WebSocket pings. Dead connections are detected by the server's
  ping/terminate; the client reconnects on close, `online` and returning to the foreground.
- `/social/chat` with a chat server shows the conversation list and a "Choose a conversation" pane instead of jumping into
  the Subsonic room (which is still one tap away).

**Not done (and why):** Phase 0 platform spike and Phase 11 network rollouts (need the real host, Tailscale and devices;
nothing was deployed, no DNS or networking was touched, `chat.folk3s.com` does not exist); Phase 6 typing/presence
(optional, not built: the protocol omits it); Phase 12 Apple client (needs a Mac; deferred, recorded in `docs/PLATFORMS.md`);
a device run on Android and a runtime test in the Tauri desktop shells; the §13.3 load/soak run; Phase 13 version bump
and release.

---

> **Original status: plan only.** Every endpoint, file, table, event, command and
> configuration value below is a **proposed design** unless it is explicitly labelled **[Verified]**, which means it was
> checked against the repository as it stood on 2026-10-20 (`master` at `4fddde2`, version `0.2.7`).
>
> Labels used throughout:
> **[Verified]** observed in the repository · **[Proposed]** design for a future implementation ·
> **[Assumption]** believed true but not checked; must be verified · **[Decision]** an open choice with a default.

---

## 1. Project audit and current architecture

### 1.1 What Auralis is today [Verified]

Auralis is a Subsonic/Navidrome music client. There is one React app core and native Apple apps:

| Area | Path | Notes |
|---|---|---|
| React app core (api, audio, state, features, ui) | `shared/ui/src/` | Source only. Consumed by web, tauri and android through the `@auralis/ui` alias (`shared/ui/vite.base.ts`). |
| Web app | `web/` | Vite entry + Playwright e2e (`web/e2e/*.spec.ts`). |
| Linux/Windows desktop | `tauri/` | Tauri 2 shell, origin `tauri://localhost` (Linux/macOS) or `http://tauri.localhost` (Windows) per `docs/DESKTOP.md`. |
| Android | `android/` | Its own Tauri 2 project with the phone UI in `android/frontend/mobile/`, Gradle in `android/gen/android`. |
| macOS / iOS | `macos/`, `ios/`, `shared/apple/{AuralisKit,AuralisUI}` | Native SwiftUI, XcodeGen, built in CI only (`.github/workflows/ci.yml`, jobs `macos`, `ios`). |
| Lyrics backend | `server/` (`index.mjs`, `spicy.mjs`, `spotify.mjs`, `vite-plugin.mjs`) | **Dependency-free** Node service. Root `Dockerfile` + `docker-compose.yml` run it on `127.0.0.1:8787`. |

Stack, from `ARCHITECTURE.md` §1 and the package manifests: React 19, React Router 7, TanStack Query 5, Zustand 5, Vite 8,
TypeScript ~5.9, Vitest 5, Playwright 1.64, MSW 2.15. npm workspaces (root `package.json`): `shared/ui`, `server`, `web`,
`tauri`, `android`, with one shared lockfile.

Layering inside `shared/ui/src` (`ARCHITECTURE.md` §2), enforced in part by `scripts/check-boundaries.mjs`:
`app/ → features/ → ui/ → state/ → api/ + audio/ (siblings) → lib/`.

Cross-package dependency rules (`docs/STRUCTURE.md`, enforced by `scripts/check-boundaries.mjs` via `npm run lint`):
`web|tauri|android → shared/ui, server (dev only)`; `shared/* → nothing`; `server → nothing`.

### 1.2 Existing chat-related functionality [Verified]

There is already a **Social** feature with a chat UI. Its only backend is the Subsonic server:

- `shared/ui/src/api/subsonic/endpoints.ts`: `getChatMessages` / `addChatMessage` (the Subsonic server-wide room; the text
  travels in the query string because the Subsonic API only has GET).
- `shared/ui/src/state/social.ts`: Zustand store with `ChatStatus = 'unknown' | 'loading' | 'ready' | 'unsupported' | 'error'`,
  capped message list (`KEEP = 300`), `MAX_MESSAGE = 1000`, per-account last-read time in IndexedDB, de-duplication by
  `time|username|message`, and a reset whenever the Subsonic account changes (`useAuth.subscribe`).
- `shared/ui/src/features/social/data.ts`: polling (`CHAT_POLL_BACKGROUND_MS = 60_000`, `CHAT_POLL_OPEN_MS = 10_000`),
  unread counts, the "people" list derived from now-playing reports and chat authors.
- `shared/ui/src/features/social/Social.tsx`: `ConversationList`, `ChatLayout`, `ChatThread`, `Composer`, `MessageLog`.
  One room id, `SERVER_ROOM = 'server'`, with the comment *"the id leaves room for direct and group conversations later"*.
- Routes: web `App.tsx` `/social/chat/:room`; Android `android/frontend/mobile/MobileApp.tsx` `/social/chat/:room` with
  `SocialThreadPage` (`android/frontend/mobile/pages.tsx`, titled "Server chat").
- `TASKS.md` §Social says outright that direct and group messages, presence and friends *"need a social service with its own
  accounts and authorization; deliberately not invented."* The plan in this document is that service.
- Navidrome answers the Subsonic chat endpoints with **410 Gone** (`ARCHITECTURE.md` §4 Social), so on the most common
  server there is no chat at all today.
- Tests: `shared/ui/tests/unit/social.test.ts`, `shared/ui/tests/integration/social.test.tsx`, `web/e2e/social.spec.ts`,
  `android/e2e/social.spec.ts`, and the mock server chat in `shared/ui/testing/mock-server.mjs`.
- Apple apps: Social is **not implemented** (`docs/PLATFORMS.md` feature matrix).

### 1.3 Settings UI and persistence [Verified]

- Web settings page: `shared/ui/src/features/settings/Settings.tsx`. Sections: Appearance, Connection, Playback, Lyrics,
  Keyboard shortcuts. It exports `LyricsServerForm`, a reusable "server URL: save / test / reset" form, and
  `useAccountActions` (confirm dialogs).
- Android settings page: `android/frontend/mobile/SettingsPage.tsx` reuses `LyricsServerForm` and `useAccountActions`.
- Settings store: `shared/ui/src/state/settings.ts` (Zustand). It is persisted as one IndexedDB value under key `settings`,
  and every field is validated on restore.
- Storage: `shared/ui/src/lib/storage.ts` is a tiny IndexedDB key/value store (database `auralis`, object store `kv`).
  `shared/ui/src/lib/kvCache.ts` provides bounded expiring caches (used by the lyrics cache).
- URL validation for the lyrics backend: `shared/ui/src/lib/backend.ts` `checkServerUrl` accepts **https only, except
  http on loopback** (`localhost`, `127.0.0.1`, `[::1]`). The reason given (`docs/DESKTOP.md`) is mixed content in
  https webviews.
- Apple: `shared/apple/AuralisUI/SettingsStore.swift` (UserDefaults) and `shared/apple/AuralisUI/Keychain.swift` (the
  Subsonic password goes in the Keychain).

### 1.4 API clients, auth and networking [Verified]

- Subsonic HTTP client: `shared/ui/src/api/subsonic/client.ts` (plain `fetch`, typed `SubsonicError`, never retries,
  error messages never contain URLs because they carry tokens).
- Subsonic auth: token auth `t = md5(password + salt)` (`api/subsonic/auth.ts`). Session in `state/auth.ts`. "Remember this
  device" stores the **plaintext password** in IndexedDB, a documented limitation (`ARCHITECTURE.md` §6).
- Account switch hygiene: `state/auth.ts` `forgetSessionData()` clears signed URLs, lyrics cache and Spotify matches when the
  Subsonic server or user changes.
- The lyrics backend's security patterns (`server/spicy.mjs`): exact-origin CORS allow-list (`AURALIS_ALLOWED_ORIGINS`,
  never `*`), `Vary: Origin`, `Sec-Fetch-Site` checks, a per-client sliding-window rate limit, `TRUST_PROXY=1` only behind
  a proxy (keyed on `CF-Connecting-IP`), bounded caches, no secrets in logs. `server/tests/no-secret-in-bundle.test.ts`
  checks that only `VITE_` keys can reach client bundles.
- Network permissions per platform:
  - Android: `android/gen/android/app/src/main/AndroidManifest.xml` has `INTERNET` and `android:usesCleartextTraffic="true"`.
  - iOS/macOS: `ios/project.yml`, `macos/project.yml` set `NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }`.
  - Tauri CSP (`tauri/tauri.conf.json`, `android/tauri.conf.json`):
    `connect-src 'self' ipc: http://ipc.localhost http: https:`. **There is no `ws:` or `wss:`**, so WebSocket
    connections from the Tauri shells would be blocked as things stand.
  - Doc drift: `docs/DESKTOP.md` says "CSP is `null`", but both `tauri.conf.json` files set a CSP. The docs are out of date.
- No Tauri plugins are installed (`tauri/Cargo.toml` depends only on `tauri` and `gtk`). There is no OS keyring and no
  secure store on desktop or Android today.

### 1.5 Docker, CI, release and testing conventions [Verified]

- Root `Dockerfile`: `node:24-alpine`, `USER node`, `HEALTHCHECK` via `wget`, `COPY server ./server`.
- Root `docker-compose.yml`: `restart: unless-stopped`, `env_file: .env`, port published on `127.0.0.1` only, `read_only: true`,
  `cap_drop: [ALL]`, `no-new-privileges`. `docs/BACKEND.md` describes deploying it to a host called `alwaysonpc` (Arch)
  behind a Cloudflare Tunnel at `lyrics.folk3s.com` and says *"NOT done"*.
- Root `.dockerignore` excludes `web tauri android macos ios shared docs`, `server/tests` and other files.
- `.gitignore` ignores `.env` and `.env.*` at any depth, with `!.env.example`.
- CI (`.github/workflows/ci.yml`): Node 22. `npm ci → typecheck → lint → test → build:web → build tauri/android frontends →
  Playwright (Chromium)`, plus `tauri-linux`, `macos` and `ios` jobs. Release workflows: `release-android.yml`,
  `release-windows.yml`.
- Tests: Vitest (`shared/ui` capped at 2 workers, see `docs/STRUCTURE.md`), MSW for network mocking, Playwright against a
  mock Subsonic server (`shared/ui/testing/mock-server.mjs`).
- Cross-cutting rules from `TASKS.md`: never block playback; *"No new dependency without a one-line justification and an
  owner"*; every non-trivial logic unit ships with one small test.
- Local toolchain on this machine: Node v22.23.3, Docker 29.9.1.

### 1.6 Things that do not exist [Verified]

- No chat backend, database, ORM, migrations or WebSocket code anywhere in the repo.
- No download/offline-music feature. Playlists and favourites live on the Subsonic server, not on the device.
- `.claude/rules/backend-micronaut/*` and `.claude/rules/database/*` describe a **Kotlin/Micronaut/Exposed** stack the
  repository does not use. This plan adopts their stack-neutral rules (UTC `TIMESTAMPTZ`, soft deletes, layered
  responsibilities, chunked batch jobs, no silent catch) and deliberately departs from two of them; see §6.4 and §14.

---

## 2. Goals and non-goals

### Goals (v1)
1. A self-hosted chat backend that can be deployed **independently** of the lyrics backend, with Docker Compose and PostgreSQL.
2. Chat accounts that belong to the chat server: registration (with controls), login, sessions, logout and revocation.
3. Direct messages (exactly two people) and group conversations with roles.
4. Persistent text history, paginated, with read state and unread counts.
5. Real-time delivery over authenticated WebSockets, with reconnection, gap recovery and no duplicate messages.
6. Reachable through **LAN, Tailscale and (later) `https://chat.folk3s.com`**, all served by one installation, one database and
   one set of accounts.
7. A **Chat Server** section in Auralis Settings (web, Tauri, Android first; Apple later) and chat inside the existing
   Social UI.
8. Operations: health and readiness checks, safe migrations, structured logs, graceful shutdown, backup/restore,
   upgrade/rollback.

### Non-goals (v1)
- File attachments, images, voice notes, voice/video calls.
- End-to-end encryption. The server operator can read messages; the UI and docs must say so.
- Push notifications (FCM/APNs). Messages arrive while the app is open and are caught up on resume.
- Federation, multiple server nodes, horizontal scaling, Redis or message brokers.
- Message editing, reactions, threads, search across history (candidates for v1.x).
- Replacing the Subsonic room. It stays as an extra conversation where the music server supports it.

---

## 3. Proposed architecture and technology choices

### 3.1 Shape [Proposed]

```
 Auralis clients (web, Tauri, Android, later iOS/macOS)
   │  HTTPS / HTTP  (REST: auth, conversations, history, sending)
   │  WSS / WS      (push: new messages, read state, typing, presence)
   ▼
 ┌──────────────────────────── one host ─────────────────────────────┐
 │  [optional TLS edge: Tailscale Serve | Cloudflare Tunnel | Caddy]  │
 │        │                                                           │
 │  chat  (Node 24, Fastify, one process)  ── internal network ──  db │
 │        listens 0.0.0.0:8790 in container    (PostgreSQL, no        │
 │        published on CHAT_BIND_ADDRESS        published port)       │
 └────────────────────────────────────────────────────────────────────┘
```

Responsibilities and boundaries:

| Component | Owns | Must not |
|---|---|---|
| **Chat backend** (`server/chat/`) | Accounts, sessions, authorization, conversations, membership, message persistence, sequence numbers, fan-out over WebSockets, rate limits, validation, health. **Every authorization decision.** | Know about Navidrome, music, lyrics; trust anything the client claims about membership. |
| **PostgreSQL** | Durable state, uniqueness and integrity constraints, per-conversation ordering. | Be reachable from outside the Compose network. |
| **Protocol types** (`shared/chat-protocol/`) | Type-only definitions of REST bodies and WS events, shared by server and TS client. | Contain runtime code. That way it is erased at build time and needs no packaging. |
| **Shared client** (`shared/ui/src/api/chat`, `state/chat*.ts`) | HTTP client, socket lifecycle, reconnection, outbox, validation of server input, per-server cache. | Touch music settings or caches. It reads the Subsonic credentials only to sign in to chat (§7.1). |
| **Platform layers** | Entry points, CSP, network permissions, platform UI wrappers (Android phone UI, SwiftUI later), secure storage where the platform has one. | Re-implement protocol logic. Apple is the exception: Swift needs its own client, see §11. |

### 3.2 Technology choices

| Choice | Recommendation | Why it fits this repo | Rejected alternative |
|---|---|---|---|
| Runtime | **Node 24 LTS**, run `.ts` directly with Node's built-in **type stripping** (no build step). [Assumption: confirm Node 24 is still in LTS at implementation time; move to the next LTS when it is declared.] | The lyrics image already uses `node:24-alpine`. `tsconfig.node.base.json` already sets `noEmit`, `allowImportingTsExtensions` and `verbatimModuleSyntax`, which is exactly the type-stripping profile; add `erasableSyntaxOnly`. CI only needs `tsc --noEmit`, and the image ships source with no `dist/`. | `tsc` build output or a bundler: an extra step and artefact for no benefit. |
| HTTP | **Fastify 5** | Built-in JSON-schema validation (Ajv), request logging with redaction (pino), lifecycle hooks for graceful shutdown, `inject()` for fast tests, and first-party `@fastify/websocket` and `@fastify/rate-limit`. | Raw `node:http` like `server/index.mjs`: fine for three GET routes, but chat needs auth, validation, rate limits and upgrades, and that would mean re-inventing a framework. |
| WebSockets | **`@fastify/websocket`** (on `ws`) | The de-facto Node implementation. Supports `maxPayload`, ping/pong and backpressure. | Socket.IO: its own protocol, harder for the Swift client. SSE: one-way only, and typing needs upstream messages. |
| Database | **PostgreSQL 18** (`postgres:18-alpine`) [Assumption: confirm the current major and its volume layout (§8.3) at implementation time] | Durable, constraint-rich, `pg_dump` backups. One container. | SQLite: simpler, but the brief asks for PostgreSQL, and Postgres gives a clean upgrade path and concurrent writers. |
| DB access | **Kysely** + **`pg`** | A typed SQL query builder with no code generation and a built-in `Migrator` that takes a lock. SQL stays visible. | Prisma: a heavy engine binary and an awkward fit for Alpine. Drizzle: also good; Kysely was chosen for its smaller surface and explicit SQL. |
| Validation | Fastify JSON schema written with **TypeBox** (`@fastify/type-provider-typebox`) | One schema gives runtime validation and static types. | Zod: a second validation system next to Fastify's Ajv. |
| Password hashing | **scrypt from `node:crypto`** (stdlib), parameters encoded into the stored hash | No native dependency, works on Alpine/musl, and is an OWASP-accepted algorithm. [Decision] see §14. | bcrypt: 72-byte input limit, native build. |
| Tests | **Vitest** (repo standard) + **Testcontainers** (`@testcontainers/postgresql`) for a real Postgres; `ws` client for socket tests; Playwright for e2e | Same test runner as the rest of the repo. Real-database tests catch constraint and transaction bugs that mocks hide. | An in-memory DB fake: diverges from Postgres semantics. |
| Logging | pino (bundled with Fastify), JSON to stdout | Docker collects stdout; redaction is built in. | A file logger inside a read-only container. |

**Dependency justification (the `TASKS.md` rule).** The chat server deliberately is **not** dependency-free, unlike `server/`.
Its runtime dependencies would be `fastify`, `@fastify/websocket`, `@fastify/rate-limit`, `@fastify/cors`,
`@fastify/type-provider-typebox` + `@sinclair/typebox`, `kysely` and `pg`, each replacing code that would otherwise be
written by hand and security-sensitive. Owner: the chat server package. None of them reach a client bundle.

### 3.3 Why a separate package, not a workspace [Proposed]

`server/chat/` gets **its own `package.json` and `package-lock.json`** and is *not* added to the root `workspaces`:

- The Docker build context can be `server/chat/` alone, so `npm ci --omit=dev` works with its own lockfile. A workspace
  member needs the root lockfile plus every workspace manifest.
- Server dependencies such as `pg` and `fastify` never get resolved together with client dependencies, so a server upgrade
  cannot shift a client version.
- The lyrics backend in `server/*.mjs` stays exactly as it is: dependency-free, with its own image and port.

Protocol sharing works without packaging. `server/chat` and `shared/ui` both use `import type` from
`shared/chat-protocol/index.ts`. Type imports are erased by type stripping and by Vite, so the server image never needs
that folder. `tsc` in CI resolves it by relative path.

### 3.4 Single-process real-time model [Proposed]

- **REST is the only write path for messages** (`POST …/messages`). It gives normal HTTP status codes, idempotency, rate
  limiting and easy testing. **The WebSocket is a push channel** plus ephemeral client signals (typing).
- An in-memory **hub** maps `userId → Set<socket>` and `sessionId → Set<socket>`. After a message commits, the hub
  pushes `message.created` to the sockets of every *current* member of the conversation.
- That is enough for one server. If a second process were ever needed, PostgreSQL `LISTEN/NOTIFY` could fan out between
  processes; this is listed as future work only, not built.

---

## 4. Repository changes proposed for a future implementation

None of these files exist yet. All are **[Proposed]**.

### 4.1 New files

```
server/chat/
  package.json  package-lock.json  tsconfig.json  vitest.config.ts
  Dockerfile                     production image (§8.1)
  compose.yaml                   chat + db + migrate (§8.2); separate Compose project from the lyrics backend
  .env.example                   documented, no secrets (§8.4)
  README.md                      operator runbook (build/run/backup/upgrade), linked from docs/BACKEND.md
  scripts/backup.sh  scripts/restore.sh  scripts/smoke.sh
  src/
    main.ts                      process entry: config → db → app.listen → signal handlers
    app.ts                       buildApp(config, deps): Fastify instance (used by tests via inject)
    config.ts                    env parsing + validation; refuses to start on unsafe combinations (§7.7)
    cli.ts                       admin CLI: create-admin, reset-password, disable-user, create-invite, revoke-sessions
    migrate.ts                   runs Kysely Migrator; used by the `migrate` Compose service
    shutdown.ts                  graceful shutdown orchestration
    health.ts                    /healthz, /readyz
    db/ client.ts  types.ts  migrations/0001_initial.ts  …
    auth/ password.ts  tokens.ts  sessions.ts  routes.ts  guard.ts  loginThrottle.ts
    users/ routes.ts  service.ts
    conversations/ routes.ts  service.ts  permissions.ts
    messages/ routes.ts  service.ts
    realtime/ hub.ts  socket.ts  protocol.ts  presence.ts  typing.ts
    admin/ routes.ts  invites.ts
    http/ errors.ts  cors.ts  rateLimit.ts  clientAddress.ts
  tests/
    unit/          password, tokens, permissions, config, url policy, protocol guards
    integration/   HTTP via app.inject + real Postgres (Testcontainers); WebSocket via real `ws` clients
shared/chat-protocol/
  index.ts                       type-only: DTOs, event unions, error codes, close codes
shared/ui/src/
  api/chat/ client.ts  socket.ts  validate.ts  errors.ts  url.ts  uuid.ts
  state/ chatServer.ts  chat.ts
  lib/chatStorage.ts             separate IndexedDB database "auralis-chat" (§10.4)
  features/settings/ChatServerSection.tsx
  features/social/ (extended: conversation sources, new-conversation dialog)
shared/ui/tests/{unit,integration}/chat-*.test.ts(x)
web/e2e/chat.spec.ts             two browser contexts against a real chat server
.github/workflows/ci.yml         + `chat-server` job (§13.6)
```

### 4.2 Files to modify (in the phase that needs them)

| File | Change | Phase |
|---|---|---|
| `.dockerignore` (root) | Add `server/chat`, because the root `Dockerfile` copies `server/` into the lyrics image. | 1 |
| `.gitignore` (root) | Add `server/chat/secrets/` and `server/chat/backups/`. `.env` is already ignored at any depth [Verified]. | 1 |
| `scripts/check-boundaries.mjs` | Add owners `server/chat` → `[shared/chat-protocol]`, `shared/chat-protocol` → `[]`, `shared/ui` → `[shared/chat-protocol]`. Make `owner()` pick the **longest** matching prefix, because `find` would currently attribute `server/chat` files to `server`. | 1 / 8 |
| `package.json` (root) | Add scripts `test:chat` / `typecheck:chat` (`npm --prefix server/chat …`). Workspaces unchanged. | 1 |
| `tauri/tauri.conf.json`, `android/tauri.conf.json` | Add `ws: wss:` to `connect-src`. | 9 |
| `shared/ui/src/features/settings/Settings.tsx`, `android/frontend/mobile/SettingsPage.tsx` | Mount `ChatServerSection`. | 9 |
| `shared/ui/src/features/social/{Social.tsx,data.ts}`, `shared/ui/src/App.tsx`, `android/frontend/mobile/{MobileApp.tsx,pages.tsx}` | Chat-server conversations next to the Subsonic room. | 10 |
| `docs/STRUCTURE.md`, `docs/PLATFORMS.md`, `docs/BACKEND.md`, `docs/DESKTOP.md` (fix CSP note), `ARCHITECTURE.md` §4 Social/§6, `README.md`, `TESTING.md`, `TASKS.md` | Document what was built. | each phase |
| `shared/apple/AuralisKit`, `shared/apple/AuralisUI` | Swift chat client + views. | 12 |

---

## 5. Backend API and WebSocket protocol design [Proposed]

### 5.1 Conventions
- Base path `/api/v1`. JSON bodies, `camelCase` fields, matching the TypeScript and Swift client idioms (the snake_case
  rule in `.claude/rules/core/NAMING_CONVENTIONS.md` belongs to the Micronaut stack; [Decision] §14).
- Timestamps are ISO 8601 UTC strings (`2026-10-20T10:15:00.000Z`). IDs are UUID strings. Message order uses `seq`, a
  per-conversation integer, never clock time.
- Auth: `Authorization: Bearer <token>` on every authenticated request. No cookies, so there is no ambient credential.
- Errors: `{"error": {"code": "conversation_not_found", "message": "Human-readable text", "details"?: [...]}}`. Codes are a
  closed union in `shared/chat-protocol`.
- Status codes: 400 validation, 401 no/invalid/revoked token, 403 authenticated but not allowed, **404 for conversations the
  caller is not a member of** (indistinguishable from nonexistent, so membership cannot be probed), 409 conflict, 413 too
  large, 429 rate limited (`Retry-After`), 503 not ready.
- Request body limit: 32 KiB globally (Fastify `bodyLimit`).

### 5.2 Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | – | Liveness: the process is up. Always 200 unless shutting down. |
| `GET /readyz` | – | Readiness: DB reachable **and** schema at the expected migration. 503 otherwise and during shutdown. |
| `GET /api/v1/server-info` | – | `{instanceId, name, version, protocol: 1, registration: "closed"\|"invite"\|"open", limits: {maxMessageChars, …}}`. `instanceId` is how clients recognise the same server behind different URLs (§9.4). |
| `POST /api/v1/auth/register` | – | `{username, password, displayName?, inviteCode?}` → `201 {user, token, session}`. Allowed only by the registration mode. |
| `POST /api/v1/auth/login` | – | `{username, password, deviceName?}` → `{user, token, session}`. Generic failure message. |
| `POST /api/v1/auth/logout` | ✓ | Revokes the current session; closes its sockets. |
| `GET /api/v1/auth/sessions` | ✓ | The caller's sessions (device name, created, last used; never token material). |
| `POST /api/v1/auth/sessions/revoke` | ✓ | `{sessionId}` or `{others: true}`. |
| `POST /api/v1/auth/password` | ✓ | `{currentPassword, newPassword}`. Revokes all other sessions. |
| `GET /api/v1/me` | ✓ | Current user. |
| `PATCH /api/v1/me` | ✓ | `{displayName}`. |
| `GET /api/v1/users/search?q=` | ✓ | Min 2 chars, max 20 results, returns `{id, username, displayName}` only. Rate limited. |
| `GET /api/v1/conversations` | ✓ | Caller's conversations with `lastSeq`, `lastMessage` preview, `lastReadSeq`, `unreadCount`, members. |
| `POST /api/v1/conversations/direct` | ✓ | `{userId}` → the existing DM or a new one (idempotent via `dm_key`). |
| `POST /api/v1/conversations/group` | ✓ | `{title, memberIds[]}` (≤ `CHAT_MAX_GROUP_MEMBERS`). Caller becomes `owner`. |
| `GET /api/v1/conversations/:id` | member | Details + members. |
| `PATCH /api/v1/conversations/:id` | group admin | `{title}`. |
| `POST /api/v1/conversations/:id/members` | group admin | `{userIds[]}`. |
| `DELETE /api/v1/conversations/:id/members/:userId` | self or group admin | Leave / remove. The last owner must hand over ownership first. |
| `GET /api/v1/conversations/:id/messages?beforeSeq=&afterSeq=&limit=` | member | Keyset pagination, `limit` ≤ 100 (default 50). Returns `{messages, hasMore}`. |
| `POST /api/v1/conversations/:id/messages` | member | `{clientMessageId, body}` → `201 {message}`, or **`200` with the original message** if `clientMessageId` was already used by this sender in this conversation. |
| `DELETE /api/v1/conversations/:id/messages/:messageId` | sender or group admin | Soft delete; the body is blanked in responses (`deleted: true`). |
| `POST /api/v1/conversations/:id/read` | member | `{seq}`. Monotonic (never moves backwards). |
| `GET /api/v1/ws` | first frame | WebSocket upgrade (§5.4). |
| `POST /api/v1/admin/invites` | admin | `{maxUses, expiresInHours}` → code shown once. |
| `GET /api/v1/admin/users` / `POST /api/v1/admin/users/:id/disable` / `…/enable` | admin | Disabling revokes all sessions and closes sockets. |

Path parameters are used deliberately: the `.claude` rule against them targets Micronaut query binding and does not apply
to Fastify. [Decision] §14.

### 5.3 Message object

```jsonc
{
  "id": "uuid", "conversationId": "uuid", "seq": 42,
  "sender": { "id": "uuid", "username": "alex", "displayName": "Alex" },
  "clientMessageId": "uuid",          // echoed only to the sender's own sessions
  "body": "text (plain text, never HTML)",
  "createdAt": "2026-10-20T10:15:00.000Z",
  "deleted": false
}
```

### 5.4 WebSocket protocol (`/api/v1/ws`, protocol version 1)

**Handshake.**
1. On upgrade the server checks the `Origin` header. If it is present, it must be in `CHAT_ALLOWED_ORIGINS`; if it is absent
   (native clients), it is allowed. Rejected upgrades get HTTP 403. This defends against cross-site WebSocket hijacking.
2. The client's **first frame** must be `{"type":"auth","data":{"token":"…"}}` within 5 s, otherwise the server closes
   with 4408. Tokens are never placed in the URL, because URLs end up in proxy and server logs (the same concern
   `ARCHITECTURE.md` §6 documents for Subsonic tokens).
3. On success the server replies `ready`. On a bad or revoked token it closes with 4401, and the client must not reconnect
   until the user signs in again.

**Envelope.** `{"v":1,"type":"…","data":{…}}`. Unknown `type` from the client → `error` frame. Malformed JSON → close 4400.

| Direction | Type | Data |
|---|---|---|
| C→S | `auth` | `{token}` |
| C→S | `typing` | `{conversationId}`. The server checks membership and throttles to 1 per 3 s per conversation. |
| C→S | `presence.set` (optional phase) | `{visible: boolean}` |
| S→C | `ready` | `{userId, sessionId, serverTime, heartbeatSec: 25, protocol: 1}` |
| S→C | `message.created` | `{message}` |
| S→C | `message.deleted` | `{conversationId, messageId, seq}` |
| S→C | `conversation.created` / `conversation.updated` | `{conversation}` |
| S→C | `conversation.removed` | `{conversationId}` (caller left or was removed) |
| S→C | `member.added` / `member.removed` | `{conversationId, user}` |
| S→C | `read.updated` | `{conversationId, userId, seq}` |
| S→C | `typing` | `{conversationId, userId, expiresAt}` |
| S→C | `presence` (optional phase) | `{userId, online}`, only for users who share a conversation |
| S→C | `session.revoked` | `{}`, followed by close 4401 |
| S→C | `error` | `{code, message}` |

**Close codes:** `1001` server going away (shutdown; reconnect with backoff), `1009` frame too large, `4400` protocol violation,
`4401` unauthenticated / revoked / user disabled (do **not** auto-reconnect), `4408` auth timeout, `4429` rate limited
(reconnect after the delay given in the reason).

**Limits:** `maxPayload` 16 KiB; ≤ 10 sockets per user (`CHAT_MAX_SOCKETS_PER_USER`); inbound frames ≤ 20 per 10 s per socket;
server WebSocket ping every 25 s, terminate if no pong within 10 s. 25 s also keeps the connection under common proxy idle
timeouts; Cloudflare's is about 100 s [Assumption].

**Backpressure:** if a socket's `bufferedAmount` exceeds 1 MiB, close it with 1013 (try again later). The client then resyncs over
REST. A slow client must never grow server memory without bound.

### 5.5 Reconnection and duplicate handling (contract)

- **Sending is idempotent.** The client creates `clientMessageId` (UUID v4 from `crypto.getRandomValues`, not
  `crypto.randomUUID`, which only exists in secure contexts and so is missing on plain-HTTP LAN origins). A unique index on
  `(conversation_id, sender_id, client_message_id)` turns a retry into a `200` with the original message.
- **Ordering and gaps.** `seq` is assigned in the same transaction as the insert and is strictly increasing per conversation.
  The client stores `lastSeq` per conversation. If it receives `seq > lastSeq + 1`, it fetches `afterSeq=lastSeq`.
- **After every `ready`** (first connect or reconnect), the client calls `GET /conversations`. For each cached conversation
  whose server `lastSeq` is ahead, it fetches the missing range (`afterSeq`, paginated, capped; if the gap exceeds 500 it
  drops the cache for that conversation and reloads the newest page).
- **Client de-duplication** is by `id`, with `seq` as the sort key. A pending outbox entry is replaced by the confirmed message
  matched on `clientMessageId`.
- **Reconnect policy:** exponential backoff with full jitter (1 s → 30 s cap), reset after 60 s of stable connection. Reconnect
  immediately on the browser `online` event and when the page becomes visible. Never reconnect after 4401.

---

## 6. Database entities and relationships [Proposed]

### 6.1 Tables

All timestamps are `TIMESTAMPTZ` (UTC, per `.claude/rules/core/TIMEZONE.md`). Strings are `TEXT`. IDs are `UUID DEFAULT gen_random_uuid()`
(built into PostgreSQL ≥ 13; `uuidv7()` if PG18 is confirmed, [Decision]).

**`server_meta`**: `key TEXT PK`, `value TEXT`. The first migration inserts `instance_id` (random UUID) and `created_at`.
It is never changed afterwards, and a restore keeps it, so clients still recognise the server.

**`users`**
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `username` | text | 3–32 chars, `^[a-z0-9_.-]+$`, stored lowercase; `UNIQUE (username)` |
| `display_name` | text | 1–64 chars, NFC-normalised, control characters rejected |
| `password_hash` | text | `scrypt$N$r$p$salt$hash` (self-describing, so parameters can be upgraded on login) |
| `role` | text | `CHECK (role IN ('admin','user'))` |
| `disabled_at` | timestamptz null | |
| `created_at`, `updated_at` | timestamptz | |

**`sessions`**
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → users | |
| `token_hash` | bytea UNIQUE | SHA-256 of the 32-byte random token; the token itself is never stored |
| `device_name` | text null | user-supplied label, ≤ 64 chars |
| `created_at`, `last_used_at`, `expires_at`, `revoked_at` | timestamptz | idle expiry and absolute expiry (§7.3) |

**`invites`**: `id`, `code_hash bytea UNIQUE`, `created_by FK users`, `max_uses int`, `uses int`, `expires_at`, `revoked_at`, `created_at`.

**`conversations`**
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `kind` | text | `CHECK (kind IN ('direct','group'))` |
| `title` | text null | groups only, 1–80 chars |
| `dm_key` | text null UNIQUE | `"<smaller user id>:<larger user id>"` for DMs; stops two DMs for one pair being created in a race |
| `last_seq` | bigint NOT NULL DEFAULT 0 | sequence counter |
| `last_message_at` | timestamptz null | for list ordering |
| `created_by` | uuid FK → users | |
| `created_at`, `updated_at` | timestamptz | |
| | | `CHECK ((kind = 'direct') = (dm_key IS NOT NULL))` |

**`conversation_members`**
| column | type | notes |
|---|---|---|
| `conversation_id` | uuid FK → conversations | PK part |
| `user_id` | uuid FK → users | PK part |
| `role` | text | `CHECK (role IN ('owner','admin','member'))` |
| `last_read_seq` | bigint NOT NULL DEFAULT 0 | |
| `joined_at` | timestamptz | |
| `left_at` | timestamptz null | access ends when set; row kept for history |

Index: `(user_id) WHERE left_at IS NULL` (list my conversations).

**`messages`**
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `conversation_id` | uuid FK → conversations | |
| `seq` | bigint | `UNIQUE (conversation_id, seq)`, which is also the pagination index |
| `sender_id` | uuid FK → users | |
| `client_message_id` | uuid | `UNIQUE (conversation_id, sender_id, client_message_id)` |
| `body` | text | `CHECK (char_length(body) BETWEEN 1 AND 4000)` |
| `created_at` | timestamptz | |
| `deleted_at` | timestamptz null | soft delete; body nulled by a scheduled scrub after `CHAT_DELETED_RETENTION_DAYS` [Decision] |

### 6.2 Relationships

```
users 1─* sessions
users 1─* invites (created_by)
users *─* conversations   via conversation_members (role, last_read_seq, left_at)
conversations 1─* messages (seq unique per conversation)
users 1─* messages (sender)
```

### 6.3 Key transactions
- **Send:** `BEGIN; check membership (FOR SHARE); UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now()
  WHERE id = $1 RETURNING last_seq; INSERT INTO messages … ON CONFLICT (conversation_id, sender_id, client_message_id) DO
  NOTHING; COMMIT`. On conflict, roll back the counter bump (handled by re-selecting inside the same transaction before
  incrementing) and return the existing row. The `UPDATE` row lock serialises sends per conversation, which is the
  intended trade-off at this scale. *Ceiling:* one busy group serialises on one row; acceptable for self-hosted use.
- **Create DM:** `INSERT … ON CONFLICT (dm_key) DO NOTHING` then select, inside one transaction with the two member rows.
- **Revoke/disable:** DB update first, then close sockets in the hub. If the process crashes in between, the token is already
  dead in the DB and no socket survives a restart.

### 6.4 Departure from `.claude/rules/database/SCHEMA.md`
That rule says "No foreign keys". This plan **uses foreign keys** (without `ON DELETE CASCADE`; users and conversations are
never hard-deleted in v1). Membership is the core security property of a chat server. A database-enforced reference that
cannot point at nothing is cheap insurance, and none of the rule's motivations (cross-service tables, sharding) apply to a
single self-hosted database. Flagged as [Decision] in §14 so it is not silently overridden.

---

## 7. Authentication and security model [Proposed]

### 7.1 Identity
- **Changed 2026-10-21 (replaces the original "independent accounts" rule):** chat accounts **share the Navidrome
  credentials.** The chat server and the music server are run by the same operator, so one login is the point.
  - Server: with `CHAT_NAVIDROME_URL` set, a login that doesn't match a local chat password is checked against Navidrome
    (`ping.view`, Subsonic token auth, so the password itself is never sent). On success the chat account is created, or
    its password updated, and it joins the Lobby. This works even with `CHAT_REGISTRATION=closed`. Accounts with the
    chat `admin` role and disabled accounts are never created or changed this way, so control of Navidrome doesn't
    give control of the chat admin.
  - Client: when a chat server is configured and nobody is signed in to chat, the app signs in with the Subsonic
    username and password (`autoSignIn` in `state/chatServer.ts`). It tries once per address and set of credentials
    per app run, so a wrong password, a manual sign-out or a revoked session is not retried in a loop. If the Subsonic
    account changes to a different username, chat signs out and signs in as the new user. The two sessions are still
    stored separately (`auralis` vs `auralis-chat`), and the chat server never stores the Navidrome password in plain text.
  - Trade-off accepted: the chat server now sees each user's Navidrome password at sign-in, so it must be run by someone
    trusted with the music server too.
- Usernames are unique per chat server, case-insensitive (stored lowercase).

### 7.2 Passwords
- scrypt (`node:crypto.scrypt`), N = 2^17, r = 8, p = 1, 16-byte salt, 32-byte key, `maxmem` sized accordingly; parameters are
  stored in the hash and upgraded transparently at the next successful login. Compared with `timingSafeEqual`.
- Hashing runs on libuv's thread pool. Concurrent hashes are capped (semaphore of 4) so login floods cannot exhaust memory
  (about 128 MiB per hash at these parameters). *Ceiling:* the cap queues logins; raise it on hosts with more RAM.
- Policy: 10–256 characters (Unicode allowed, NFC-normalised before hashing), rejected if equal to the username. No
  composition rules.
- Login failure: always `401 invalid_credentials`. When the username does not exist, a dummy hash is still computed so timing
  does not reveal which usernames exist.

### 7.3 Sessions and tokens
- Token: 32 random bytes, base64url, prefixed `ac1_` (lets secret scanners recognise leaks). Only `SHA-256(token)` is stored.
- Expiry: idle 30 days (`last_used_at` is refreshed at most once per hour to limit writes), absolute 180 days. Both are configurable.
- Logout, revoke, password change (other sessions), admin disable (all sessions) take effect on the **next request** (every
  authenticated request looks up the session; there is no stateless JWT) and **immediately** on WebSockets (the hub closes the
  matching sockets with 4401).

### 7.4 Registration controls
`CHAT_REGISTRATION` = `closed` (default) | `invite` | `open`.
- `closed`: accounts come only from the CLI (`cli.ts create-user`) or an admin.
- `invite`: `inviteCode` required; codes are single- or multi-use with expiry; only their hash is stored.
- `open`: anyone who can reach the server can register. Allowed, but `config.ts` logs a warning at startup when it is combined
  with a public origin.
- The first admin comes from `docker compose run --rm chat node src/cli.ts create-admin <username>`, which reads the password
  from stdin, so it never appears in shell history or the process list.

### 7.5 Authorization rules (enforced server-side, in one module: `conversations/permissions.ts`)
| Action | DM | Group |
|---|---|---|
| Read conversation / history / receive events | either member | any current member (`left_at IS NULL`) |
| Send | either member, and neither user is disabled | any current member |
| Rename | – | owner, admin |
| Add members | – | owner, admin |
| Remove member | – | owner, admin (not the owner); anyone may remove themself |
| Delete message | sender | sender, owner, admin |
| Typing / read receipts | members only | members only |

Non-members get **404**, not 403. Every handler that takes a `conversationId` calls the same `requireMember()` before doing
anything else. A test lists every such route and asserts this (§13.2).

**WebSocket subscription authorization:** clients do not subscribe to conversations at all. The server decides recipients
at fan-out time from the database (`current members of conversation X`). Client-originated frames that name a conversation
(`typing`) are checked against membership (cached per socket for 60 s and invalidated on `member.removed`).

### 7.6 Transport, CORS and CSRF
- **TLS:** handled by the edge (Tailscale Serve, Cloudflare, Caddy). The chat container speaks plain HTTP on its internal port.
  Plain HTTP is accepted only for LAN use by native clients (§9.1), and only after the user explicitly opts in on the client.
- **CORS:** exact-origin allow-list `CHAT_ALLOWED_ORIGINS` (same model as `AURALIS_ALLOWED_ORIGINS` in `server/spicy.mjs`),
  `Vary: Origin`, allowed headers `authorization, content-type`, **no** `Access-Control-Allow-Credentials`. `*` is rejected at
  startup.
- **CSRF:** not applicable to the API, because authentication is a bearer header that browsers never attach automatically.
  This is a deliberate consequence of avoiding cookies. If cookies are ever added (e.g. for a hosted web build), CSRF tokens
  plus `SameSite=Strict` become mandatory.
- **Security headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on
  authenticated responses. HSTS is set at the TLS edge for the public domain only.
- **Client address:** taken from the socket, unless `CHAT_TRUST_PROXY=1`, which is valid only when the port is bound to
  loopback behind a proxy you control. In that case it uses `CF-Connecting-IP` or the **last** `X-Forwarded-For` hop, exactly
  as `server/spicy.mjs` does. `config.ts` refuses to start with `CHAT_TRUST_PROXY=1` and a non-loopback bind address.

### 7.7 Rate limiting and abuse prevention
| Scope | Limit (defaults, configurable) |
|---|---|
| Login per IP | 10 / 5 min |
| Login failures per username | 5 / 15 min, then 15 min lockout of that username from that IP **and** a global per-username slowdown |
| Register per IP | 5 / hour |
| Send message per user | 30 / 10 s burst, 600 / hour |
| User search per user | 30 / min |
| Other authenticated REST per user | 300 / min |
| WS inbound frames per socket | 20 / 10 s, then close 4429 |
| WS sockets per user | 10 |

`@fastify/rate-limit` uses its in-memory store. That is correct for one process. *Ceiling:* the counters reset on restart;
switch to a Postgres-backed store only if that becomes a real problem. Other abuse controls: admin disable/enable user;
group size cap (`CHAT_MAX_GROUP_MEMBERS`, default 64); message length 4000 characters; user search returns only exact-prefix
matches on usernames, so the directory cannot be scraped cheaply. Blocking other users is a v1.x candidate.

### 7.8 Input validation and output safety
- Every route has a TypeBox schema with `additionalProperties: false`; strings have `maxLength`; UUIDs are format-checked.
- Message bodies: NFC-normalised, trimmed, 1–4000 characters, control characters except `\n` and `\t` stripped, a cap on
  consecutive newlines. They are stored and returned as **plain text**. Clients render them as text nodes only, as the
  existing UI already does for lyrics and Subsonic chat. No HTML or Markdown rendering in v1.

### 7.9 Safe logging
- pino `redact`: `req.headers.authorization`, `*.password`, `*.newPassword`, `*.currentPassword`, `*.token`, `*.inviteCode`.
- **Message bodies are never logged**, at any level. Logs carry ids, sizes and error codes only.
- The URL is logged without its query string (`/api/v1/users/search` without `q`).
- `server/chat/tests/integration/logging.test.ts` captures log output during a scripted session and asserts that no token,
  password, invite code or message body appears.

### 7.10 Hard rules (reviewers reject a change that breaks one)
1. **No hardcoded secrets.** Database password via a Docker secret file, everything else from env. `.env` and `secrets/` are
   git-ignored. CI runs a secret scan over `server/chat`.
2. **No permissive production CORS.** `*`, `null`, or reflecting arbitrary origins is a startup error.
3. **Never disable certificate validation** in any client or test (`rejectUnauthorized: false`,
   `NODE_TLS_REJECT_UNAUTHORIZED=0`, `NSAllowsArbitraryLoads` used as a TLS workaround, custom trust-all `TrustManager`s).
4. **No unauthorized conversation access.** Every conversation-scoped handler goes through `requireMember()`, enforced by the
   route-inventory test.
5. **PostgreSQL is never published.** The `db` service has no `ports:`; a Compose lint test asserts it.
6. **No tokens in URLs or logs.**

---

## 8. Docker Compose deployment architecture [Proposed]

### 8.1 Dockerfile (`server/chat/Dockerfile`, build context `server/chat/`)

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/healthz || exit 1
CMD ["node", "src/main.ts"]
```

Image tags follow the git tag (`auralis-chat:0.3.0`). The base image is pinned by digest in the release build [Decision].
The image contains no `.env`, no tests and no dev dependencies.

### 8.2 Compose (`server/chat/compose.yaml`, project name `auralis-chat`)

```yaml
name: auralis-chat
services:
  db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: chat
      POSTGRES_USER: chat
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
    volumes: [db-data:/var/lib/postgresql]        # PG18 image layout; see §8.3
    networks: [internal]
    # no `ports:`, ever
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U chat -d chat"]
      interval: 5s
      timeout: 3s
      retries: 20
    stop_grace_period: 30s
    shm_size: 128mb

  migrate:
    image: auralis-chat:${CHAT_VERSION:-local}
    build: .
    command: ["node", "src/migrate.ts"]
    env_file: .env
    secrets: [db_password]
    networks: [internal]
    depends_on: { db: { condition: service_healthy } }
    restart: "no"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]

  chat:
    image: auralis-chat:${CHAT_VERSION:-local}
    restart: unless-stopped
    env_file: .env
    secrets: [db_password]
    networks: [internal, edge]
    ports: ["${CHAT_BIND_ADDRESS:-127.0.0.1}:${CHAT_PORT:-8790}:8790"]
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    init: true                       # tini as PID 1: signals reach node, zombies are reaped
    stop_grace_period: 20s
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    logging: { driver: local, options: { max-size: "10m", max-file: "5" } }

networks:
  internal: { internal: true }       # db + app only; no route out
  edge: {}                           # the app's published port

volumes:
  db-data: {}

secrets:
  db_password: { file: ./secrets/db_password }
```

- The Compose project (`auralis-chat`) is separate from the root `docker-compose.yml` (lyrics). `docker compose down` in one
  directory never touches the other.
- `db` stays at the image's default privileges (the entrypoint needs to `chown` the data directory). It is unreachable
  from outside the `internal` network.
- `migrate` runs to completion before `chat` starts. Kysely's `Migrator` takes a lock, so a second concurrent run waits
  instead of racing. The app's `/readyz` also checks that the newest migration is applied, so an image that is newer than
  its schema reports itself not ready instead of serving.

### 8.3 PostgreSQL persistence
- Named volume `db-data`. [Assumption] The PostgreSQL 18 official image expects the mount at `/var/lib/postgresql` (data in a
  versioned subdirectory); PG ≤ 17 images used `/var/lib/postgresql/data`. Confirm against the image documentation when
  pinning the version, because a wrong mount point means data is written to an anonymous volume and **lost on recreate**.
- Persistence verification (scripted in `scripts/smoke.sh`, run in CI and before every upgrade):
  1. `up -d --wait`, create a user via the CLI, log in, send a message.
  2. `docker compose down` (**no `-v`**) → `up -d --wait` → message still listed.
  3. `docker compose up -d --force-recreate --wait` → still listed.
  4. `docker volume inspect auralis-chat_db-data` shows the volume; `docker compose exec db psql -U chat -c "select count(*) from messages"` agrees.
  5. Check that no anonymous volume was created (`docker volume ls -f dangling=true` is unchanged), which catches a wrong
     mount point.

### 8.4 Environment (`server/chat/.env.example`, proposed content)

```sh
# Copy to .env (git-ignored). No secrets in this file: the DB password lives in ./secrets/db_password (chmod 600).
CHAT_SERVER_NAME=Auralis Chat
CHAT_BIND_ADDRESS=127.0.0.1          # 127.0.0.1 (Tailscale Serve / tunnel / Caddy), or the LAN IP for direct LAN access
CHAT_PORT=8790
CHAT_REGISTRATION=closed             # closed | invite | open
# Exact origins (never *) of browser/webview clients. Native apps send no Origin and are unaffected.
CHAT_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost
CHAT_TRUST_PROXY=0                   # 1 only when bound to 127.0.0.1 behind a proxy you control
CHAT_LOG_LEVEL=info
CHAT_SESSION_IDLE_DAYS=30
CHAT_SESSION_MAX_DAYS=180
CHAT_MAX_MESSAGE_CHARS=4000
CHAT_MAX_GROUP_MEMBERS=64
CHAT_MAX_SOCKETS_PER_USER=10
DATABASE_HOST=db
DATABASE_NAME=chat
DATABASE_USER=chat
DATABASE_PASSWORD_FILE=/run/secrets/db_password
```

`config.ts` validates every value at startup and exits non-zero with a clear message on: an unknown key with a `CHAT_` prefix
(catches typos), `*` in origins, `CHAT_TRUST_PROXY=1` with a non-loopback bind, or a missing or empty password file.

### 8.5 Graceful shutdown
On `SIGTERM`/`SIGINT`: (1) `/readyz` → 503, stop accepting new connections; (2) send close `1001 "server restarting"` to all
sockets, which makes clients reconnect with backoff; (3) `fastify.close()` waits for in-flight requests (bounded at 10 s);
(4) close the pg pool; (5) exit 0. A second signal, or 15 s elapsed, forces exit 1. `stop_grace_period: 20s` leaves headroom.

### 8.6 Eventual operator commands (documented here; not run)

```sh
cd server/chat
install -d -m 700 secrets && openssl rand -base64 32 > secrets/db_password && chmod 600 secrets/db_password
cp .env.example .env && $EDITOR .env
docker compose build                                   # build the image
docker compose up -d --wait                            # start db → migrate → chat, wait for healthy
docker compose run --rm chat node src/cli.ts create-admin folke
docker compose ps                                      # status + health
docker compose logs -f --tail=100 chat                 # logs (no tokens, no message bodies)
curl -fsS http://127.0.0.1:8790/readyz                 # readiness
curl -fsS http://127.0.0.1:8790/api/v1/server-info     # instance id, registration mode
./scripts/smoke.sh                                     # end-to-end + persistence check
docker compose stop                                    # stop, keep containers
docker compose down                                    # remove containers, KEEP data
# docker compose down -v                               # DESTROYS the database volume; never in routine use
```

---

## 9. LAN, Tailscale and public-domain networking [Proposed]

One installation, one database, one `instanceId`. The three methods are just three **addresses** for the same process.

### 9.1 Local Wi-Fi

- **Address:** `http://<LAN-IP>:8790` (e.g. `http://192.168.1.20:8790`) or a local DNS name (`http://alwaysonpc.local:8790`
  via mDNS/Avahi, or a router DNS entry).
- **Server config:** `CHAT_BIND_ADDRESS=<LAN-IP>`, or `0.0.0.0` to also keep loopback. Binding a specific IP fails to start
  if that IP is not configured yet, which is safer than silently binding everything.
- **DHCP:** reserve the host's IP on the router (DHCP static lease), otherwise saved client URLs break when the lease changes.
  Clients still recognise the server via `instanceId`, but they cannot reach it at the old IP.
- **mDNS:** Arch needs `avahi` + `nss-mdns`. Resolution of `.local` names on Android and inside webviews is inconsistent
  [Assumption]; prefer the reserved IP or a router DNS name for phones.
- **Firewall:** allow `8790/tcp` from the LAN subnet only (firewalld zone `home`, or nftables/ufw rule). **Gotcha:** Docker
  publishes ports with its own iptables/nftables rules that are evaluated **before** ufw/firewalld INPUT rules, so a host
  firewall rule often does *not* restrict a published port. Restrict exposure with `CHAT_BIND_ADDRESS` first. If
  subnet-level filtering is required, add it to the `DOCKER-USER` chain. Verify from another device, never assume.
- **HTTP vs HTTPS on LAN:** plain HTTP is unencrypted on the Wi-Fi network. Consequences per client:
  - **Browser (web build served over HTTPS):** cannot use `http://` or `ws://` to a LAN IP (mixed content is blocked). LAN
    access from a browser works only if the web app itself is served over plain HTTP on the LAN (`npm start` on the host), or
    by using the Tailscale or public HTTPS address instead.
  - **Android:** cleartext is allowed (`usesCleartextTraffic="true"` [Verified]); CSP must gain `ws:`.
  - **iOS/macOS:** allowed (`NSAllowsArbitraryLoads` [Verified]).
  - **Tauri desktop:** whether the `tauri://localhost` / `http://tauri.localhost` webview blocks `http:`/`ws:` to LAN hosts is
    **unverified**. `docs/DESKTOP.md` claims an https webview cannot call http servers. Phase 0 must measure this per OS.
  - The client requires an explicit "Allow unencrypted connection on this network" toggle for any non-loopback `http://` URL
    and shows a persistent "Unencrypted" badge (§10.2).
  - Optional, not default: Caddy with a local CA gives LAN HTTPS, but each device must install and trust the root
    certificate, which is error-prone on phones. **Recommended instead: use the Tailscale HTTPS address whenever encryption
    matters.**

### 9.2 Tailscale

- **Server:** `pacman -S tailscale && systemctl enable --now tailscaled && tailscale up`. In the admin console enable
  **MagicDNS** and **HTTPS certificates**. Keep `CHAT_BIND_ADDRESS=127.0.0.1` and publish over the tailnet with
  **Tailscale Serve**:
  `tailscale serve --bg http://127.0.0.1:8790` → `https://<machine>.<tailnet>.ts.net` with a publicly trusted certificate;
  WebSocket upgrades pass through [Assumption: verify exact `serve` syntax for the installed Tailscale version].
  - Benefit: valid HTTPS/WSS on every client, including the HTTPS-served web app, with no port forwarding and no LAN
    exposure.
  - Alternative (not recommended): bind to the Tailscale IP (`100.x.y.z`) and use `http://100.x.y.z:8790`. Traffic is
    encrypted by WireGuard, but browsers still see plain HTTP, and Docker can fail to bind at boot if `tailscaled` is not up yet.
- **Clients:** the Tailscale app on Android/iOS/macOS/Linux/Windows, signed into the same tailnet. The device must be connected
  to Tailscale for that address to resolve.
- **Access restrictions:** tailnet ACL/grants limit who reaches the server, e.g. tag the host `tag:chat` and allow
  `group:family → tag:chat:443` only. Chat accounts remain the second layer; Tailscale is not authentication for the app.
- **Do not use Tailscale Funnel** (that would make it public). The public route is §9.3.
- **Privacy note:** Tailscale HTTPS certificates appear in public Certificate Transparency logs, which reveals the machine and
  tailnet name.
- Since Tailscale Serve is a proxy on the same host: set `CHAT_TRUST_PROXY=1` (loopback bind) if per-client rate limits should
  see real tailnet addresses [Assumption: verify which forwarding headers `serve` sets]; otherwise every request appears to
  come from `127.0.0.1` and IP limits degrade to global limits.

### 9.3 Future public domain: `https://chat.folk3s.com`

**The domain is not created or configured. Nothing here has been done.** Two options:

- **Option A, recommended: Cloudflare Tunnel.** This mirrors the lyrics deployment plan in `docs/BACKEND.md`, which describes
  `lyrics.folk3s.com` on `alwaysonpc` behind a tunnel (that deployment is itself marked as not done) [Assumption:
  `folk3s.com` DNS is managed in Cloudflare].
  1. `CHAT_BIND_ADDRESS=127.0.0.1`, `CHAT_TRUST_PROXY=1`.
  2. Tunnel ingress `hostname: chat.folk3s.com → service: http://127.0.0.1:8790` above the catch-all rule;
     `cloudflared tunnel route dns <tunnel> chat.folk3s.com`.
  3. WebSockets are proxied by Cloudflare. Keep the 25 s heartbeat (idle timeout).
  4. No inbound ports are opened on the router or the host firewall.
  5. Cloudflare SSL mode *Full (strict)* is irrelevant for tunnels (the origin connection is the tunnel). Enable *Always Use
     HTTPS* and HSTS on the hostname once it works.
  6. Optional second layer: a Cloudflare WAF rate-limit rule on `/api/v1/auth/*`.
- **Option B: direct with Caddy.**
  1. DNS `A`/`AAAA` `chat.folk3s.com` → public IP (dynamic DNS if the IP changes).
  2. Router forwards `443/tcp` (and `80/tcp` for ACME HTTP-01) to the host. Host firewall allows exactly those.
  3. Caddy:
     ```caddy
     chat.folk3s.com {
       encode zstd gzip
       header Strict-Transport-Security "max-age=31536000"
       reverse_proxy 127.0.0.1:8790     # Caddy proxies WebSocket upgrades automatically
     }
     ```
  4. `CHAT_TRUST_PROXY=1` and `CHAT_BIND_ADDRESS=127.0.0.1`.
- **Either way, before going public:** `CHAT_REGISTRATION=closed` or `invite`; add the hosted web origin (if any) to
  `CHAT_ALLOWED_ORIGINS`; run the security checklist in §13.4 against the public URL; confirm `/readyz` is fine to expose
  (it reveals nothing beyond up/down).

### 9.4 How the three addresses reach one server without separate accounts

- The server does not care which address was used. Tokens are not bound to a hostname, and CORS is by web origin, not by the
  server's own name.
- Every client stores a chat **profile keyed by `instanceId`** from `/api/v1/server-info`. When the user changes the URL (LAN →
  Tailscale → public), the client fetches `server-info` from the new address:
  - **same `instanceId`** → same server: keep the token, the cache and the read state. Only the address changes. The UI says
    "Same server, new address".
  - **different `instanceId`** → different server: this is a server switch (§10.5).
- Optional v1.x: remember several addresses per instance and fall back automatically (LAN when home, Tailscale away). Not in v1.
  One active URL keeps the state machine simple.

---

## 10. Auralis Settings and client integration [Proposed]

### 10.1 Client modules (in `shared/ui`, respecting the existing layering)

| Layer | Module | Role |
|---|---|---|
| `lib/` | `chatStorage.ts` | IndexedDB database **`auralis-chat`**, separate from `auralis` (`lib/storage.ts`). Stores `config`, `session`, `cache`. |
| `api/chat/` | `url.ts` | URL policy (§10.3). |
| | `client.ts` | `fetch` wrapper: bearer header, timeouts, typed `ChatError`, never includes the token in errors. |
| | `validate.ts` | Validates every server payload, as `api/subsonic/endpoints.ts` does today. Malformed data degrades to an error state, never a crash. |
| | `socket.ts` | Framework-free `ChatSocket` class (like `audio/engine.ts`): connect, first-frame auth, heartbeat watchdog, backoff, event emitter. No React. |
| | `uuid.ts` | `getRandomValues`-based UUID v4 (works without a secure context). |
| `state/` | `chatServer.ts` | Zustand: `{url, instanceId, serverInfo, user, status, error}`, connect/test/sign-in/register/sign-out/switch actions. |
| | `chat.ts` | Conversations, messages per conversation (capped, like `KEEP` in `state/social.ts`), outbox, unread, typing. Fed by the socket and REST. |
| `features/` | `settings/ChatServerSection.tsx` | Settings UI, shared by web and Android (like `LyricsServerForm`). |
| | `social/*` | Conversations from both sources (§10.6). |

### 10.2 Chat Server settings section (web `Settings.tsx` and Android `SettingsPage.tsx`)

States, and what the user can do in each:

| State | UI |
|---|---|
| **Not configured** | URL field, *Test*, *Save*. Hint: "Your chat server is separate from your music server and has its own accounts." |
| **Testing** | Spinner on *Test*. Result: server name, version, registration mode, `Encrypted (HTTPS)` / `Unencrypted` badge, or a specific error. |
| **Saved, signed out** | Server name + URL; *Sign in* form (username, password, "Keep me signed in on this device"); *Create account* only if registration is `open`/`invite` (invite field shown when needed); *Edit address*; *Remove server*. |
| **Signed in** | `Connected` / `Connecting…` / `Reconnecting in 8 s` / `Offline` status with the last error; signed-in user; *Sessions…* (list + revoke); *Sign out*; *Change address*; *Remove server*. |

Connection status and errors are specific. A 401 on login reads "Wrong username or password". Unreachable reads "Couldn't
reach the server. Check the address and that this device is on the same network or Tailscale". Origin rejected reads
"This server doesn't allow this app's origin (ask the admin to add `tauri://localhost` to CHAT_ALLOWED_ORIGINS)". Others:
"TLS certificate not trusted", "Server is starting up (not ready)", "Server is a different version (protocol 2, app supports 1)".
The browser cannot tell CORS failures from network failures (`docs/DESKTOP.md` already notes this), so the message names both
possibilities.

Behaviour:
- *Test* calls `GET /api/v1/server-info` and does not save.
- *Save* validates the URL; when a session exists, it compares the `instanceId` (§9.4).
- *Edit address* with the same `instanceId` keeps the session. With a different one, it starts the switch flow (§10.5) and asks
  for confirmation.
- *Sign out* calls `POST /auth/logout` (best effort), then clears local session + cache. The URL stays.
- *Remove server* = sign out + delete the whole `auralis-chat` database.
- The Subsonic **Connection** section and the **Disconnect** button keep working exactly as now and do **not** affect chat
  ([Decision] §14).

### 10.3 URL policy (`api/chat/url.ts`, distinct from `lib/backend.ts`)
- `https://` always allowed (any host). `wss://` is derived from it.
- `http://` allowed for loopback; and for RFC 1918 (10/8, 172.16/12, 192.168/16), link-local, `*.local`, and Tailscale CGNAT
  `100.64.0.0/10`, **only** with the explicit "Allow unencrypted connection" toggle, and **only** when the page is not itself an
  HTTPS origin (on the hosted web app the toggle is disabled with an explanation).
- Rejected: credentials in the URL, query or fragment, non-HTTP schemes. A path prefix is allowed (reverse proxy under a subpath).
- The existing `checkServerUrl` for the lyrics backend stays unchanged.

### 10.4 Authentication storage per platform
| Platform | Token storage | Notes |
|---|---|---|
| Web | Memory by default. With "Keep me signed in", IndexedDB `auralis-chat`. | Same limitation as the existing Subsonic session (`ARCHITECTURE.md` §6): script running in the page could read it. Better than today's model in two ways: a **revocable token**, not a password, and visible sessions with remote revoke. |
| Tauri (Linux/Windows) | Same as web (webview IndexedDB) in v1. | v1.x: an OS keyring via a Tauri plugin would need a new Rust dependency and capability config; [Decision]. |
| Android (Tauri) | Same as web in v1. | v1.x: Android Keystore via a plugin; [Decision]. |
| iOS/macOS | Keychain, next to the Subsonic password (`shared/apple/AuralisUI/Keychain.swift` pattern, account `chat:<instanceId>`). | URL and `instanceId` in `SettingsStore` (UserDefaults). |

Passwords are never stored by the chat client on any platform. Only tokens are.

### 10.5 Connection lifecycle and server switching

```
idle ─configure→ configured ─signIn→ connecting ─ready→ connected
                                       ↑  │ close 1001/1006/net
                                       │  ▼
                                    reconnecting (backoff, online/visible triggers)
connected/reconnecting ─4401→ signedOut (token dropped; prompt to sign in)
any ─switch server→ teardown → configured(new)
```

- Start the socket only while signed in **and** the app is visible or recently visible. On mobile, background suspension kills
  sockets; on resume the client reconnects and resyncs (§5.5). No push notifications in v1.
- Polling disappears for chat-server conversations; the socket drives updates. The Subsonic room keeps its existing polling.
- **Switch (different `instanceId`)**: close the socket; best-effort logout on the old server; `indexedDB.deleteDatabase('auralis-chat')`;
  reset `state/chat.ts` and `state/chatServer.ts`; remove TanStack queries under `['chat', oldInstanceId]`; then save the new
  config.
- **Untouched by switching or removing a chat server:** the `auralis` IndexedDB database. That means the Subsonic `session`,
  `settings` (theme, EQ, effects, lyrics server URL), the saved queue, the lyrics cache, Spotify links/matches, and the Subsonic
  chat read state (`social:lastRead:*`). There is no download/offline feature today [Verified]; the same rule will apply to one
  if it is ever added. A unit test seeds both databases, performs a switch, and asserts the `auralis` store is byte-for-byte
  unchanged.
- Cache keys always include `instanceId`, so even in a race the old server's data cannot appear under the new one (the same
  guard `state/social.ts` uses with `accountKey`).
- Unlike `state/social.ts`, chat-server state does **not** reset on every Subsonic change. It changes only when the Subsonic *username* changes, by signing out of chat and signing in again as that user (§7.1).

### 10.6 Social UI integration
- `ConversationList` shows **sources**: the chat server's conversations (when signed in), then "Everyone on <music server>"
  (Subsonic room, only when supported, as today).
- Routes: keep `/social/chat/server` for the Subsonic room; add `/social/chat/c/:conversationId` for chat-server conversations,
  on both web (`App.tsx`) and Android (`MobileApp.tsx`, `SocialThreadPage` title becomes the conversation title).
- New: "New message" (user search → DM) and "New group" dialogs; group info sheet (members, rename, leave). Message states:
  sending, sent, failed (with *Retry*), deleted. Typing line (optional phase).
- The existing `ChatUnavailable` empty state gains a call to action: "Set up a chat server in Settings" (instead of only
  saying Navidrome has no chat).
- Chat-server users are **not** merged with Subsonic "People"; usernames on the two servers are unrelated. Profiles for chat
  users are a v1.x candidate.
- The unread badge (`useUnread`) sums both sources.
- **Exception to the "no retries" rule:** `ARCHITECTURE.md` §6 says the HTTP client never retries. The chat outbox retries
  pending sends on reconnect, at most 5 attempts, then marks the message *failed* with a manual retry. This is safe only because
  sends are idempotent (`clientMessageId`). Document it in `ARCHITECTURE.md` when implemented.
- **Durable outbox:** with "Keep me signed in" the outbox is written to `auralis-chat` key `outbox` and restored on the next
  start (entries that were in flight become *waiting* and are resent; idempotency prevents duplicates). It is never restored
  for another account, never written for a session that is not remembered, and is deleted on sign-out, 4401 and server switch.

---

## 11. Platform-specific considerations

| Platform | What must change / be checked | Phase |
|---|---|---|
| **Web** (`web/`) | Hosted over HTTPS ⇒ only `https`/`wss` chat URLs (mixed content). The web origin must be in `CHAT_ALLOWED_ORIGINS`. Dev: Vite on `http://localhost:5173` talks to a local chat server on `http://127.0.0.1:8790` (allowed origin in dev `.env`). | 8–10 |
| **Tauri desktop** (`tauri/`) | Add `ws: wss:` to `connect-src` in `tauri/tauri.conf.json`. Allowed origins `tauri://localhost` (Linux), `http://tauri.localhost` (Windows) per `docs/DESKTOP.md`. **Measure** whether `http:`/`ws:` to LAN works in WebKitGTK and WebView2 (Phase 0). Fix the stale CSP note in `docs/DESKTOP.md`. | 0, 9 |
| **Android** (`android/`) | Add `ws: wss:` to `android/tauri.conf.json` CSP. Cleartext is already allowed. Origin of the Android webview: [Assumption] `http://tauri.localhost`; verify on a device and add to the allow-list. Backgrounding closes sockets, so resync on resume (`visibilitychange`). Phone UI wrappers in `android/frontend/mobile/pages.tsx`. Not run on a device so far in this repo's history (`docs/PLATFORMS.md`), so plan a device test. | 0, 9, 10 |
| **iOS** (`ios/`, `shared/apple`) | Native Swift client: `URLSession` for REST, `URLSessionWebSocketTask` for WS (first-frame auth identical), token in Keychain, `ChatServerSection` in `SettingsView.swift`, Social views (none exist on Apple today). The `scenePhase` change to background closes the socket; resync on active. ATS is wide open now (`NSAllowsArbitraryLoads`). The chat client must not rely on it for HTTPS hosts. Protocol types are duplicated in Swift (`AuralisKit/Chat*.swift`) with JSON fixture tests shared from `shared/chat-protocol/fixtures/*.json`. | 12 |
| **macOS** (`macos/`) | Same Swift code via `AuralisUI`. Sidebar gains Social → Chat. Sandboxed builds need `com.apple.security.network.client` (check the generated entitlements). | 12 |
| **Linux/Windows release builds** | No new Rust code in v1 (no keyring plugin). `release-windows.yml` unaffected except for the CSP change. | 9 |

Apple work depends on a Mac with Xcode 26 (`docs/APPLE.md`). CI can build it, but not run it against a server.

---

## 12. Phased implementation checklist

Phases are sequential unless marked parallel. **Gate** = what must be verified before the next phase starts. Every phase
also updates the docs it affects and keeps `npm run typecheck`, `npm run lint` and `npm test` green.

### Phase 0 — Decisions and platform connectivity spike
- **Scope:** resolve the open decisions in §14 (record the outcome in this file). A throwaway spike, **not merged**: a 20-line
  WebSocket echo server, opened from the web dev server, Tauri Linux (WebKitGTK), Windows (WebView2) if available, an Android
  device, and iOS/macOS if a Mac is available, over `ws://<LAN-IP>`, `wss://<tailnet>.ts.net` (Tailscale Serve) and
  `ws://127.0.0.1`. Record the actual webview origins.
- **Dependencies:** none.
- **Acceptance:** a connectivity matrix (platform × address × works/blocked + reason) is added to §9; `instanceId` approach
  and URL policy confirmed or adjusted.
- **Tests:** manual; results recorded.
- **Gate:** every platform in scope for v1 has at least one working secure address (Tailscale HTTPS expected).

### Phase 1 — Server skeleton, container, CI
- **Scope:** `server/chat` package; `config.ts` with validation; `buildApp`; `/healthz`, `/readyz`, `/api/v1/server-info`; pino
  with redaction; graceful shutdown; Kysely + `pg`; migration `0001` creates `server_meta` with `instance_id`; `migrate.ts`;
  `Dockerfile`; `compose.yaml`; `.env.example`; `scripts/smoke.sh` (health + persistence of `instance_id`); root `.dockerignore`,
  `.gitignore`, `check-boundaries.mjs`, root scripts; CI job `chat-server`.
- **Dependencies:** Phase 0.
- **Acceptance:** `docker compose up -d --wait` from a clean checkout reaches healthy; `instanceId` survives `down`/`up` and
  `--force-recreate`; `db` has no published port; image runs as `node`, read-only; SIGTERM exits 0 within 20 s; the lyrics
  image (`docker build .` at root) does not contain `server/chat`.
- **Tests:** unit `config` (each refusal case); integration `/readyz` 503 before migration and 200 after; shutdown test (in-flight
  request completes, new ones refused); Compose lint test (no `ports` on `db`, `read_only`, `cap_drop`); CI smoke run.
- **Gate:** CI green including the Docker smoke job.

### Phase 2 — Accounts, sessions, registration controls
- **Scope:** migration `0002` (`users`, `sessions`, `invites`); scrypt hashing; tokens; register/login/logout/me/sessions/revoke/
  password-change; registration modes; invites; admin CLI (`create-admin`, `create-user`, `reset-password`, `disable-user`,
  `create-invite`, `revoke-sessions`); auth guard; login throttling and rate limits on auth routes; CORS.
- **Dependencies:** Phase 1.
- **Acceptance:** all auth endpoints behave per §5.2/§7; revoked or expired tokens get 401 on the next request; `closed` mode
  rejects registration; invite codes are enforced and exhausted correctly; logs contain no secrets.
- **Tests:** unit hashing (round trip, parameter upgrade, timing-safe compare, dummy hash on unknown user), token format/hash;
  integration for every endpoint incl. 400/401/409/429 paths; brute-force throttle test; CORS allow/deny incl. `*` refusal;
  log-redaction test; CLI test via `node src/cli.ts` against the test DB.
- **Gate:** security review of auth (checklist §13.4 items 1–6) signed off.

### Phase 3 — Conversations and membership
- **Scope:** migration `0003` (`conversations`, `conversation_members`); DM create (idempotent), group create, get, list,
  rename, add/remove/leave, roles; `permissions.ts` + `requireMember()`; user search.
- **Dependencies:** Phase 2.
- **Acceptance:** permission table §7.5 holds for every action; concurrent DM creation yields one conversation; non-members get 404.
- **Tests:** unit `permissions` (table-driven over role × action × kind); integration for each endpoint, a **route inventory test**
  (enumerates Fastify routes with `:id` and asserts each 404s for a non-member), a DM race test (20 parallel creates → 1 row),
  disabled-user behaviour.
- **Gate:** route inventory test present and green.

### Phase 4 — Messages, history, read state
- **Scope:** migration `0004` (`messages`); send (transactional `seq`, idempotency), paginate (`beforeSeq`/`afterSeq`), read
  pointer, unread counts in the conversation list, soft delete, body sanitising.
- **Dependencies:** Phase 3.
- **Acceptance:** `seq` is gap-free and strictly increasing under 50 concurrent senders; a retried `clientMessageId` returns the
  same message and does not consume a `seq`; pagination returns each message exactly once across pages; deleted messages
  return no body.
- **Tests:** integration concurrency test (parallel sends, assert `seq` = 1..N); idempotency test; pagination property test
  (random page sizes reconstruct the full history); limits (4000/4001 characters, control characters); read pointer never decreases.
- **Gate:** concurrency and idempotency tests green 20 runs in a row (no flakiness).

### Phase 5 — Real-time delivery
- **Scope:** `/api/v1/ws`, Origin check, first-frame auth, hub, fan-out after commit, all §5.4 events except presence/typing,
  heartbeats, limits, backpressure, session revocation and user disable closing sockets, membership changes stopping delivery,
  shutdown close 1001.
- **Dependencies:** Phase 4.
- **Acceptance:** a message sent by A reaches every connected session of every member within 1 s on localhost and never reaches
  a non-member; revoke closes the right sockets within 1 s; a disallowed Origin gets 403; no token in the URL is accepted.
- **Tests:** integration with real `ws` clients: delivery to multiple sessions, non-member gets nothing (wait window),
  removed-member stops receiving, auth timeout 4408, bad token 4401, revoked mid-connection 4401, oversized frame 1009,
  frame flood 4429, socket cap, slow-consumer close, server shutdown 1001, reconnect-and-resync scenario (send while
  disconnected, reconnect, fetch `afterSeq`, no duplicates).
- **Gate:** all socket security tests green; a manual soak (two clients, 30 min, server restarts) shows no lost or duplicated
  messages.

### Phase 6 — Presence and typing (optional; can be skipped without blocking later phases)
- **Scope:** `typing` C→S/S→C with throttle and 5 s expiry; presence (online when ≥ 1 socket), visible only to users sharing a
  conversation, with a user setting to hide it.
- **Dependencies:** Phase 5.
- **Acceptance / Tests:** a non-member never receives typing or presence for others; throttling enforced; presence clears
  ≤ 35 s after the last socket drops.
- **Gate:** none beyond tests.

### Phase 7 — Server hardening and operations
- **Scope:** rate-limit review across all routes; `scripts/backup.sh` / `restore.sh`; deleted-message scrub job (chunked,
  bounded, per `.claude/rules/backend-micronaut/BATCH_PROCESSING.md`'s guards); session expiry cleanup; upgrade/rollback
  rehearsal; `server/chat/README.md` runbook; the security test suite (§13.4) completed.
- **Dependencies:** Phases 2–5 (6 if built).
- **Acceptance:** backup → wipe → restore reproduces users, conversations, messages and `instanceId`; an upgrade from the
  previous tag with one new migration succeeds with clients reconnecting; rollback procedure executed once and documented.
- **Tests:** restore test in CI (dump, new volume, restore, compare row counts and a checksum of message ids); DB outage test
  (stop `db`: `/readyz` 503, REST 503, sockets stay, recovery after `db` returns without restarting `chat`).
- **Gate:** the server is feature-complete for v1 and passes §13.4 in full. The client may start before this (in parallel
  with Phase 7), but no release before it.

### Phase 8 — Shared client core (`shared/ui`)
- **Scope:** `shared/chat-protocol`, `api/chat/*`, `state/chatServer.ts`, `state/chat.ts`, `lib/chatStorage.ts`, URL policy,
  outbox, reconnect, resync, server switching.
- **Dependencies:** Phase 5 protocol frozen (version 1).
- **Acceptance:** the state machine in §10.5 is implemented; switching servers leaves the `auralis` DB untouched; malformed
  server payloads cannot crash the store.
- **Tests:** unit URL policy (table of allowed/rejected URLs), backoff math, outbox (retry, idempotent replacement, failure
  after 5), resync gap logic, de-duplication; integration with **MSW** HTTP + MSW `ws` links (repo already uses MSW 2.15) for
  sign-in, live message, reconnect, 4401 sign-out, server switch isolation test (§10.5).
- **Gate:** `npm test -w @auralis/ui` green at the existing 2-worker cap; boundary check passes.

### Phase 9 — Settings UI and platform configuration
- **Scope:** `ChatServerSection` in web and Android settings; CSP `ws: wss:` in both `tauri.conf.json`; dev `.env` origins;
  docs (`DESKTOP.md` CSP correction).
- **Dependencies:** Phase 8.
- **Acceptance:** every state in §10.2 is reachable and readable; keyboard and screen-reader accessible (axe check, as the existing
  `web/e2e/a11y.spec.ts` does); destructive actions use `ConfirmDialog`.
- **Tests:** component tests for each state and error message; e2e: configure → test → sign in → sign out → remove, against a
  real chat server started by Playwright's `webServer`; Android e2e preview (`android/e2e/`) for the phone layout.
- **Gate:** e2e green in CI; Tauri Linux build (`cargo check` job) still green.

### Phase 10 — Social integration
- **Scope:** conversation sources, new routes, new-DM/new-group dialogs, group info, message states, unread sum, empty-state
  call to action, Android pages.
- **Dependencies:** Phase 9.
- **Acceptance:** two users exchange DMs and group messages in real time across two browser contexts; Subsonic room behaviour
  unchanged (existing `social` tests untouched and green).
- **Tests:** `web/e2e/chat.spec.ts` (two contexts: DM, group, offline-then-reconnect, failed send and retry, non-member cannot
  open a conversation URL); updated `android/e2e/social.spec.ts`; existing `web/e2e/social.spec.ts` still passes.
- **Gate:** full CI green; manual run on a real Android device over Tailscale.

### Phase 11 — Network rollouts (operator work, documented and verified)
- **Scope:** LAN runbook (§9.1), Tailscale runbook (§9.2) on the real host; public domain (§9.3) only when the owner decides.
- **Dependencies:** Phases 7 and 10.
- **Acceptance:** one account, one conversation, visible and live from LAN, Tailscale and (if enabled) public addresses; switching
  the address in Settings keeps the session (same `instanceId`).
- **Tests:** §13.5 network checklist executed and results recorded.
- **Gate:** public exposure only after §13.4 is re-run against the public URL.

### Phase 12 — Apple clients (parallel with 11, needs a Mac)
- **Scope:** Swift chat client in `AuralisKit`, Keychain token, settings section and Social/Chat views in `AuralisUI`.
- **Dependencies:** Phase 5 protocol; fixtures from Phase 8.
- **Acceptance:** same behaviours as §10 on iOS and macOS.
- **Tests:** `swift test` against shared JSON fixtures (decoding, event handling, backoff); manual run on device/simulator.
- **Gate:** CI `macos` and `ios` jobs green.

### Phase 13 — Release
- **Scope:** version bump across manifests (per `docs/STRUCTURE.md`), changelog, image tag, docs final pass.
- **Acceptance:** §16 definition of done.

---

## 13. Acceptance criteria and test strategy

### 13.1 Test layers
| Layer | Tool | Where | Runs in |
|---|---|---|---|
| Server unit | Vitest | `server/chat/tests/unit` | CI `chat-server` job |
| Server integration (HTTP + WS + real Postgres) | Vitest + `fastify.inject` + `ws` + Testcontainers | `server/chat/tests/integration` | CI (Docker available on `ubuntu-latest`) and locally |
| Container smoke + persistence | `scripts/smoke.sh` | `server/chat/scripts` | CI `chat-server` job |
| Client unit/integration | Vitest + Testing Library + MSW (HTTP + `ws`) | `shared/ui/tests/{unit,integration}/chat-*` | CI `web` job |
| E2E | Playwright, two browser contexts, real chat server + Postgres via Compose | `web/e2e/chat.spec.ts`, `android/e2e/` | CI `web` job (Chromium) |
| Swift | `swift test` with shared fixtures | `shared/apple/AuralisKit/Tests` | CI `macos` job |
| Manual | checklists §13.4–13.5 | recorded in `TESTING.md` | before release |

Integration tests use a fresh database per test file (template database clone) so they can run in parallel without shared
state.

### 13.2 Security controls → tests
| Control | Test |
|---|---|
| Authentication required | Route inventory: every `/api/v1/*` route except the public list returns 401 without a token. |
| Conversation membership | Route inventory: every conversation-scoped route returns 404 for an authenticated non-member; history and sends included. |
| WebSocket subscription authorization | A non-member socket receives nothing within a 2 s window while members receive the message; a removed member stops receiving. |
| Password hashing | Stored hash is scrypt with expected params; never equals the password; login with a wrong password fails in roughly the same time for existing and non-existing users (statistical bound, not exact). |
| Session revocation | logout, revoke-one, revoke-others, password change and admin disable each: next REST call → 401, and open sockets close with 4401 within 1 s. |
| Rate limiting | Each limit in §7.7 hit in a test and answered 429 with `Retry-After`; WS flood → 4429. |
| Input validation | Schema fuzz: extra properties, wrong types, oversize strings, invalid UUIDs → 400 with no stack trace in the body. |
| CORS | Allowed origin → header echoed + `Vary: Origin`; other origin → no header; `*` in config → startup failure. |
| CSRF | No cookies set by any endpoint (asserted across all responses). |
| Secure transport | Client URL-policy table test; no code path sets `rejectUnauthorized: false` (lint grep in CI). |
| Message size | 4000 characters accepted, 4001 → 400; 32 KiB body limit → 413; WS frame > 16 KiB → 1009. |
| Safe logging | Captured logs from a scripted session contain no token, password, invite code or message body. |
| Database isolation | Compose lint: `db` has no `ports`; `internal` network is `internal: true`. Manual: `nc -zv <host> 5432` fails from another machine. |
| Failure recovery | DB stopped → `/readyz` 503, REST 503 `service_unavailable`, no crash; DB back → recovers without a restart. Process killed mid-send → message either fully committed or absent (no `seq` gap visible to readers). |
| URL configuration & switching | Client tests: same-`instanceId` address change keeps the session; different instance clears only `auralis-chat`; `auralis` DB unchanged. |
| Docker health & persistence | `smoke.sh`: healthy states, data survives `down`/`up`/`--force-recreate`, no anonymous volumes. |
| End-to-end messaging | `web/e2e/chat.spec.ts`: DM + group live delivery, offline send then reconnect, failed send and retry, no duplicates. |

### 13.3 Non-functional targets (single small host)
- p95 send → delivered to another connected client ≤ 300 ms on LAN.
- 200 concurrent sockets and 20 messages/s sustained without errors (a load script in `server/chat/scripts/load.ts`; run
  before release, not in CI).
- Idle memory of the `chat` container ≤ 150 MiB.

### 13.4 Pre-exposure security checklist (manual, recorded)
1. Registration mode is `closed` or `invite`.
2. `CHAT_ALLOWED_ORIGINS` lists only real client origins.
3. `CHAT_TRUST_PROXY=1` only with a loopback bind.
4. `secrets/db_password` is mode 600 and not in git (`git check-ignore`).
5. `db` unreachable from another machine.
6. Brute-force: 20 bad logins from one IP → 429s.
7. TLS: valid certificate, HSTS present (public), `wss://` works through the edge.
8. Logs reviewed after a test session: no secrets, no message text.
9. Backup taken and a restore rehearsed within the last 7 days.

### 13.5 Network checklist (per address: LAN, Tailscale, public)
`/readyz` reachable from a client device; *Test* in Settings shows the right server name and `instanceId`; sign in; send and
receive live with a second device on a *different* address; switch address in Settings without signing out; kill Wi-Fi for
30 s and confirm reconnect + resync with no duplicates.

---

## 14. Risks, dependencies, assumptions, and unresolved decisions

### Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Tauri webviews block `http:`/`ws:` to LAN, or need origins we have not seen | LAN unusable on desktop/Android | Phase 0 spike; Tailscale HTTPS as the recommended path. |
| CSP lacks `ws:`/`wss:` [Verified] | WebSockets fail in Tauri shells | Phase 9 change, covered by e2e on the built Tauri frontend. |
| Docker bypasses host firewall rules | LAN or public over-exposure | Bind address as the primary control; `DOCKER-USER` rules; verify from another device. |
| Wrong PostgreSQL volume path for the chosen major version | Data loss on recreate | `smoke.sh` persistence + anonymous-volume check before any real data. |
| Mobile background kills sockets; no push | Messages seen late | Resync on resume; push is explicit future work. |
| Token in webview IndexedDB readable by injected script | Account takeover on XSS | Strict CSP (already `script-src 'self'`), plain-text rendering, revocable sessions, memory-only default; OS keystore later. |
| Operator can read all messages | Privacy expectation mismatch | Say so in the Settings hint and docs; E2EE is future work. |
| Single process, in-memory rate limits and hub | Restart drops sockets and resets counters | Clients reconnect and resync; acceptable for one server. |
| scrypt memory per hash | Memory spikes under login floods | Concurrency cap + login rate limits. |
| Scope creep from the existing Social UI (profiles, people) | Delays v1 | Non-goals list; chat users not merged with Subsonic people. |

### External dependencies
Node 24 LTS, PostgreSQL 18 image, Fastify 5 ecosystem, Kysely, `pg`, Testcontainers (Docker in CI), Tailscale (for the tailnet
route), Cloudflare or Caddy (public route), a Mac with Xcode 26 (Apple phase), an Android device (device verification).

### Assumptions (verify; each is tagged where used)
- Node 24 is in LTS at implementation time; Node's type stripping supports everything used (erasable syntax only).
- The PostgreSQL 18 image's data directory layout (§8.3).
- Tauri 2 Android webview origin is `http://tauri.localhost`.
- Tailscale `serve` syntax and forwarded headers for the installed version.
- `folk3s.com` DNS is on Cloudflare and `alwaysonpc` is the target host (inferred from `docs/BACKEND.md`).
- Cloudflare's WebSocket idle timeout (~100 s) is covered by a 25 s heartbeat.

### Unresolved decisions (defaults in **bold**; record the outcome in Phase 0)
1. **Password hashing:** **scrypt (stdlib)** vs Argon2id via `@node-rs/argon2` (OWASP's first choice, adds a native-prebuilt dependency).
2. **Foreign keys:** **use them** (departs from `.claude/rules/database/SCHEMA.md`, reasons in §6.4) vs application-only integrity.
3. **JSON casing:** **camelCase** vs snake_case (the `.claude` naming rule, written for Micronaut).
4. **Path parameters:** **allowed** (Fastify) vs the `.claude` RPC/query-param style.
5. **Group history for new members:** **full history** vs only messages after joining (would add `visible_from_seq` to members).
6. **Deleted-message retention:** **scrub body after 30 days** vs immediately vs never.
7. **Does Subsonic "Disconnect" also sign out of chat?** **No** (independent identities) vs yes (one "sign out of everything").
8. **Token storage on Tauri/Android:** **IndexedDB in v1** vs adding a keyring/Keystore plugin now.
9. **UUID generation:** **`gen_random_uuid()`** vs `uuidv7()` (PG18).
10. **Image pinning:** **tag + digest in release builds** vs tag only.
11. **Public route:** **Cloudflare Tunnel** vs direct Caddy.
12. **Location:** **`server/chat/` standalone package** (as requested) vs a top-level `chat-server/`. The latter avoids the
    `.dockerignore`/boundary-script adjustments but departs from the requested layout.

---

## 15. Deployment, backup, upgrade, and recovery procedures [Proposed]

All commands run in `server/chat/` on the host. None have been run.

### 15.1 First deployment
1. Install Docker + Compose v2 (`docker compose version`).
2. `git clone` (or `rsync` only `server/chat/`). Create `secrets/db_password` (mode 600) and `.env` from `.env.example`.
3. `docker compose up -d --wait` → `docker compose ps` shows `db` healthy, `migrate` exited 0, `chat` healthy.
4. `docker compose run --rm chat node src/cli.ts create-admin <name>`.
5. `./scripts/smoke.sh` (creates and removes a throwaway test user, verifies persistence).
6. Pick and configure the network route (§9). Add client origins to `.env`, then `docker compose up -d`.

### 15.2 Backup
- Logical backup (consistent, portable across PostgreSQL patch versions):
  `docker compose exec -T db pg_dump -U chat -d chat -Fc > backups/chat-$(date -u +%Y%m%dT%H%M%SZ).dump`
- `scripts/backup.sh` wraps this. It writes to a temp file and renames it only on success (no truncated backups), sets mode
  600, and keeps the last 14 dailies.
- Schedule with a systemd timer (Arch) once a day; copy backups off-host (they contain all messages, so encrypt them at rest,
  e.g. `age`).
- Backups include `server_meta.instance_id`, so clients still recognise a restored server.

### 15.3 Restore
1. `docker compose stop chat`.
2. `docker compose exec -T db pg_restore -U chat -d chat --clean --if-exists --no-owner < backups/<file>.dump`
   (`scripts/restore.sh` asks for confirmation and takes a safety dump first).
3. `docker compose run --rm migrate` (in case the dump predates the current schema).
4. `docker compose start chat` → `./scripts/smoke.sh`.
- Restore rehearsal: restore into a scratch Compose project (`-p auralis-chat-restoretest`, separate volume) and compare row
  counts. Done in Phase 7 and monthly afterwards.

### 15.4 Upgrade
1. Read the release notes for migrations marked *breaking*.
2. `./scripts/backup.sh`.
3. `git fetch && git checkout <new tag>`, set `CHAT_VERSION=<new tag>` in `.env`.
4. `docker compose build` (or `pull`), then `docker compose up -d --wait`. Compose runs `migrate` before starting the new `chat`.
5. `./scripts/smoke.sh`; watch `docker compose logs chat` for a few minutes. Clients reconnect automatically after the 1001 close.
- Migration rule: **expand/contract**. A release only *adds* (columns nullable or with defaults, new tables). Removals happen
  one release later, once no running version reads them. That keeps the previous image working against the new schema,
  which makes rollback possible without a restore.
- PostgreSQL major upgrades (e.g. 18 → 19) are a separate, deliberate procedure: dump → new volume with the new image →
  restore → verify. Never just change the image tag on an existing data volume.

### 15.5 Rollback
- **App-only rollback** (schema compatible thanks to expand/contract): set `CHAT_VERSION=<previous tag>`, `docker compose up -d --wait`.
- **Rollback after an incompatible migration:** stop `chat`, restore the pre-upgrade backup (§15.3), start the previous tag.
  Messages sent after the backup are lost, so say so in the release notes for any such migration.

### 15.6 Incident recovery
| Symptom | Check | Action |
|---|---|---|
| `chat` unhealthy | `docker compose logs chat`; `/readyz` reason | Config error → fix `.env`; DB down → see next row. |
| DB down | `docker compose ps db`, disk space (`df -h`) | Free disk; `docker compose start db`; `chat` recovers without a restart. |
| Suspected token leak | Admin: `cli.ts revoke-sessions --user <u>` or `--all` | Forces everyone to sign in again. |
| Account abuse | `cli.ts disable-user <u>` | Sessions revoked, sockets closed. |
| Corrupt DB | Last good backup | §15.3. |
| Lost `secrets/db_password` | The DB volume still has the old password | Reset with `docker compose exec db psql -U chat -c "ALTER USER chat PASSWORD …"` via a local-socket session, then rewrite the file. |

---

## 16. Final definition of done

The chat feature is done when **all** of the following hold:

1. **Server:** Phases 1–5 and 7 complete (6 optional). Every test in §13.2 exists and passes in CI. `docker compose up -d
   --wait` from a clean checkout yields a healthy stack. `smoke.sh` proves persistence across `down`/`up` and
   `--force-recreate`. PostgreSQL has no published port.
2. **Security:** §7.10 hard rules hold, enforced by tests or CI checks. §13.4 checklist executed and recorded. No secrets in
   git, images or logs.
3. **Operations:** backup, restore, upgrade and rollback each executed at least once and recorded in `TESTING.md`.
   `server/chat/README.md` documents them.
4. **Clients:** web, Tauri (Linux at minimum) and Android have the Chat Server settings section and chat-server
   conversations in Social. Two users can exchange DMs and group messages live. Reconnection loses nothing and duplicates
   nothing. Switching servers clears only `auralis-chat` data (test-proven). Existing Subsonic Social behaviour and all
   existing tests remain green.
5. **Networking:** one account and one conversation verified over LAN and Tailscale (and the public domain, if it has been
   enabled), with the same `instanceId`, and an address change in Settings keeps the session.
6. **Apple:** either Phase 12 complete, or explicitly deferred with the deferral recorded in `docs/PLATFORMS.md`'s feature matrix.
7. **Docs:** `docs/STRUCTURE.md`, `docs/PLATFORMS.md`, `docs/BACKEND.md`, `docs/DESKTOP.md` (CSP corrected), `ARCHITECTURE.md`,
   `README.md`, `TESTING.md`, `TASKS.md` updated to describe what was actually built and verified. Anything not verified is
   labelled as such, matching the repo's existing honesty convention.
8. **Release:** version bumped consistently across manifests; image tagged; release notes list migrations and any
   rollback caveats.
