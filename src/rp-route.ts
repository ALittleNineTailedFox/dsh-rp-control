/**
 * Same-origin JSON route the composer pill reads and writes the per-session
 * selection through.
 *
 * The pill could not write the choice with a settings field: the selection is
 * per-session while settings are deployment-wide, and the value must be
 * visible to the host before the next prompt assembly. A tiny route keeps the
 * write synchronous with the click and needs no new service.
 *
 * This module also owns the same-origin, JSON body, and response helpers the
 * config route shares, so both routes enforce one rule.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { effectiveSelection, RP_ROUTE, type ItemSpec, type RpConfig, type RpState, type Selection } from './shared.js'

export { RP_ROUTE } from './shared.js'

/** A session id is a durable harness identity; refuse anything longer. */
const MAX_SESSION_ID = 256
const MAX_BODY_BYTES = 8 * 1024

/** Dependencies the route needs from the plugin entry. */
export interface RpRouteDeps {
  /** Current groups; re-read per request so a config edit lands immediately. */
  config(): RpConfig
  /** The session's selection (empty when nothing is on). */
  get(sessionId: string): Selection
  /** Toggle one item on/off. */
  set(sessionId: string, itemId: string, on: boolean): void
  /**
   * Most recent prompt-assembly probe. Exposed under `?diag=1` so a session
   * whose card silently stopped appearing can be explained from outside
   * without a rebuild.
   */
  probe?(): unknown
}

/** Resolve the wire state for one session against the live groups. */
function stateOf (deps: RpRouteDeps, sessionId: string): RpState {
  const config = deps.config()
  return { selection: effectiveSelection(config, deps.get(sessionId)), groups: config.groups }
}

/** Find an item across all groups, if it exists. */
function findItem (config: RpConfig, itemId: string): ItemSpec | undefined {
  for (const group of config.groups) {
    const item = group.items.find(entry => entry.id === itemId)
    if (item !== undefined) return item
  }
  return undefined
}

/** Serve `GET ?sessionId=` (read) and `POST {sessionId, itemId, on}` (toggle). */
export async function serveRpRoute (
  req: IncomingMessage,
  res: ServerResponse,
  deps: RpRouteDeps,
): Promise<void> {
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  if (req.method === 'GET') {
    const sessionId = sessionIdOf(req)
    if (sessionId === undefined) return jsonError(res, 400, 'session-required')
    const state = stateOf(deps, sessionId)
    if (wantsDiag(req)) return json(res, 200, { ...state, probe: deps.probe?.() ?? null })
    return json(res, 200, state)
  }
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return jsonError(res, 415, 'json-required')
  }
  let payload: unknown
  try {
    payload = JSON.parse(await readBody(req))
  } catch {
    return jsonError(res, 400, 'invalid-request')
  }
  const body = record(payload)
  const sessionId = typeof body?.['sessionId'] === 'string' ? body['sessionId'] : ''
  const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
  const on = body?.['on']
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID) return jsonError(res, 400, 'session-required')
  if (typeof on !== 'boolean') return jsonError(res, 400, 'invalid-request')
  const config = deps.config()
  // Refuse an unknown item instead of storing it: a typo must not silently
  // resolve to "off" and look like the click was ignored.
  if (findItem(config, itemId) === undefined) return jsonError(res, 400, 'unknown-item')
  deps.set(sessionId, itemId, on)
  json(res, 200, stateOf(deps, sessionId))
}

function sessionIdOf (req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const value = url.searchParams.get('sessionId') ?? ''
  return value.length > 0 && value.length <= MAX_SESSION_ID ? value : undefined
}

/** Whether the caller asked for the assembly probe alongside the state. */
function wantsDiag (req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost')
  return url.searchParams.get('diag') === '1'
}

/**
 * Whether the request came from this server's own page. A missing `Origin` is
 * allowed: same-origin GETs and non-browser callers send none.
 *
 * Exported for the config route, which enforces the same rule.
 */
export function sameOrigin (req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  return origin === undefined || host === undefined || origin === `http://${host}` || origin === `https://${host}`
}

/** The request body as a plain record, or `undefined` when it is not one. */
export function record (value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a request body, refusing anything past `limit` bytes. */
export async function readBodyLimited (req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > limit) throw new Error('request too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read a JSON body within the toggle route's small limit. */
async function readBody (req: IncomingMessage): Promise<string> {
  return await readBodyLimited(req, MAX_BODY_BYTES)
}

/** Send one JSON response, unless the response already left this server. */
export function json (res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Send one `{ error }` JSON response. */
export function jsonError (res: ServerResponse, status: number, code: string): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  json(res, status, { error: code })
}
