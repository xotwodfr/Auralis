import { http } from 'msw'
import { SubsonicError } from '../../src/api/subsonic/errors'
import { kvGet } from '../../src/lib/storage'
import { useAuth } from '../../src/state/auth'
import { BASE, PASSWORD, USER, failed, server } from '../server'

const input = { baseUrl: `${BASE}/`, username: USER, password: PASSWORD, remember: false }

beforeEach(async () => {
  await useAuth.getState().disconnect()
  useAuth.setState({ hydrated: false })
})

describe('auth store', () => {
  it('connect stores the session and detected capabilities in memory only by default', async () => {
    await useAuth.getState().connect(input)
    const { session } = useAuth.getState()
    expect(session?.credentials.baseUrl).toBe(BASE)
    expect(session?.server.type).toBe('navidrome')
    expect(session?.capabilities).toMatchObject({ openSubsonic: true, songLyrics: true })
    expect(await kvGet('session')).toBeUndefined()
  })

  it('falls back to no capabilities when extensions are unsupported', async () => {
    server.use(http.get(`${BASE}/rest/getOpenSubsonicExtensions`, () => failed(70)))
    await useAuth.getState().connect(input)
    expect(useAuth.getState().session?.capabilities).toEqual({ openSubsonic: false, extensions: [], songLyrics: false })
  })

  it('invalid credentials throw a typed error and store nothing', async () => {
    const err = await useAuth.getState().connect({ ...input, password: 'bad', remember: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SubsonicError)
    expect((err as SubsonicError).code).toBe(40)
    expect(useAuth.getState().session).toBeNull()
    expect(await kvGet('session')).toBeUndefined()
  })

  it('remember persists, restore rehydrates, disconnect clears both', async () => {
    await useAuth.getState().connect({ ...input, remember: true })
    expect(await kvGet('session')).toMatchObject({ credentials: { username: USER }, remember: true })

    useAuth.setState({ session: null })
    await useAuth.getState().restore()
    expect(useAuth.getState()).toMatchObject({ hydrated: true, session: { credentials: { username: USER } } })

    await useAuth.getState().disconnect()
    expect(useAuth.getState().session).toBeNull()
    expect(await kvGet('session')).toBeUndefined()
  })

  it('forgetDevice deletes stored credentials but keeps the session', async () => {
    await useAuth.getState().connect({ ...input, remember: true })
    await useAuth.getState().forgetDevice()
    expect(await kvGet('session')).toBeUndefined()
    expect(useAuth.getState().session?.remember).toBe(false)
  })

  it('connecting without remember removes previously stored credentials', async () => {
    await useAuth.getState().connect({ ...input, remember: true })
    await useAuth.getState().connect(input)
    expect(await kvGet('session')).toBeUndefined()
  })

  it('rejects an invalid URL before any request', async () => {
    await expect(useAuth.getState().connect({ ...input, baseUrl: 'ftp://x' })).rejects.toMatchObject({ kind: 'invalid-url' })
  })
})
