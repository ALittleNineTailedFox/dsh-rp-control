/**
 * Host half: the per-session RP selection (itemId -> on/off) and the single
 * dynamic prompt context it feeds.
 *
 * Why a dynamic context instead of an agent preset: the harness refuses to
 * swap a session's preset once a turn has run, because the history was
 * produced under that preset's tools and swapping them would strand recorded
 * tool calls. A dynamic prompt context has no such constraint — it is
 * re-evaluated on every assembly, so a click in the composer changes the very
 * next turn of the very same session.
 *
 * All items share one context and one route: `renderInjection` joins every
 * enabled item's text in group → item order. Adding a group or item is data,
 * not wiring.
 *
 * A second route serves the roster itself to the settings page, which edits the
 * same override file this half reads. Both routes stay on the host because the
 * selection must be visible here before the next assembly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { serveRpConfigRoute } from './config-route.js'
import { loadRpConfig, loadRpRawConfig, rpConfigPath } from './groups.js'
import { serveRpRoute } from './rp-route.js'
import { loadSelections, rpStatePath, saveSelections } from './state.js'
import {
  applyPersonaOverride,
  effectiveSelection,
  personaSourceOf,
  resolvePersonaForModel,
  RP_CONFIG_ROUTE,
  RP_CONTEXT_NAME,
  RP_CONTEXT_ORDER,
  RP_PROMPT_FALLBACK,
  RP_PROMPT_VARIABLE,
  RP_ROUTE,
  renderInjection,
  type PersonaSource,
  type RpConfig,
  type RpPersonaDiag,
  type Selection,
} from './shared.js'

export const name = 'dsh-rp-control'

/** The route needs the host web server; the prompt context is optional. */
export const inject = ['webServer']

export interface Config {
  /** Override file location; defaults to `<DSH_HOME>/rp-control.json`. */
  readonly path?: string
  /** Persisted selection location; defaults to `<DSH_HOME>/rp-control-state.json`. */
  readonly statePath?: string
  /**
   * Agent presets this context is limited to. Absent or empty keeps the old
   * behaviour (every session).
   *
   * The RP card is roleplay scene state, so a host that also runs
   * engineering sessions sets this to the roleplay preset and stops the card
   * from riding along into unrelated work.
   */
  readonly presets?: readonly string[]
}

/** The session facts the injection decision reads. */
export interface SessionFacts {
  /** `'subagent'` on a delegated run. */
  readonly origin?: unknown
  /** 0 for a session a human opened; 1 or deeper for a delegated run. */
  readonly delegationDepth?: unknown
  /** Which agent preset composed the session. */
  readonly agentPreset?: unknown
}

/**
 * The assembling agent's identity.
 *
 * `assembleContextFor` builds `{ agent, scope: agent }` and an Agent's `id` is
 * the shared agent/session identity, so this is the same key the browser pill
 * is handed by the session-scoped slot — the two halves agree without an
 * extra lookup.
 */
function sessionIdOf (context: unknown): string | undefined {
  if (typeof context !== 'object' || context === null) return undefined
  const agent = (context as { agent?: unknown }).agent
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Edges worth following from an assembly context toward a session header. */
const EDGES = ['agent', 'scope', 'session', 'header', 'options', 'meta'] as const

/** Whether a value looks like a persisted session header. */
function isSessionHeaderLike (value: object): boolean {
  const record = value as Record<string, unknown>
  return 'isSeeded' in record || 'delegationDepth' in record || 'agentPreset' in record
}

/**
 * The assembling session's header, when the context exposes one.
 *
 * The assembly context is not documented down to its object graph, and the
 * agent handed to a prompt context is not guaranteed to be the full Agent
 * instance — a projection carrying `id` is enough for the session key. So
 * instead of hard-coding one path this walks a few well-known edges and
 * returns the first header-shaped object it finds. Every read degrades to
 * "unknown" rather than throwing inside prompt assembly.
 */
export function sessionFactsOf (context: unknown): SessionFacts | undefined {
  const seen = new Set<unknown>()
  let frontier: unknown[] = [context]
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const next: unknown[] = []
    for (const node of frontier) {
      if (typeof node !== 'object' || node === null || seen.has(node)) continue
      seen.add(node)
      if (isSessionHeaderLike(node)) return node
      const record = node as Record<string, unknown>
      for (const key of EDGES) {
        const child = record[key]
        if (typeof child === 'object' && child !== null) next.push(child)
      }
    }
    frontier = next
  }
  return undefined
}

