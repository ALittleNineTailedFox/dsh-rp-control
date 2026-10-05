/**
 * Same-origin JSON route the settings page reads and writes the override config
 * file through.
 *
 * The roster is deployment configuration, so it could have been a settings
 * namespace — but the effective roster is a whole document (groups, items, and
 * multi-kilobyte rule bodies) that the master edits as one page, and the host
 * must re-read it on the next prompt assembly. One route over the same
 * `$DSH_HOME/rp-control.json` the file-config path already reads keeps the two
 * halves agreeing: there is no second copy of the roster to drift.
 *
 * `GET` reports the roster exactly as stored plus where it came from, `PUT`
 * validates and writes it atomically, and `DELETE` (or `PUT { reset: true }`)
 * removes the file so the built-in groups apply again. Nothing here throws into
 * a response: every failure is a status plus a reason.
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RawRpConfig } from './groups.js'
import { json, jsonError, readBodyLimited, record, sameOrigin } from './rp-route.js'
import { RP_CONFIG_ROUTE, validateRpConfig, type RpConfig, type RpConfigPayload, type RpPersonaDiag } from './shared.js'

export { RP_CONFIG_ROUTE } from './shared.js'

/**
 * A roster is small, but an inlined rule body is not: the persona rule alone is
 * around 2 KB, and the page may hold several. 4 MiB leaves room for a few
 * thousand such bodies while still bounding a hostile request.
 */
const MAX_CONFIG_BODY_BYTES = 4 * 1024 * 1024

/** Dependencies the config route needs from the plugin entry. */
export interface RpConfigRouteDeps {
  /** The roster exactly as stored, with the source and path it was read from. */
  raw(): RawRpConfig
  /**
   * Why the injected roster differs from the stored one — an unreadable
   * `textFile`, or an item that lost its text and was dropped.
   */
  textError?(): string | undefined
  /**
   * The model → persona chain the last prompt assembly resolved. Read from the
   * assembly probe, so the page reports what actually happened rather than
   * re-deriving it from the bindings and a model it would have to guess.
   */
  personaDiag?(): RpPersonaDiag | undefined
}

/** The payload `GET`, `PUT`, and `DELETE` all answer with. */
function payloadOf (deps: RpConfigRouteDeps): RpConfigPayload {
  const raw = deps.raw()
  const textError = deps.textError?.()
  const personaDiag = deps.personaDiag?.()
  const { modelPersona, defaultPersona } = raw.config
  return {
    groups: raw.config.groups,
    ...(modelPersona === undefined ? {} : { modelPersona }),
    ...(defaultPersona === undefined ? {} : { defaultPersona }),
    source: raw.source,
    path: raw.path,
    ...(raw.error === undefined ? {} : { error: raw.error }),
    ...(textError === undefined ? {} : { textError }),
    ...(personaDiag === undefined ? {} : { personaDiag }),
  }
}

/**
 * Overwrite the override file in one step: a sibling `.tmp` write followed by a
 * rename, so a failed or interrupted write can never leave a half-written
 * roster where the next prompt assembly would read it.
 *
 * The whole document is written, persona bindings included: a settings page
 * that saved only the roster would silently drop `modelPersona`.
 */
function writeConfig (path: string, config: RpConfig): string | undefined {
  const { groups, modelPersona, defaultPersona } = config
  const document = {
    groups,
    ...(modelPersona === undefined ? {} : { modelPersona }),
    ...(defaultPersona === undefined ? {} : { defaultPersona }),
  }
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    return undefined
  } catch (cause) {
    try { rmSync(tmp, { force: true }) } catch { /* the stray file is cosmetic */ }
    return cause instanceof Error ? cause.message : String(cause)
  }
}

/** Remove the override file; a file that was never there is already the goal. */
function removeConfig (path: string): string | undefined {
  try {
    rmSync(path, { force: true })
    return undefined
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

/** A request body that parsed, or a response already sent by the reader. */
type ReadResult =
  | { readonly ok: true, readonly value: unknown }
  | { readonly ok: false }

/** Read the request body as JSON, answering 415/413/400 itself on failure. */
async function readJson (req: IncomingMessage, res: ServerResponse): Promise<ReadResult> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    jsonError(res, 415, 'json-required')
    return { ok: false }
  }
  let text: string
  try {
    text = await readBodyLimited(req, MAX_CONFIG_BODY_BYTES)
  } catch {
    jsonError(res, 413, 'body-too-large')
    return { ok: false }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    jsonError(res, 400, 'invalid-request')
    return { ok: false }
  }
}

/**
 * Serve `GET` (read), `PUT { config }` or `PUT { reset: true }` (write / reset),
 * and `DELETE` (reset) against the override file.
 */
export async function serveRpConfigRoute (
  req: IncomingMessage,
  res: ServerResponse,
  deps: RpConfigRouteDeps,
): Promise<void> {
  try {
    if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')

    if (req.method === 'GET') return json(res, 200, payloadOf(deps))

    if (req.method === 'DELETE') {
      const failed = removeConfig(deps.raw().path)
      if (failed !== undefined) return jsonError(res, 500, `reset-failed: ${failed}`)
      return json(res, 200, payloadOf(deps))
    }

    if (req.method !== 'PUT') return jsonError(res, 405, 'method-not-allowed')

    const body = await readJson(req, res)
    if (!body.ok) return
    const fields = record(body.value)
    if (fields === undefined) return jsonError(res, 400, 'invalid-request')

    const path = deps.raw().path
    if (fields['reset'] === true) {
      const failed = removeConfig(path)
      if (failed !== undefined) return jsonError(res, 500, `reset-failed: ${failed}`)
      return json(res, 200, payloadOf(deps))
    }

    const checked = validateRpConfig(fields['config'])
    if (!checked.ok) return json(res, 400, { error: 'invalid-config', reason: checked.error })

    const failed = writeConfig(path, checked.config)
    if (failed !== undefined) return jsonError(res, 500, `write-failed: ${failed}`)
    return json(res, 200, payloadOf(deps))
  } catch (cause) {
    // The route backs a settings page, so an unexpected fault must still be a
    // readable answer rather than a connection the page never explains.
    jsonError(res, 500, `internal: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
