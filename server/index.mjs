// Production server: serves the built web app (web/dist) and the Spicy Lyrics bridge from one origin.
//   npm run build:web && npm start
// Configuration comes from environment variables (see .env.example); a local .env file is read if present.
import { existsSync, createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spicyHandlerFromEnv } from './spicy.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
if (existsSync(join(root, '.env'))) process.loadEnvFile?.(join(root, '.env')) // existing environment variables win

const DIST = join(root, 'web', 'dist')
const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1'
const spicy = spicyHandlerFromEnv(process.env)

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2',
}

function serveFile(res, file, cache) {
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  })
  createReadStream(file).pipe(res)
}

const hasApp = existsSync(join(DIST, 'index.html'))

const server = createServer(async (req, res) => {
  try {
    if (await spicy(req, res)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, { allow: 'GET, HEAD' }).end()
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
    const file = join(DIST, path)
    if (!file.startsWith(DIST)) return void res.writeHead(403).end() // path traversal
    if (hasApp && existsSync(file) && statSync(file).isFile()) return serveFile(res, file, path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    if (!hasApp) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}') // API-only deployment (Docker): no web/dist
    serveFile(res, join(DIST, 'index.html'), 'no-cache') // SPA fallback
  } catch {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
})

// Slow-loris bounds; every route here is a small GET.
server.headersTimeout = 10_000
server.requestTimeout = 15_000
if (!hasApp) console.warn('web/dist not found: serving the lyrics API only.')
server.listen(PORT, HOST, () => {
  console.log(`Auralis on http://${HOST}:${PORT}  (Spicy Lyrics bridge: ${spicy.enabled ? 'enabled' : 'disabled: SPICY_LYRICS_SECRET_KEY not set'})`)
})