/**
 * Whether the RP card belongs in this session's prompt.
 *
 * Two independent gates, both there because the card is scene state for the
 * roleplay story rather than a property of the harness:
 *
 * - A delegated run (subagent, task-board execution) is not a scene, so the
 *   card never rides along into it.
 * - When `presets` names the roleplay preset, sessions composed from anything
 *   else are skipped too — the card has no business in an engineering turn.
 *
 * An unreadable context keeps the original behaviour (inject): a missing card
 * in the master's own session is a visible regression, while an extra copy in
 * a delegated run is merely noise — and `probeOf()` records what was actually
 * seen, so a silent miss stays diagnosable.
 */
export function shouldInjectRp (facts: SessionFacts | undefined, presets: readonly string[]): boolean {
  if (facts === undefined) return true
  if (facts.origin === 'subagent') return false
  if (typeof facts.delegationDepth === 'number' && facts.delegationDepth > 0) return false
  if (presets.length === 0) return true
  return typeof facts.agentPreset === 'string' && presets.includes(facts.agentPreset)
}

/**
 * Edges worth following from an assembly context toward a model route.
 *
 * The first six are {@link sessionFactsOf}'s edges — the same object graph —
 * and the rest are the model-bearing branches a projected agent or session may
 * expose instead.
 */
const MODEL_EDGES = [
  'agent',
  'scope',
  'session',
  'header',
  'options',
  'meta',
  'config',
  'modelSelection',
  'selection',
  'llm',
  'state',
  'model',
] as const

/** How deep the model walk goes before it gives up. */
const MODEL_BRANCH_DEPTH = 5

/** Fields of one node that may carry the model route, most specific first. */
const MODEL_FIELDS = ['modelSelection', 'selection', 'llm', 'model', 'config'] as const

/** One model route, and whether both halves of `<provider>/<model>` were present. */
interface ModelRoute {
  readonly key: string
  readonly paired: boolean
}

/** A model route carried by one value: a pair object, or a plain model string. */
function modelRouteOfValue (value: unknown): ModelRoute | undefined {
  if (typeof value === 'string' && value.length > 0) return { key: value, paired: false }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const model = record['model'] ?? record['modelId']
  if (typeof model !== 'string' || model.length === 0) return undefined
  const provider = record['provider'] ?? record['providerId']
  if (typeof provider === 'string' && provider.length > 0) return { key: `${provider}/${model}`, paired: true }
  return { key: model, paired: false }
}

/** Call a member as a method and swallow whatever it does. */
function callQuietly (target: object, name: string): unknown {
  const member = (target as Record<string, unknown>)[name]
  if (typeof member !== 'function') return undefined
  try {
    return (member as () => unknown).call(target)
  } catch {
    return undefined
  }
}

/**
 * The model route one node reports, if it reports one.
 *
 * `requestHeader()` is the harness's own per-session answer — `api-session`
 * reads `agent.session.requestHeader().config` for exactly this purpose — so it
 * is asked first; the remaining fields cover the shapes a projected agent may
 * carry instead.
 */
