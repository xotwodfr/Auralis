// Process entry: config → db → listen → maintenance timer → graceful shutdown (CHAT.md §8.5).
import { readFileSync } from 'node:fs'
import { runMaintenance } from './admin.ts'
import { buildApp } from './app.ts'
import { ConfigError, loadConfig } from './config.ts'
import { joinLobbyAll } from './conversations.ts'
import { createDb } from './db.ts'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
let loaded
try {
  loaded = loadConfig(process.env, version)
} catch (err) {
  if (!(err instanceof ConfigError)) throw err
  console.error(`chat: configuration error: ${err.message}`)
  process.exit(2)
}
const { config, warnings } = loaded
const db = createDb(config.databaseUrl)
const { app, ctx } = await buildApp(config, db)
for (const w of warnings) app.log.warn(w)

const maintenance = setInterval(() => {
  runMaintenance(db, config.deletedRetentionDays)
    .then((r) => (r.scrubbed || r.sessions) && app.log.info(r, 'maintenance'))
    .catch((err: Error) => app.log.warn({ msg: err.message }, 'maintenance failed'))
}, 60 * 60_000)
maintenance.unref()

let stopping = false
async function shutdown(signal: string) {
  if (stopping) process.exit(1) // second signal: give up waiting
  stopping = true
  app.log.info({ signal }, 'shutting down')
  ctx.state.shuttingDown = true // /readyz and /healthz now answer 503
  setTimeout(() => process.exit(1), 15_000).unref()
  clearInterval(maintenance)
  // Closes sockets with 1001 (clients reconnect with backoff), stops accepting, waits for in-flight requests.
  await app.close()
  await db.destroy()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await joinLobbyAll(db)
await app.listen({ host: config.listenHost, port: config.port })
