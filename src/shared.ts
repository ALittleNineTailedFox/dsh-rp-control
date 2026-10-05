/**
 * Route + wire vocabulary shared by the host half and the browser half.
 *
 * Both halves are separate bundles, so every value that crosses the boundary
 * lives here and stays lossless JSON.
 *
 * This plugin is the local RP scene's "总控": a single route and a single
 * prompt context back every item, grouped like the SillyTavern preset screen —
 * each item is an independent on/off toggle that combines freely with the
 * others. Adding a group or item means adding data, not wiring.
 */

/** Host HTTP route the composer pill reads and writes the selection through. */
export const RP_ROUTE = '/dsh-rp-control/state'

/** Host HTTP route the settings page reads and writes the override file through. */
export const RP_CONFIG_ROUTE = '/dsh-rp-control/config'

/** Registered system-prompt context name; a duplicate registration throws. */
export const RP_CONTEXT_NAME = 'dsh-rp-control:injected'

/**
 * Name of the prompt variable this plugin exposes to prompt interpolation.
 *
 * The RP agent preset's `persona` row is `prefix: '{{rp_control_prompt}}'`, so
 * the preset's whole system prompt is this variable's value: the rendered
 * selection of the session it is assembling for. The name must match
 * `/^[a-z][a-z0-9_]*$/` — no camel case, no capitals.
 */
export const RP_PROMPT_VARIABLE = 'rp_control_prompt'

/**
 * What {@link RP_PROMPT_VARIABLE} answers when nothing usable resolves.
 *
 * A prompt variable may never be `undefined` — interpolation throws on
 * `undefined` and fails the whole assembly — and it may never be empty either:
 * the renderer drops every empty section, and a `complete` persona section that
 * renders empty would leave the assembly with no system prompt at all. So the
 * "nothing is on" case still answers with a sentence rather than `''`.
 */
export const RP_PROMPT_FALLBACK = '（本轮未启用任何 RP 模块。）'

/**
 * The group whose items a model picks between.
 *
 * `modelPersona` values and `defaultPersona` name items of this group, and the
 * model override only ever rewrites this group's switches.
 */
export const RP_PERSONA_GROUP = 'persona'

/**
 * Where this context sits among the other dynamic contexts. The image-gen
 * canvas context uses 60; the body-preset context uses 55, and this one is a
 * sibling persona-adjacent fact that must follow it, so it goes right after.
 */
export const RP_CONTEXT_ORDER = 56

/** One togglable item — a whole writing-rule block injected verbatim. */
export interface ItemSpec {
  /** Stable key written into the session selection. */
  readonly id: string
  /** Display name shown in the pill's menu row. */
  readonly name: string
  /** One-line summary for the menu row. */
  readonly desc?: string
  /** Inline text injected when this item is on; beats `textFile`. */
  readonly text?: string
  /**
   * File whose contents become the text, re-read on every resolve so an edit
   * lands on the next turn. A missing or empty file makes the item unavailable.
   *
   * A `./`-prefixed path is relative to this plugin's package root, so a roster
   * may ship its own persona files (`./personas/example.md`). Every other form
   * keeps its older meaning: `$DSH_HOME` is expanded, an absolute path is used
   * as it stands, and any other relative path resolves against `$DSH_HOME`.
   */
  readonly textFile?: string
}

/** One group — a titled section of togglable items. */
export interface GroupSpec {
  /** Stable group key. */
  readonly id: string
  readonly name: string
  readonly desc?: string
  /** When true, only one item in the group may be on at a time (radio). */
  readonly exclusive?: boolean
  /**
   * Item ids that are on when the session has never touched this group; empty
   * or absent means the group starts fully off. An `exclusive` group carries at
   * most one id — see {@link normalizeGroup} and {@link validateRpConfig}.
   */
  readonly defaultItems?: readonly string[]
  readonly items: readonly ItemSpec[]
}