function modelRouteOfNode (node: object): ModelRoute | undefined {
  const header = callQuietly(node, 'requestHeader')
  if (typeof header === 'object' && header !== null) {
    const fromHeader = modelRouteOfValue((header as Record<string, unknown>)['config'])
    if (fromHeader !== undefined) return fromHeader
  }
  const fromCurrent = modelRouteOfValue(callQuietly(node, 'currentSelection'))
  if (fromCurrent !== undefined) return fromCurrent
  const record = node as Record<string, unknown>
  for (const field of MODEL_FIELDS) {
    const found = modelRouteOfValue(record[field])
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The `"<provider>/<model>"` key of the session being assembled for, or
 * `undefined` when nothing in the context reports one.
 *
 * A fully paired route anywhere in the walk beats a bare model string
 * anywhere in it: `modelPersona` keys are written `<provider>/<model>`, so an
 * incidental `model` string must never shadow the route that can actually
 * match a binding. A bare string is still reported when it is all there is.
 *
 * `undefined` is a normal answer, not a failure: a brand-new session has no
 * admitted request yet, and a context this plugin cannot read simply keeps
 * `defaultPersona` in charge. Every read degrades to "unknown" rather than
 * throwing inside prompt assembly.
 */
export function modelOf (context: unknown): string | undefined {
  try {
    let bare: string | undefined
    const seen = new Set<unknown>()
    let frontier: unknown[] = [context]
    for (let depth = 0; depth < MODEL_BRANCH_DEPTH && frontier.length > 0; depth++) {
      const next: unknown[] = []
      for (const node of frontier) {
        if (typeof node !== 'object' || node === null || seen.has(node)) continue
        seen.add(node)
        const route = modelRouteOfNode(node)
        if (route !== undefined) {
          if (route.paired) return route.key
          if (bare === undefined) bare = route.key
        }
        const record = node as Record<string, unknown>
        for (const key of MODEL_EDGES) {
          const child = record[key]
          if (typeof child === 'object' && child !== null) next.push(child)
        }
      }
      frontier = next
    }
    return bare
  } catch {
    // The model probe only decorates the injection; it must never fail it.
  }
  return undefined
}

/** What the most recent prompt assembly looked like, for diagnosing a skip. */
export interface AssemblyProbe {
  readonly at: number
  readonly sessionId?: string
  readonly injected: boolean
  readonly agentKeys: readonly string[]
  readonly facts?: SessionFacts
  /** Most recent selection-state load/save failure, when one happened. */
  readonly stateError?: string
  /** Model route the assembly was resolved against, when one was found. */
  readonly modelKey?: string
  /** Persona item the model bindings forced on, when one resolved. */
  readonly personaId?: string
  /** Which link of the chain answered: an exact hit, the fallback, or neither. */
  readonly personaSource?: PersonaSource
}

let lastProbe: AssemblyProbe | undefined

/** The most recent assembly probe; the state route exposes it under `diag`. */
export function probeOf (): AssemblyProbe | undefined {
  return lastProbe
}

/** One resolution of a session's RP state, shared by every reader of it. */
interface ResolvedTurn {
  readonly sessionId: string
  readonly facts: SessionFacts | undefined
  /** Model route this turn resolved against, when one was known. */
  readonly modelKey: string | undefined
  /** Persona item the model bindings forced on, when one resolved. */
  readonly personaId: string | undefined
  readonly personaSource: PersonaSource
  /** Whether the RP card belongs in this session's prompt at all. */
  readonly selected: boolean
  /** The rendered injection; `''` when nothing is on. */
  readonly text: string
}

/** Own and inherited property names, so getter-only members show up too. */
function keysOf (value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  const names = new Set<string>()
  let node: object | null = value
  for (let depth = 0; depth < 3 && node !== null && node !== Object.prototype; depth++) {
    for (const name of Object.getOwnPropertyNames(node)) names.add(name)
    node = Object.getPrototypeOf(node) as object | null
  }
  return [...names].slice(0, 60)
}

export function apply (ctx: Context, config: Config = {}): void {
  const configPath = config.path ?? rpConfigPath()
  const statePath = config.statePath ?? rpStatePath()
  /**
   * sessionId -> { itemId -> true }. Scene state keyed by session: only the
   * items that are on are recorded, and it survives a host restart (persisted
   * to `statePath`) so the master's toggles come back for the same
   * conversation. Every write is flushed to disk immediately.
   */
  const roster = (): RpConfig => loadRpConfig(configPath).config
  const initial = roster()
  const isValidItem = (itemId: string): boolean => {
    for (const group of initial.groups) {
      if (group.items.some(entry => entry.id === itemId)) return true
    }
    return false
  }
  const loaded = loadSelections(statePath, isValidItem)
  let stateError = loaded.error
  const selections = loaded.selections
  /**
   * sessionId -> the model route last observed while assembling for it.
   *
   * The model probe reads the session's admitted request header, which exists
   * from the turn after the first one; this cache keeps a session's persona
   * stable across an assembly that could not read one, instead of dropping
   * back to `defaultPersona` on a single unreadable context.
   */
  const observedModels = new Map<string, string>()
  const persist = (): void => {
    const result = saveSelections(statePath, selections)
    if (result.error !== undefined) stateError = result.error
  }

  /**
   * The selection the prompt renders with for one session: the master's own
   * choice with the model's persona override applied.
   *
   * The state route reports this resolution rather than the raw stored one, so
   * the pill and the prompt can never disagree about which persona is in force.
   * Applying {@link effectiveSelection} to its own output is idempotent — the
   * first pass already materialised every default as an explicit `true`.
   */
  const selectionFor = (sessionId: string): Selection => {
    const cfg = roster()
    const personaId = resolvePersonaForModel(cfg, observedModels.get(sessionId))
    return applyPersonaOverride(cfg, effectiveSelection(cfg, selections.get(sessionId) ?? {}), personaId)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RP_ROUTE,
    handler: (req, res) => serveRpRoute(req, res, {
      config: roster,
      get: (sessionId: string) => selectionFor(sessionId),
      set: (sessionId: string, itemId: string, on: boolean) => {
        const cfg = roster()
        const group = cfg.groups.find(entry => entry.items.some(item => item.id === itemId))
        let selection = selections.get(sessionId)
        if (selection === undefined) {
          selection = {}
          selections.set(sessionId, selection)
        }
        if (on) {
          selection[itemId] = true
          // Exclusive group: switching one on turns the others off atomically.
          if (group?.exclusive) {
            for (const item of group.items) {
              if (item.id !== itemId) delete selection[item.id]
            }
          }
        } else {
          // Mark explicitly off (not just absent) so a group with defaults is
          // seen as "touched" and stays off.
          selection[itemId] = false
        }
        persist()
      },
      probe: probeOf,
    }),
  }), 'dsh-rp-control: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RP_CONFIG_ROUTE,
    handler: (req, res) => serveRpConfigRoute(req, res, {
      // The raw read keeps `textFile` as authored, so the page's save writes
      // back what was stored instead of the text a file happened to hold.
      raw: () => loadRpRawConfig(configPath),
      // Reported beside the raw roster so a `textFile` that no longer resolves
      // stays visible on the page instead of only in the injection.
      textError: () => loadRpConfig(configPath).error,
      // The chain the last assembly actually resolved, read back off the probe
      // rather than re-derived: the settings page must show what happened, not
      // what a second implementation of the same decision would have guessed.
      personaDiag: (): RpPersonaDiag | undefined => {
        if (lastProbe === undefined) return undefined
        return {
          ...(lastProbe.modelKey === undefined ? {} : { modelKey: lastProbe.modelKey }),
          ...(lastProbe.personaId === undefined ? {} : { personaId: lastProbe.personaId }),
          source: lastProbe.personaSource ?? 'none',
        }
      },
    }),
  }), 'dsh-rp-control: config route')

  // Optional dependency: hosts without dsh-system-prompt boot unchanged and
  // the pill still works, it just has nothing to inject into.
  ctx.inject(['systemPrompt'], (promptCtx: Context) => {
    const presets = config.presets ?? []

    /**
     * One resolution of the session being assembled for: session id → facts →
     * selection → persona override → rendered text.
     *
     * The prompt context and the prompt variable are two consumers of one
     * session's state, so they share this single path — two copies of the same
     * decision would be free to drift apart, and the drift would only show up
     * as a preset whose system prompt disagrees with the card it renders.
     */
    const resolve = (context: unknown): ResolvedTurn | undefined => {
      const sessionId = sessionIdOf(context)
      if (sessionId === undefined) return undefined
      const facts = sessionFactsOf(context)
      const probed = modelOf(context)
      if (probed !== undefined) observedModels.set(sessionId, probed)
      const modelKey = observedModels.get(sessionId)
      const cfg = roster()
      const personaId = resolvePersonaForModel(cfg, modelKey)
      const selection = applyPersonaOverride(
        cfg,
        effectiveSelection(cfg, selections.get(sessionId) ?? {}),
        personaId,
      )
      return {
        sessionId,
        facts,
        modelKey,
        personaId,
        personaSource: personaSourceOf(cfg, modelKey),
        selected: shouldInjectRp(facts, presets),
        text: renderInjection(cfg, selection),
      }
    }

    /** Record what this assembly saw, for `GET …?diag=1`. */
    const recordProbe = (turn: ResolvedTurn, context: unknown): void => {
      lastProbe = {
        at: Date.now(),
        sessionId: turn.sessionId,
        injected: turn.selected,
        agentKeys: keysOf((context as { agent?: unknown }).agent),
        ...(turn.facts === undefined ? {} : { facts: turn.facts }),
        ...(stateError === undefined ? {} : { stateError }),
        ...(turn.modelKey === undefined ? {} : { modelKey: turn.modelKey }),
        ...(turn.personaId === undefined ? {} : { personaId: turn.personaId }),
        personaSource: turn.personaSource,
      }
    }

    // A throwing provider fails the whole assembly, so every branch here ends
    // in either the rendered injection or the empty string.
    promptCtx.systemPrompt.context({
      name: RP_CONTEXT_NAME,
      order: RP_CONTEXT_ORDER,
      text: (context: unknown) => {
        try {
          const turn = resolve(context)
          if (turn === undefined) return ''
          recordProbe(turn, context)
          if (!turn.selected) return ''
          return turn.text
        } catch {
          return ''
        }
      },
    })

    /**
     * The prompt variable the RP agent preset interpolates.
     *
     * The preset's `persona` row is `prefix: '{{rp_control_prompt}}'` with
     * `complete: true`, so this value *is* that preset's system prompt: the
     * same rendered selection the card injects, for whatever session is being
     * assembled.
     *
     * Two rules make it safe to be the only section:
     *
     * - It never throws and never answers `undefined`. A throwing provider
     *   fails the whole assembly, and interpolation throws outright on an
     *   `undefined` value.
     * - It never answers `''`. Assembly drops empty sections, so an empty
     *   `complete` persona section would leave the preset with no system
     *   prompt at all — hence {@link RP_PROMPT_FALLBACK}.
     */
    promptCtx.systemPrompt.variable(RP_PROMPT_VARIABLE, (context: unknown) => {
      try {
        const turn = resolve(context)
        if (turn === undefined) return RP_PROMPT_FALLBACK
        recordProbe(turn, context)
        if (!turn.selected) return RP_PROMPT_FALLBACK
        return turn.text.length === 0 ? RP_PROMPT_FALLBACK : turn.text
      } catch {
        return RP_PROMPT_FALLBACK
      }
    })
  })
}
