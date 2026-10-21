// Admin CLI. Passwords are read from stdin (hidden on a terminal), never from arguments, so they stay out of shell
// history and the process list. Usage: node src/cli.ts <command> [args]  (see `help`).
import { createInterface } from 'node:readline'
import { createInvite, runMaintenance, setDisabled } from './admin.ts'
import { checkPassword, normalizeUsername } from './auth.ts'
import { ConfigError, loadConfig } from './config.ts'
import { joinLobby } from './conversations.ts'
import { hashPassword } from './crypto.ts'
import { createDb, type Db } from './db.ts'
import { ApiError } from './http.ts'

const HELP = `Commands:
  create-admin <username>            create an administrator (password from stdin)
  create-user <username>             create a regular user (password from stdin)
  reset-password <username>          set a new password (stdin) and sign out every session
  disable-user <username>            block sign-in and sign out every session
  enable-user <username>
  create-invite [maxUses] [hours]    print a new invite code (defaults: 1 use, 72 hours)
  revoke-sessions <username>|--all   sign out one user, or everyone
  list-users
  maintenance                        scrub old deleted messages and dead sessions now`

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin })
    for await (const line of rl) return line
    throw new Error('no password on stdin')
  }
  process.stderr.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  let value = ''
  return new Promise((resolve, reject) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish()
          return resolve(value)
        }
        if (ch === '\u0003') {
          finish()
          return reject(new Error('cancelled'))
        }
        if (ch === '\u007f') value = value.slice(0, -1)
        else value += ch
      }
    }
    const finish = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stderr.write('\n')
    }
    process.stdin.on('data', onData)
  })
}

async function userId(db: Db, username: string): Promise<string> {
  const row = await db.selectFrom('users').select('id').where('username', '=', normalizeUsername(username)).executeTakeFirst()
  if (!row) throw new Error(`no user "${username}"`)
  return row.id
}

async function run(db: Db, logN: number, [cmd, arg, arg2]: string[]): Promise<void> {
  switch (cmd) {
    case 'create-admin':
    case 'create-user': {
      const username = normalizeUsername(arg ?? '')
      const password = checkPassword(await readPassword(`Password for ${username}: `), username)
      const row = await db
        .insertInto('users')
        .values({ username, display_name: username, password_hash: await hashPassword(password, logN), role: cmd === 'create-admin' ? 'admin' : 'user' })
        .onConflict((oc) => oc.column('username').doNothing())
        .returning('id')
        .executeTakeFirst()
      if (!row) throw new Error(`username "${username}" is taken`)
      await joinLobby(db, row.id)
      return console.log(`created ${cmd === 'create-admin' ? 'admin' : 'user'} ${username} (${row.id})`)
    }
    case 'reset-password': {
      const id = await userId(db, arg ?? '')
      const password = checkPassword(await readPassword('New password: '), normalizeUsername(arg))
      await db.updateTable('users').set({ password_hash: await hashPassword(password, logN), updated_at: new Date() }).where('id', '=', id).execute()
      await db.updateTable('sessions').set({ revoked_at: new Date() }).where('user_id', '=', id).where('revoked_at', 'is', null).execute()
      return console.log('password changed; all sessions signed out')
    }
    case 'disable-user':
    case 'enable-user':
      await setDisabled(db, await userId(db, arg ?? ''), cmd === 'disable-user')
      return console.log(cmd === 'disable-user' ? 'disabled; sessions revoked (open sockets close within a minute)' : 'enabled')
    case 'create-invite': {
      const admin = await db.selectFrom('users').select('id').where('role', '=', 'admin').orderBy('created_at').executeTakeFirst()
      if (!admin) throw new Error('create an admin first')
      const maxUses = Number(arg ?? 1)
      const hours = Number(arg2 ?? 72)
      if (!Number.isInteger(maxUses) || maxUses < 1 || !Number.isInteger(hours) || hours < 1) throw new Error('maxUses and hours must be positive integers')
      const invite = await createInvite(db, admin.id, maxUses, hours)
      return console.log(`invite code: ${invite.code}  (uses: ${maxUses}, expires ${invite.expiresAt})`)
    }
    case 'revoke-sessions': {
      let q = db.updateTable('sessions').set({ revoked_at: new Date() }).where('revoked_at', 'is', null)
      if (arg !== '--all') q = q.where('user_id', '=', await userId(db, arg ?? ''))
      const { numUpdatedRows } = await q.executeTakeFirst()
      return console.log(`revoked ${numUpdatedRows} session(s)`)
    }
    case 'list-users': {
      const rows = await db.selectFrom('users').select(['username', 'role', 'disabled_at', 'created_at']).orderBy('username').execute()
      for (const u of rows) console.log(`${u.username}\t${u.role}${u.disabled_at ? '\tdisabled' : ''}\t${u.created_at.toISOString()}`)
      return
    }
    case 'maintenance':
      return console.log(await runMaintenance(db, loadConfig().config.deletedRetentionDays))
    default:
      console.log(HELP)
      if (cmd && cmd !== 'help') process.exitCode = 2
  }
}

let db: Db | undefined
try {
  const { config } = loadConfig(process.env)
  db = createDb(config.databaseUrl)
  await run(db, config.scryptLogN, process.argv.slice(2))
} catch (err) {
  console.error(`error: ${err instanceof ApiError || err instanceof ConfigError ? err.message : (err as Error).message}`)
  process.exitCode = 1
} finally {
  await db?.destroy()
}