/** Resolved control surface: the groups available to toggle. */
export interface RpConfig {
  readonly groups: readonly GroupSpec[]
  /**
   * Persona to force per model, keyed `"<provider>/<model>"` with the id of an
   * item of the {@link RP_PERSONA_GROUP} group as the value.
   *
   * The key is exactly what the session's model route reports, so an entry
   * only fires for the provider/model pair it names. A key that matches
   * nothing is inert; it is kept so a hand-written file survives a model list
   * change.
   */
  readonly modelPersona?: Readonly<Record<string, string>>
  /**
   * Persona to force when no `modelPersona` key matches the session's model.
   *
   * Absent means "no fallback": the master's own persona switches stand as
   * chosen, so a deployment that binds no models keeps full manual control.
   */
  readonly defaultPersona?: string
}

/**
 * One session's choices: `itemId -> true` for every item that is on. Absent
 * means off — only enabled items are recorded.
 */
export type Selection = Record<string, boolean>

/** Wire shape returned by the host route. */
export interface RpState {
  readonly selection: Selection
  readonly groups: readonly GroupSpec[]
}

/** Wire shape accepted by the host route's POST. */
export interface RpSelection {
  readonly sessionId: string
  readonly itemId: string
  readonly on: boolean
}

/** The persona chain as the most recent prompt assembly resolved it. */
export interface RpPersonaDiag {
  /** `"<provider>/<model>"` the assembly resolved against, when it found one. */
  readonly modelKey?: string
  /** Persona item the bindings forced on, when one resolved. */
  readonly personaId?: string
  /** Which link answered: an exact hit, the fallback, or neither. */
  readonly source: PersonaSource
}

/** Wire shape returned by the config route's GET. */
export interface RpConfigPayload {
  /** The roster exactly as stored: `text` and `textFile` stay as authored. */
  readonly groups: readonly GroupSpec[]
  /** Persona binding per `"<provider>/<model>"`, exactly as stored. */
  readonly modelPersona?: Readonly<Record<string, string>>
  /** Persona forced when no binding matches, exactly as stored. */
  readonly defaultPersona?: string
  /** Whether the override file or the built-in roster is in effect. */
  readonly source: 'builtin' | 'file'
  /** Absolute path of the override file, whether or not it exists. */
  readonly path: string
  /** Why the file was not used, when it was not. */
  readonly error?: string
  /** Why the injected roster differs from the stored one (dropped items). */
  readonly textError?: string
  /**
   * The model → persona chain the last assembly resolved, so the settings page
   * can show which persona is actually in force and why.
   *
   * Absent until an assembly has run in this host process.
   */
  readonly personaDiag?: RpPersonaDiag
}

/** Whether a parsed value is a usable item entry. */
function isItemSpec (value: unknown): value is ItemSpec {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && typeof candidate.name === 'string' && candidate.name.length > 0
    && (typeof candidate.text === 'string' || typeof candidate.textFile === 'string')
}

/** A group entry that passed the structural guard, with its fields still untyped. */
interface ParsedGroup extends Record<string, unknown> {
  readonly id: string
  readonly name: string
  readonly items: readonly unknown[]
}

/** Whether a parsed value is a usable group entry. */
function isGroupSpec (value: unknown): value is ParsedGroup {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  const id = candidate['id']
  const name = candidate['name']
  return typeof id === 'string' && id.length > 0
    && typeof name === 'string' && name.length > 0
    && Array.isArray(candidate['items'])
}

/**
 * The default item ids a parsed group may carry, keeping only ids whose item
 * survived parsing.
 *
 * Both the current `defaultItems` array and the legacy single `defaultItem` are
 * read, so a file written before a group could default more than one item keeps
 * working; `defaultItems` wins when a document carries both. An `exclusive`
 * group keeps only the first id, because two defaults on in a radio group is a
 * state its switch list cannot represent — the lenient read path drops rather
 * than throws, and {@link validateRpConfig} refuses that document on write.
 */
