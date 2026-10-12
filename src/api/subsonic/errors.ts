export type ErrorKind =
  | 'invalid-url'
  | 'network'
  | 'http'
  | 'invalid-response'
  | 'aborted'
  | 'missing-param' // 10
  | 'auth' // 40 wrong credentials, 41 token auth unsupported
  | 'not-authorized' // 50
  | 'trial-expired' // 60
  | 'not-found' // 70
  | 'unknown'

export class SubsonicError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    /** Raw Subsonic error code, when the server sent one. */
    readonly code?: number,
    /** HTTP status, for `http` errors. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SubsonicError'
  }
}

const KIND_BY_CODE: Record<number, ErrorKind> = {
  10: 'missing-param',
  40: 'auth',
  41: 'auth',
  50: 'not-authorized',
  60: 'trial-expired',
  70: 'not-found',
}

export function errorFromCode(code: number, message?: string): SubsonicError {
  return new SubsonicError(KIND_BY_CODE[code] ?? 'unknown', message ?? `Subsonic error ${code}`, code)
}

export const isAborted = (e: unknown) => e instanceof SubsonicError && e.kind === 'aborted'
