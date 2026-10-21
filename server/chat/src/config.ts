// Environment → validated config. Refuses to start on unsafe or mistyped settings (CHAT.md §7.6, §8.4).
import { readFileSync } from 'node:fs'
import type { RegistrationMode } from '../../../shared/chat-protocol/index.ts'

export interface Config {
  serverName: string
  version: string
  listenHost: string
  port: number
  bindAddress: string
  registration: RegistrationMode
  allowedOrigins: string[]
  trustProxy: boolean
  logLevel: string
  sessionIdleDays: number
  sessionMaxDays: number
  maxMessageChars: number
  maxGroupMembers: number
  maxSocketsPerUser: number
  deletedRetentionDays: number
  databaseUrl: string
  /** Navidrome/Subsonic base URL. When set, its accounts can sign in to chat with their music-server password. */
  navidromeUrl: string | null
  /** scrypt cost exponent (N = 2^logN). Not an env setting: tests lower it so suites stay fast. */
  scryptLogN: number
}

export const MAX_MESSAGE_CHARS = 4000 // also the database CHECK constraint
const KNOWN = new Set([
  'CHAT_SERVER_NAME', 'CHAT_VERSION', 'CHAT_LISTEN_HOST', 'CHAT_PORT', 'CHAT_BIND_ADDRESS', 'CHAT_REGISTRATION',
  'CHAT_ALLOWED_ORIGINS', 'CHAT_TRUST_PROXY', 'CHAT_LOG_LEVEL', 'CHAT_SESSION_IDLE_DAYS', 'CHAT_SESSION_MAX_DAYS',
  'CHAT_MAX_MESSAGE_CHARS', 'CHAT_MAX_GROUP_MEMBERS', 'CHAT_MAX_SOCKETS_PER_USER', 'CHAT_DELETED_RETENTION_DAYS',
  'CHAT_NAVIDROME_URL',
])
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
// scheme://host[:port], nothing else. `new URL().origin` can't be used: it is "null" for custom schemes like tauri://.
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d{1,5})?$|^[a-z][a-z0-9+.-]*:\/\/\[[0-9a-f:]+\](:\d{1,5})?$/i

export class ConfigError extends Error {}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${raw}")`)
  return n
}

function databaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.DATABASE_URL) return env.DATABASE_URL
  const file = env.DATABASE_PASSWORD_FILE
  if (!file) throw new ConfigError('Set DATABASE_URL, or DATABASE_PASSWORD_FILE (+ DATABASE_HOST/NAME/USER)')
  let password: string
  try {
    password = readFileSync(file, 'utf8').trim()
  } catch {
    throw new ConfigError(`DATABASE_PASSWORD_FILE ${file} cannot be read`)
  }
  if (!password) throw new ConfigError(`DATABASE_PASSWORD_FILE ${file} is empty`)
  const u = new URL('postgres://placeholder')
  u.hostname = env.DATABASE_HOST || 'db'
  u.port = env.DATABASE_PORT || '5432'
  u.username = env.DATABASE_USER || 'chat'
  u.password = password
  u.pathname = `/${env.DATABASE_NAME || 'chat'}`
  return u.toString()
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, version = '0.0.0'): { config: Config; warnings: string[] } {
  const unknown = Object.keys(env).filter((k) => k.startsWith('CHAT_') && !KNOWN.has(k))
  if (unknown.length) throw new ConfigError(`Unknown setting(s): ${unknown.join(', ')} (typo?)`)

  const registration = (env.CHAT_REGISTRATION || 'closed') as RegistrationMode
  if (!['closed', 'invite', 'open'].includes(registration)) throw new ConfigError('CHAT_REGISTRATION must be closed, invite or open')

  const allowedOrigins = (env.CHAT_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)
  for (const o of allowedOrigins) {
    if (!ORIGIN.test(o)) throw new ConfigError(`CHAT_ALLOWED_ORIGINS: "${o}" is not an exact origin (scheme://host[:port]; "*" and "null" are refused)`)
  }

  const trustProxy = env.CHAT_TRUST_PROXY === '1'
  if (!['', '0', '1', undefined].includes(env.CHAT_TRUST_PROXY)) throw new ConfigError('CHAT_TRUST_PROXY must be 0 or 1')
  const bindAddress = env.CHAT_BIND_ADDRESS || '127.0.0.1'
  // Forwarded headers are client-controlled unless only a local proxy can reach the port.
  if (trustProxy && !LOOPBACK.has(bindAddress)) throw new ConfigError('CHAT_TRUST_PROXY=1 requires CHAT_BIND_ADDRESS to be a loopback address')

  const sessionIdleDays = int(env, 'CHAT_SESSION_IDLE_DAYS', 30, 1, 365)
  const sessionMaxDays = int(env, 'CHAT_SESSION_MAX_DAYS', 180, 1, 3650)
  if (sessionIdleDays > sessionMaxDays) throw new ConfigError('CHAT_SESSION_IDLE_DAYS cannot exceed CHAT_SESSION_MAX_DAYS')

  let navidromeUrl: string | null = null
  if (env.CHAT_NAVIDROME_URL) {
    let u: URL
    try {
      u = new URL(env.CHAT_NAVIDROME_URL)
    } catch {
      throw new ConfigError('CHAT_NAVIDROME_URL is not a URL')
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('CHAT_NAVIDROME_URL must be http(s)')
    navidromeUrl = u.toString().replace(/\/+$/, '')
  }

  const config: Config = {
    serverName: (env.CHAT_SERVER_NAME || 'Auralis Chat').slice(0, 64),
    version,
    listenHost: env.CHAT_LISTEN_HOST || '127.0.0.1',
    port: int(env, 'CHAT_PORT', 8790, 1, 65535),
    bindAddress,
    registration,
    allowedOrigins,
    trustProxy,
    logLevel: env.CHAT_LOG_LEVEL || 'info',
    sessionIdleDays,
    sessionMaxDays,
    maxMessageChars: int(env, 'CHAT_MAX_MESSAGE_CHARS', MAX_MESSAGE_CHARS, 1, MAX_MESSAGE_CHARS),
    maxGroupMembers: int(env, 'CHAT_MAX_GROUP_MEMBERS', 64, 2, 1000),
    maxSocketsPerUser: int(env, 'CHAT_MAX_SOCKETS_PER_USER', 10, 1, 100),
    deletedRetentionDays: int(env, 'CHAT_DELETED_RETENTION_DAYS', 30, 0, 3650),
    databaseUrl: databaseUrl(env),
    navidromeUrl,
    scryptLogN: 17,
  }
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(config.logLevel)) throw new ConfigError('CHAT_LOG_LEVEL is not a pino level')

  const warnings: string[] = []
  const publicOrigin = allowedOrigins.some((o) => o.startsWith('https://') && !/^https:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o))
  if (registration === 'open' && publicOrigin) warnings.push('CHAT_REGISTRATION=open with a public web origin: anyone who can reach the server can create an account')
  return { config, warnings }
}