function normalizeDefaultItems (
  entry: ParsedGroup,
  items: readonly ItemSpec[],
  exclusive: boolean,
): string[] {
  const declared = entry['defaultItems']
  const legacy = entry['defaultItem']
  const raw: readonly unknown[] = Array.isArray(declared)
    ? declared
    : (typeof legacy === 'string' && legacy.length > 0 ? [legacy] : [])
  const known = new Set(items.map(item => item.id))
  const result: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (!known.has(value) || result.includes(value)) continue
    result.push(value)
    if (exclusive) break
  }
  return result
}

/** Normalize one parsed group, dropping items that are missing fields. */
function normalizeGroup (entry: unknown): GroupSpec | undefined {
  if (!isGroupSpec(entry)) return undefined
  const items: ItemSpec[] = []
  for (const item of entry.items) {
    if (!isItemSpec(item)) continue
    items.push({
      id: item.id,
      name: item.name,
      ...(typeof item.desc === 'string' ? { desc: item.desc } : {}),
      ...(typeof item.text === 'string' ? { text: item.text } : {}),
      ...(typeof item.textFile === 'string' ? { textFile: item.textFile } : {}),
    })
  }
  if (items.length === 0) return undefined
  const desc = entry['desc']
  const exclusive = entry['exclusive'] === true
  const defaultItems = normalizeDefaultItems(entry, items, exclusive)
  return {
    id: entry.id,
    name: entry.name,
    ...(typeof desc === 'string' ? { desc } : {}),
    ...(exclusive ? { exclusive: true } : {}),
    ...(defaultItems.length === 0 ? {} : { defaultItems }),
    items,
  }
}

/** Result of parsing a config file, with a reason when it had to fall back. */
export interface ResolvedRpConfig {
  readonly config: RpConfig
  readonly error?: string
}

/**
 * The persona binding fields a parsed document may carry.
 *
 * The lenient read path keeps every well-formed entry and drops the rest: a
 * hand-edited file with one bad mapping must not cost the master the whole
 * roster, and a stale id is inert rather than fatal.
 */
function normalizePersonaFields (
  source: Record<string, unknown>,
): { modelPersona?: Record<string, string>, defaultPersona?: string } {
  const fields: { modelPersona?: Record<string, string>, defaultPersona?: string } = {}
  const rawMap = source['modelPersona']
  if (typeof rawMap === 'object' && rawMap !== null && !Array.isArray(rawMap)) {
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawMap as Record<string, unknown>)) {
      if (key.length === 0) continue
      if (typeof value !== 'string' || value.length === 0) continue
      map[key] = value
    }
    if (Object.keys(map).length > 0) fields.modelPersona = map
  }
  const rawDefault = source['defaultPersona']
  if (typeof rawDefault === 'string' && rawDefault.length > 0) fields.defaultPersona = rawDefault
  return fields
}

/**
 * Normalize a parsed config file against the built-in groups.
 *
 * A file may add, drop, or retune groups and their items; anything malformed
 * is dropped rather than thrown, because a broken hand-edited file must not
 * take the whole session's prompt down.
 */
export function resolveRpConfig (raw: unknown, builtin: readonly GroupSpec[]): ResolvedRpConfig {
  if (typeof raw !== 'object' || raw === null) {
    return { config: { groups: builtin }, error: 'config must be an object with a groups array' }
  }
  const source = raw as Record<string, unknown>
  // Persona bindings are independent of the roster, so they survive a roster
  // that had to fall back.
  const persona = normalizePersonaFields(source)
  if (!Array.isArray(source['groups'])) {
    return { config: { groups: builtin, ...persona }, error: 'config must have a groups array' }
  }
  const groups: GroupSpec[] = []
  for (const entry of source['groups']) {
    const group = normalizeGroup(entry)
    if (group !== undefined) groups.push(group)
  }
  if (groups.length === 0) {
    return { config: { groups: builtin, ...persona }, error: 'no valid groups in config' }
  }
  return { config: { groups, ...persona } }
}

/** Outcome of checking a config document before it is written to disk. */
export type ConfigValidation =
  | { readonly ok: true, readonly config: RpConfig }
  | { readonly ok: false, readonly error: string }

