// Kysely + pg: table types, pool and migrations. Foreign keys are used deliberately (CHAT.md §6.4); nothing cascades,
// because users and conversations are never hard-deleted.
import { Kysely, PostgresDialect, sql, type ColumnType, type Generated, type Insertable, type Selectable } from 'kysely'
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration'
import pg from 'pg'

// int8 → number. Sequence numbers and counts stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v))

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type Created = ColumnType<Date, Date | string | undefined, never>

export interface Database {
  server_meta: { key: string; value: string }
  users: {
    id: Generated<string>
    username: string
    display_name: string
    password_hash: string
    role: 'admin' | 'user'
    disabled_at: Date | null
    created_at: Created
    updated_at: Timestamp
  }
  sessions: {
    id: Generated<string>
    user_id: string
    token_hash: Buffer
    device_name: string | null
    created_at: Created
    last_used_at: Timestamp
    expires_at: Date
    revoked_at: Date | null
  }
  invites: {
    id: Generated<string>
    code_hash: Buffer
    created_by: string
    max_uses: number
    uses: Generated<number>
    expires_at: Date
    revoked_at: Date | null
    created_at: Created
  }
  conversations: {
    id: Generated<string>
    kind: 'direct' | 'group'
    title: string | null
    dm_key: string | null
    last_seq: Generated<number>
    last_message_at: Date | null
    created_by: string
    created_at: Created
    updated_at: Timestamp
  }
  conversation_members: {
    conversation_id: string
    user_id: string
    role: 'owner' | 'admin' | 'member'
    last_read_seq: Generated<number>
    joined_at: Timestamp
    left_at: Date | null
  }
  messages: {
    id: Generated<string>
    conversation_id: string
    seq: number
    sender_id: string
    client_message_id: string
    body: string | null
    created_at: Created
    deleted_at: Date | null
  }
}

export type Db = Kysely<Database>
export type UserRow = Selectable<Database['users']>
export type NewMessage = Insertable<Database['messages']>

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 })
  // An idle client losing its connection (db restart) must not crash the process; the next query reconnects.
  pool.on('error', () => {})
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

// Expand/contract only (CHAT.md §15.4): a release adds; removals come one release later.
const migrations: Record<string, Migration> = {
  '0001_initial': {
    async up(db) {
      await sql`
        CREATE TABLE server_meta (key text PRIMARY KEY, value text NOT NULL);
        INSERT INTO server_meta (key, value) VALUES ('instance_id', gen_random_uuid()::text), ('created_at', now()::text);

        CREATE TABLE users (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.-]{3,32}$'),
          display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 64),
          password_hash text NOT NULL,
          role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
          disabled_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE sessions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES users (id),
          token_hash bytea NOT NULL UNIQUE,
          device_name text CHECK (char_length(device_name) <= 64),
          created_at timestamptz NOT NULL DEFAULT now(),
          last_used_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL,
          revoked_at timestamptz
        );
        CREATE INDEX idx_sessions_user_id ON sessions (user_id) WHERE revoked_at IS NULL;

        CREATE TABLE invites (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          code_hash bytea NOT NULL UNIQUE,
          created_by uuid NOT NULL REFERENCES users (id),
          max_uses integer NOT NULL CHECK (max_uses > 0),
          uses integer NOT NULL DEFAULT 0,
          expires_at timestamptz NOT NULL,
          revoked_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          CHECK (uses <= max_uses)
        );

        CREATE TABLE conversations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          kind text NOT NULL CHECK (kind IN ('direct', 'group')),
          title text CHECK (char_length(title) BETWEEN 1 AND 80),
          dm_key text UNIQUE,
          last_seq bigint NOT NULL DEFAULT 0,
          last_message_at timestamptz,
          created_by uuid NOT NULL REFERENCES users (id),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK ((kind = 'direct') = (dm_key IS NOT NULL))
        );

        CREATE TABLE conversation_members (
          conversation_id uuid NOT NULL REFERENCES conversations (id),
          user_id uuid NOT NULL REFERENCES users (id),
          role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
          last_read_seq bigint NOT NULL DEFAULT 0,
          joined_at timestamptz NOT NULL DEFAULT now(),
          left_at timestamptz,
          PRIMARY KEY (conversation_id, user_id)
        );
        CREATE INDEX idx_conversation_members_user_id ON conversation_members (user_id) WHERE left_at IS NULL;

        CREATE TABLE messages (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          conversation_id uuid NOT NULL REFERENCES conversations (id),
          seq bigint NOT NULL,
          sender_id uuid NOT NULL REFERENCES users (id),
          client_message_id uuid NOT NULL,
          body text CHECK (char_length(body) BETWEEN 1 AND 4000),
          created_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz,
          UNIQUE (conversation_id, seq),
          UNIQUE (conversation_id, sender_id, client_message_id)
        );
        CREATE INDEX idx_messages_scrub ON messages (deleted_at) WHERE deleted_at IS NOT NULL AND body IS NOT NULL;
      `.execute(db)
    },
    async down(db) {
      await sql`DROP TABLE messages, conversation_members, conversations, invites, sessions, users, server_meta`.execute(db)
    },
  },
}

export const LATEST_MIGRATION = Object.keys(migrations).at(-1)!
const provider: MigrationProvider = { getMigrations: async () => migrations }

/** Applies pending migrations. Kysely's Migrator takes an advisory lock, so concurrent runs wait instead of racing. */
export async function migrateToLatest(db: Db): Promise<string[]> {
  const { error, results } = await new Migrator({ db, provider }).migrateToLatest()
  if (error) throw error
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName)
}

/** True when the database answers and the newest migration this build knows about is applied. */
export async function schemaReady(db: Db): Promise<boolean> {
  try {
    const { rows } = await sql<{ name: string }>`SELECT name FROM kysely_migration WHERE name = ${LATEST_MIGRATION}`.execute(db)
    return rows.length === 1
  } catch {
    return false
  }
}

export async function instanceId(db: Db): Promise<string> {
  const row = await db.selectFrom('server_meta').select('value').where('key', '=', 'instance_id').executeTakeFirstOrThrow()
  return row.value
}
