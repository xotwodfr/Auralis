import { SubsonicError } from '../../src/api/subsonic/errors'
import { connectErrorMessage } from '../../src/features/connect/errorMessage'

const network = new SubsonicError('network', 'Could not reach the server')

describe('connectErrorMessage network failures', () => {
  afterEach(() => Reflect.deleteProperty(window, '__TAURI_INTERNALS__'))

  it('is the plain CORS/HTTPS hint in a browser', () => {
    expect(connectErrorMessage(network)).not.toContain('glib-networking')
  })

  it('names the missing TLS library inside the Tauri shell', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    expect(connectErrorMessage(network)).toContain('glib-networking')
  })
})