/** A field that counts only when it is a non-empty string. */
function nonEmptyString (value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Check one submitted config document strictly, and rebuild it without any
 * field this vocabulary does not own.
 *
 * Unlike {@link resolveRpConfig}, which drops what a hand-edited file got wrong
 * so a broken file cannot take the prompt down, this runs before a write the
 * master cannot see undone, so the first problem is reported with its path.
 *
 * Item ids must be unique across the whole document: the selection map is keyed
 * by item id alone, so a duplicate would make one row toggle another row's item.
 */
export function validateRpConfig (raw: unknown): ConfigValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'config must be an object' }
  }
  const groupsRaw = (raw as { groups?: unknown }).groups
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) {
    return { ok: false, error: 'config.groups must be a non-empty array' }
  }
  const groups: GroupSpec[] = []
  const seenGroups = new Set<string>()
  const seenItems = new Set<string>()
  /** Items of the persona group: the only ids a persona binding may name. */
  const personaItems = new Set<string>()
  for (const [groupIndex, groupRaw] of groupsRaw.entries()) {
    const at = `groups[${groupIndex}]`
    if (typeof groupRaw !== 'object' || groupRaw === null || Array.isArray(groupRaw)) {
      return { ok: false, error: `${at} must be an object` }
    }
    const group = groupRaw as Record<string, unknown>
    const id = nonEmptyString(group['id'])
    if (id === undefined) return { ok: false, error: `${at}.id must be a non-empty string` }
    if (seenGroups.has(id)) return { ok: false, error: `${at}.id "${id}" is duplicated` }
    seenGroups.add(id)
    const name = nonEmptyString(group['name'])
    if (name === undefined) return { ok: false, error: `${at}.name must be a non-empty string` }
    const groupDesc = group['desc']
    if (groupDesc !== undefined && typeof groupDesc !== 'string') {
      return { ok: false, error: `${at}.desc must be a string` }
    }
    if (group['exclusive'] !== undefined && typeof group['exclusive'] !== 'boolean') {
      return { ok: false, error: `${at}.exclusive must be a boolean` }
    }
    const itemsRaw = group['items']
    if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
      return { ok: false, error: `${at}.items must be a non-empty array` }
    }
    const items: ItemSpec[] = []
    for (const [itemIndex, itemRaw] of itemsRaw.entries()) {
      const itemAt = `${at}.items[${itemIndex}]`
      if (typeof itemRaw !== 'object' || itemRaw === null || Array.isArray(itemRaw)) {
        return { ok: false, error: `${itemAt} must be an object` }
      }
      const item = itemRaw as Record<string, unknown>
      const itemId = nonEmptyString(item['id'])
      if (itemId === undefined) return { ok: false, error: `${itemAt}.id must be a non-empty string` }
      if (seenItems.has(itemId)) return { ok: false, error: `${itemAt}.id "${itemId}" is duplicated` }
      seenItems.add(itemId)
      const itemName = nonEmptyString(item['name'])
      if (itemName === undefined) return { ok: false, error: `${itemAt}.name must be a non-empty string` }
      const itemDesc = item['desc']
      if (itemDesc !== undefined && typeof itemDesc !== 'string') {
        return { ok: false, error: `${itemAt}.desc must be a string` }
      }
      const text = nonEmptyString(item['text'])
      const textFile = nonEmptyString(item['textFile'])
      if (text === undefined && textFile === undefined) {
        return { ok: false, error: `${itemAt} needs a non-empty text or textFile` }
      }
      items.push({
        id: itemId,
        name: itemName,
        ...(nonEmptyString(itemDesc) === undefined ? {} : { desc: itemDesc as string }),
        ...(text === undefined ? {} : { text }),
        ...(textFile === undefined ? {} : { textFile }),
      })
    }
    const declared = group['defaultItems']
    const legacy = group['defaultItem']
    if (declared !== undefined && !Array.isArray(declared)) {
      return { ok: false, error: `${at}.defaultItems must be an array of item ids` }
    }
    if (legacy !== undefined && typeof legacy !== 'string') {
      return { ok: false, error: `${at}.defaultItem must be a string` }
    }
    // The legacy single field is still accepted on the way in, so a settings
    // page older than this vocabulary can save; the write always emits
    // `defaultItems`.
    const declaredIds: readonly unknown[] = Array.isArray(declared)
      ? declared
      : (typeof legacy === 'string' && legacy.length > 0 ? [legacy] : [])
    const defaultItems: string[] = []
    for (const value of declaredIds) {
      if (typeof value !== 'string' || value.length === 0) {
        return { ok: false, error: `${at}.defaultItems must hold non-empty item ids` }
      }
      if (!items.some(entry => entry.id === value)) {
        return { ok: false, error: `${at}.defaultItems "${value}" is not an item of this group` }
      }
      // A repeated id is redundant rather than corrupting, so it is collapsed
      // instead of refused.
      if (!defaultItems.includes(value)) defaultItems.push(value)
    }
    if (group['exclusive'] === true && defaultItems.length > 1) {
      return { ok: false, error: `${at}.defaultItems allows at most one id while exclusive is true` }
    }
    if (id === RP_PERSONA_GROUP) for (const item of items) personaItems.add(item.id)
    groups.push({
      id,
      name,
      ...(nonEmptyString(groupDesc) === undefined ? {} : { desc: groupDesc as string }),
      ...(group['exclusive'] === true ? { exclusive: true } : {}),
      ...(defaultItems.length === 0 ? {} : { defaultItems }),
      items,
    })
  }
  // Persona bindings name items of the persona group and nothing else: a
  // binding the runtime would silently ignore is a typo, not a preference, and
  // a settings page that never sees a refusal cannot report it.
  const personaOf = (value: unknown, at: string): string | { readonly error: string } => {
    const id = nonEmptyString(value)
    if (id === undefined) return { error: `${at} must be a non-empty persona item id` }
    if (!personaItems.has(id)) return { error: `${at} "${id}" is not an item of the ${RP_PERSONA_GROUP} group` }
    return id
  }
  const personaFields: { modelPersona?: Record<string, string>, defaultPersona?: string } = {}
  const modelPersonaRaw = (raw as Record<string, unknown>)['modelPersona']
  if (modelPersonaRaw !== undefined) {
    if (typeof modelPersonaRaw !== 'object' || modelPersonaRaw === null || Array.isArray(modelPersonaRaw)) {
      return { ok: false, error: 'modelPersona must be an object mapping "<provider>/<model>" to a persona item id' }
    }
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(modelPersonaRaw as Record<string, unknown>)) {
      if (key.length === 0) return { ok: false, error: 'modelPersona keys must be non-empty strings' }
      if (!key.includes('/')) {
        return { ok: false, error: `modelPersona key "${key}" must be written "<provider>/<model>"` }
      }
      const checked = personaOf(value, `modelPersona["${key}"]`)
      if (typeof checked !== 'string') return { ok: false, error: checked.error }
      map[key] = checked
    }
    if (Object.keys(map).length > 0) personaFields.modelPersona = map
  }
  const defaultPersonaRaw = (raw as Record<string, unknown>)['defaultPersona']
  if (defaultPersonaRaw !== undefined) {
    const checked = personaOf(defaultPersonaRaw, 'defaultPersona')
    if (typeof checked !== 'string') return { ok: false, error: checked.error }
    personaFields.defaultPersona = checked
  }
  return { ok: true, config: { groups, ...personaFields } }
}

