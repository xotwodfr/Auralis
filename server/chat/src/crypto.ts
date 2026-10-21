// Passwords (scrypt, stdlib) and bearer tokens. CHAT.md §7.2–7.3.
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const R = 8
const P = 1
const KEY_LEN = 32
// About 128·N·r bytes per hash (128 MiB at N=2^17); four at once bounds memory under a login flood.
// ponytail: a fixed-size queue, raise MAX_CONCURRENT on hosts with more RAM.
const MAX_CONCURRENT = 4
let running = 0
const waiting: (() => void)[] = []

async function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  // A finishing hash hands its slot straight to the next waiter, so `running` never exceeds the cap.
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve))
  else running++
  try {
    const opts: ScryptOptions = { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 }
    return await new Promise((resolve, reject) => scrypt(password, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key))))
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

export async function hashPassword(password: string, logN: number): Promise<string> {
  const salt = randomBytes(16)
  const n = 2 ** logN
  const key = await derive(password.normalize('NFC'), salt, n, R, P)
  return `scrypt$${n}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

/** `{ ok, upgrade }`: upgrade is true when the stored parameters are weaker than the current ones. */
export async function verifyPassword(password: string, stored: string, logN: number): Promise<{ ok: boolean; upgrade: boolean }> {
  const [alg, n, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !hash) return { ok: false, upgrade: false }
  const expected = Buffer.from(hash, 'base64')
  const key = await derive(password.normalize('NFC'), Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p))
  const ok = key.length === expected.length && timingSafeEqual(key, expected)
  return { ok, upgrade: ok && Number(n) < 2 ** logN }
}

const dummies = new Map<number, Promise<string>>()
/** Spends the same work as a real check so response time doesn't reveal whether a username exists. */
export async function burnPasswordCheck(password: string, logN: number): Promise<void> {
  if (!dummies.has(logN)) dummies.set(logN, hashPassword(randomBytes(16).toString('hex'), logN))
  await verifyPassword(password, await dummies.get(logN)!, logN)
}

/** `ac1_` + 32 random bytes. The prefix lets secret scanners recognise a leaked token. */
export const newToken = (): string => `ac1_${randomBytes(32).toString('base64url')}`
export const newInviteCode = (): string => randomBytes(12).toString('base64url')
// Subsonic token auth is defined as md5(password + salt); used only to talk to the music server.
export const md5Hex = (value: string): string => createHash('md5').update(value).digest('hex')
export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()
export const TOKEN_SHAPE = /^ac1_[A-Za-z0-9_-]{43}$/
