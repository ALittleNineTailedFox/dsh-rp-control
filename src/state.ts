/**
 * Per-session selection persistence.
 *
 * The selection is scene state, not configuration: it is keyed by session id
 * and must survive a host restart so the master's toggles come back for the
 * same conversation. It is written atomically on every change and loaded once
 * at startup, then kept in memory and re-flushed on each write.
 *
 * A missing file is the normal case (empty state, everything off); bad JSON,
 * an invalid structure, or wrong value types degrade to empty state with the
 * reason reported through the diag probe rather than thrown.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Selection } from './shared.js'

/** Absolute path of the persisted selection file under the harness home. */
export function rpStatePath (): string {
  const home = process.env['DSH_HOME']?.trim()
  const root = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(root, 'rp-control-state.json')
}

function messageOf (cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Result of loading the persisted selection. */
export interface LoadedSelection {
  readonly selections: Map<string, Selection>
  readonly error?: string
}

/** Result of persisting the selection. */
export interface SaveResult {
  readonly error?: string
}

/**
 * Load the persisted selection.
 *
 * `isValid(itemId)` answers whether an item is still known to the current
 * config; stale ids are silently dropped (a removed item must not fail the
 * boot). Missing file returns empty with no error; every other failure returns
 * empty plus a reason. Only `true` entries are kept; `false` is treated as off.
 */
export function loadSelections (
  path: string,
  isValid: (itemId: string) => boolean,
): LoadedSelection {
  const empty = new Map<string, Selection>()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { selections: empty }
    return { selections: empty, error: messageOf(cause) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return { selections: empty, error: messageOf(cause) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { selections: empty, error: 'state must be a JSON object' }
  }
  const sessions = (parsed as { sessions?: unknown }).sessions
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) {
    return { selections: empty, error: 'state.sessions must be an object' }
  }
  const selections = new Map<string, Selection>()
  for (const [sessionId, rawSel] of Object.entries(sessions)) {
    if (typeof rawSel !== 'object' || rawSel === null || Array.isArray(rawSel)) {
      return { selections: empty, error: `state.sessions[${sessionId}] must be an object` }
    }
    const sel: Selection = {}
    for (const [itemId, on] of Object.entries(rawSel as Record<string, unknown>)) {
      if (typeof on !== 'boolean') {
        return { selections: empty, error: `state.sessions[${sessionId}][${itemId}] must be a boolean` }
      }
      if (!isValid(itemId)) continue
      // Keep both `true` (on) and `false` (explicitly off): a `false` marks the
      // group as "touched" so its `defaultItems` are not re-applied.
      sel[itemId] = on
    }
    if (Object.keys(sel).length > 0) selections.set(sessionId, sel)
  }
  return { selections }
}

/**
 * Persist the selection atomically: write `<path>.tmp` then rename over the
 * target. Both enabled (true) and explicitly-off (false) items are recorded
 * so a group with defaults stays off across a restart; empty sessions are
 * omitted. A failed write is returned as a reason, never thrown.
 */
export function saveSelections (path: string, selections: Map<string, Selection>): SaveResult {
  const sessions: Record<string, Record<string, boolean>> = {}
  for (const [sessionId, sel] of selections) {
    if (Object.keys(sel).length === 0) continue
    sessions[sessionId] = { ...sel }
  }
  const payload = `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, path)
    return {}
  } catch (cause) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return { error: messageOf(cause) }
  }
}