/**
 * The effective selection for a session: every explicitly-on item plus every
 * default of each untouched group, returned as a map with only `true` entries
 * (no `false` leaks out to the wire).
 *
 * A group counts as "touched" when any of its items carries an explicit value
 * (`true` or `false`); an untouched group falls back to all of its
 * `defaultItems`. An explicitly-fully-off group stays off — defaults are not
 * re-applied over it.
 */
export function effectiveSelection (config: RpConfig, selection: Selection): Selection {
  const result: Selection = {}
  for (const group of config.groups) {
    let touched = false
    for (const item of group.items) {
      const value = selection[item.id]
      if (value === true) result[item.id] = true
      if (value !== undefined) touched = true
    }
    if (touched) continue
    for (const id of group.defaultItems ?? []) {
      if (group.items.some(item => item.id === id)) result[id] = true
    }
  }
  return result
}

/**
 * The text injected ahead of the assembled prompt for a turn: every enabled
 * item's text, joined in group → item order by a blank line. No headers are
 * added — the item bodies stay verbatim.
 *
 * Never returns `undefined` or `null` — a fully-off session yields `''`.
 */
export function renderInjection (config: RpConfig, selection: Selection): string {
  const parts: string[] = []
  for (const group of config.groups) {
    for (const item of group.items) {
      if (selection[item.id] !== true) continue
      if (typeof item.text !== 'string') continue
      parts.push(item.text)
    }
  }
  return parts.join('\n\n')
}

