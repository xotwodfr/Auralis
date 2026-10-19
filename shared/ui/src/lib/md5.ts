// Web Crypto has no MD5, and Subsonic token auth requires it (t = md5(password + salt)).
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const n = bytes.length
  const m = new Uint32Array((((n + 8) >>> 6) + 1) * 16)
  bytes.forEach((b, i) => (m[i >> 2]! |= b << ((i % 4) * 8)))
  m[n >> 2]! |= 0x80 << ((n % 4) * 8)
  m[m.length - 2] = (n * 8) >>> 0
  m[m.length - 1] = Math.floor((n * 8) / 2 ** 32)

  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)
  const R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let off = 0; off < m.length; off += 16) {
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) [f, g] = [(b & c) | (~b & d), i]
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16]
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16]
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16]
      f = (f + a + K[i]! + m[off + g]!) >>> 0
      const s = R[(i >> 4) * 4 + (i % 4)]!
      a = d
      d = c
      c = b
      b = (b + ((f << s) | (f >>> (32 - s)))) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  return [a0, b0, c0, d0]
    .map((w) => [0, 8, 16, 24].map((s) => ((w >>> s) & 0xff).toString(16).padStart(2, '0')).join(''))
    .join('')
}
