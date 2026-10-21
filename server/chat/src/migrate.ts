// One-shot migration runner, used by the `migrate` Compose service before `chat` starts.
import { ConfigError, loadConfig } from './config.ts'
import { createDb, migrateToLatest } from './db.ts'

try {
  const { config } = loadConfig(process.env)
  const db = createDb(config.databaseUrl)
  try {
    const applied = await migrateToLatest(db)
    console.log(applied.length ? `chat: applied ${applied.join(', ')}` : 'chat: schema is up to date')
  } finally {
    await db.destroy()
  }
} catch (err) {
  console.error(`chat: migration failed: ${err instanceof ConfigError ? err.message : (err as Error).message}`)
  process.exit(1)
}