/**
 * Where a session's persona came from — the middle link of the chain the
 * settings page shows.
 *
 * - `model` — an exact `modelPersona` hit for this session's model key.
 * - `default` — no hit, so `defaultPersona` was applied instead.
 * - `none` — nothing bound, so the master's own switches stand.
 */
export type PersonaSource = 'model' | 'default' | 'none'

/** The trimmed model key a lookup uses; `''` for anything unusable. */
function modelKeyOf (modelKey: string | undefined): string {
  return typeof modelKey === 'string' ? modelKey.trim() : ''
}

/** The `modelPersona` entry for one model key, when it has a usable value. */
function mappedPersona (config: RpConfig, key: string): string | undefined {
  if (key.length === 0) return undefined
  const mapped = (config.modelPersona ?? {})[key]
  return typeof mapped === 'string' && mapped.length > 0 ? mapped : undefined
}

/**
 * The persona item a model key selects: an exact `modelPersona` hit first,
 * then `defaultPersona`, then `undefined` so the master keeps manual control.
 *
 * Pure and total: every input shape, including `undefined`, answers rather
 * than throws, because this runs inside prompt assembly.
 */
export function resolvePersonaForModel (config: RpConfig, modelKey: string | undefined): string | undefined {
  const key = modelKeyOf(modelKey)
  const mapped = mappedPersona(config, key)
  if (mapped !== undefined) return mapped
  const fallback = config.defaultPersona
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined
}

/** Which link of the chain {@link resolvePersonaForModel} answered from. */
export function personaSourceOf (config: RpConfig, modelKey: string | undefined): PersonaSource {
  if (mappedPersona(config, modelKeyOf(modelKey)) !== undefined) return 'model'
  return typeof config.defaultPersona === 'string' && config.defaultPersona.length > 0 ? 'default' : 'none'
}

/**
 * The selection the prompt renders with: the master's own choice, with the
 * persona group rewritten to the model's persona when one resolved.
 *
 * The forced item is set `true` and its siblings are **dropped** rather than
 * recorded as `false`, so the override never leaks into the persisted
 * per-session selection — it is a property of the model, not of the scene.
 *
 * `personaId === undefined` (nothing bound, or a binding this roster no longer
 * carries) returns the selection untouched: an unbound model must not cost the
 * master a persona he picked by hand.
 */
export function applyPersonaOverride (
  config: RpConfig,
  selection: Selection,
  personaId: string | undefined,
): Selection {
  if (typeof personaId !== 'string' || personaId.length === 0) return selection
  const group = config.groups.find(entry => entry.id === RP_PERSONA_GROUP)
  if (group === undefined) return selection
  if (!group.items.some(item => item.id === personaId)) return selection
  const next: Selection = { ...selection }
  for (const item of group.items) {
    if (item.id === personaId) next[item.id] = true
    else delete next[item.id]
  }
  return next
}
