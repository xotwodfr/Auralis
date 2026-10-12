import { buildUrl, generateSalt, normalizeBaseUrl } from '../../src/api/subsonic/auth'
import { SubsonicError } from '../../src/api/subsonic/errors'
import { md5 } from '../../src/lib/md5'

describe('md5', () => {
  it('matches the Subsonic example vector', () => {
    expect(md5('sesame' + 'c19b2d')).toBe('26719a1196d2a940705a59634eb18eab')
  })
  it('handles empty, multi-block and non-ASCII input', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5('a'.repeat(100))).toBe('36a92cc94a9e0fa21f625f8bfb007adf')
  })
})

describe('buildUrl', () => {
  const auth = { username: 'joe', password: 'sesame' }

  it('uses token auth with required params and never sends the password', () => {
    const q = new URL(buildUrl('https://m.test', 'ping', auth, {}, 'c19b2d')).searchParams
    expect(Object.fromEntries(q)).toEqual({
      u: 'joe',
      t: '26719a1196d2a940705a59634eb18eab',
      s: 'c19b2d',
      v: '1.16.1',
      c: 'Auralis',
      f: 'json',
    })
    expect(q.has('p')).toBe(false)
  })

  it('omits credentials for public endpoints and keeps reserved params authoritative', () => {
    const q = new URL(buildUrl('https://m.test/navi', 'x', undefined, { f: 'xml', id: 'a b' })).searchParams
    expect(q.has('t')).toBe(false)
    expect(q.get('f')).toBe('json')
    expect(q.get('id')).toBe('a b')
    expect(buildUrl('https://m.test/navi', 'x')).toMatch(/^https:\/\/m\.test\/navi\/rest\/x\?/)
  })

  it('generates a fresh salt of at least 6 chars each time', () => {
    const salts = new Set(Array.from({ length: 20 }, generateSalt))
    expect(salts.size).toBe(20)
    expect([...salts].every((s) => s.length >= 6)).toBe(true)
  })
})

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://m.test/', 'https://m.test'],
    ['  http://m.test:4533/navi//?x=1#y ', 'http://m.test:4533/navi'],
    ['m.test', 'https://m.test'],
  ])('%s -> %s', (input, expected) => expect(normalizeBaseUrl(input)).toBe(expected))

  it.each(['', '   ', 'ftp://m.test', 'https://u:p@m.test', 'http://'])('rejects %j', (input) => {
    expect(() => normalizeBaseUrl(input)).toThrowError(SubsonicError)
  })
})
