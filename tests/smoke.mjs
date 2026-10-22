/**
 * Host-half smoke test.
 *
 * Proves the wiring end to end without a running harness: `apply()` registers
 * both routes, the single dynamic prompt context, and the `rp_control_prompt`
 * variable the RP agent preset interpolates; the state route really toggles
 * items; and the very next prompt assembly observes the enabled items in
 * group → item order — including the exclusive body group's radio semantics.
 *
 * Every group starts off: the roster carries no `defaultItems`, so a session
 * that has never touched the pill injects nothing at all.
 *
 * Runs against the built bundle with a minimal cordis-shaped context.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'
import {
  applyPersonaOverride,
  personaSourceOf,
  RP_PROMPT_FALLBACK,
  RP_PROMPT_VARIABLE,
  resolvePersonaForModel,
} from '../lib/types/shared.js'

const routes = []
const contexts = []
const variables = []
const promptCtx = {
  systemPrompt: {
    context (contribution) { contexts.push(contribution); return () => {} },
    variable (varName, provider) { variables.push({ name: varName, provider }); return () => {} },
  },
}
const ctx = {
  effect (fn) { fn(); return () => {} },
  webServer: { register (route) { routes.push(route); return () => {} } },
  inject (_deps, callback) { callback(promptCtx) },
}

const smokeDir = mkdtempSync(join(tmpdir(), 'dsh-rp-smoke-'))

// The multi-group behaviour below runs against a fixture roster, not the shipped
// built-ins: the built-in roster is deliberately kept to the single persona
// group, so it cannot stand in for a multi-group document.
const fixturePath = join(smokeDir, 'roster.json')
cpSync(new URL('./fixtures/roster.json', import.meta.url), fixturePath)
apply(ctx, { path: fixturePath, statePath: join(smokeDir, 'state.json') })

let failures = 0
function check (name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else { failures += 1; console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${String(detail)}`}`) }
}

check('state route registered', routes.some(r => r.path === '/dsh-rp-control/state'), JSON.stringify(routes.map(r => r.path)))
check('config route registered', routes.some(r => r.path === '/dsh-rp-control/config'), JSON.stringify(routes.map(r => r.path)))
check('prompt context registered',
  contexts.length === 1 && contexts[0].name === 'dsh-rp-control:injected',
  contexts[0]?.name)
check('context order is 56', contexts[0]?.order === 56, contexts[0]?.order)

/**
 * The prompt variable the RP agent preset interpolates. The preset's persona
 * row is `{{rp_control_prompt}}` with `complete: true`, so this provider's value
 * *is* that preset's whole system prompt.
 */
check('prompt variable registered under the fixed name',
  variables.length === 1 && variables[0].name === RP_PROMPT_VARIABLE,
  JSON.stringify(variables.map(v => v.name)))
const promptVariable = variables[0].provider

const provider = contexts[0].text
const sessionA = { agent: { id: 'session-A' } }

// A throwing provider fails the whole step, so hostile contexts must be inert.
check('agentless context contributes nothing', provider({}) === '')
check('null-ish contexts are survivable',
  provider(null) === '' && provider({ agent: null }) === '' && provider(undefined) === '')
check('the variable is never empty for a hostile context',
  promptVariable({}) === RP_PROMPT_FALLBACK
    && promptVariable(null) === RP_PROMPT_FALLBACK
    && promptVariable(undefined) === RP_PROMPT_FALLBACK
    && promptVariable({ agent: { id: 'session-A', get session () { throw new Error('hostile') } } }) === RP_PROMPT_FALLBACK,
  JSON.stringify([promptVariable({}), promptVariable(null), promptVariable(undefined)]))
check('the variable never answers undefined',
  [provider, promptVariable].every(fn => [undefined, null, {}, { agent: null }, 7, 'x'].every(c => typeof fn(c) === 'string')))

function route (path) {
  const found = routes.find(r => r.path === path)
  if (found === undefined) throw new Error(`no route registered for ${path}`)
  return found
}

async function call (path, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.url = url
  req.headers = { host: 'localhost:43120', 'content-type': 'application/json' }
  const chunks = []
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    status: 0,
    writeHead (status) { this.status = status },
    end (text) { this.writableEnded = true; chunks.push(text) },
  }
  await route(path).handler(req, res)
  return { status: res.status, body: chunks.join('') }
}

const state = async (method, url, body) => await call('/dsh-rp-control/state', method, url, body)

const listed = await state('GET', '/dsh-rp-control/state?sessionId=session-A')
const first = JSON.parse(listed.body || '{}')
check('GET returns selection + groups',
  listed.status === 200 && typeof first.selection === 'object' && Array.isArray(first.groups),
  listed.body)

const groupIds = Array.isArray(first.groups) ? first.groups.map(g => g.id) : []
const itemCount = Array.isArray(first.groups) ? first.groups.reduce((n, g) => n + g.items.length, 0) : 0
check('the fixture carries its 4 groups in order',
  groupIds.join(',') === 'style,radio,persona,tail', JSON.stringify(groupIds))
check('the fixture carries 7 items', itemCount === 7, String(itemCount))

const radioGroup = Array.isArray(first.groups) ? first.groups.find(g => g.id === 'radio') : undefined
check('the radio group is exclusive', radioGroup?.exclusive === true)
check('the radio group has no defaults', radioGroup?.defaultItems === undefined, JSON.stringify(radioGroup?.defaultItems))
check('no group carries defaults',
  first.groups.every(g => g.defaultItems === undefined && g.defaultItem === undefined),
  JSON.stringify(first.groups.map(g => [g.id, g.defaultItems ?? g.defaultItem])))

// The fixture's persona group — the ids the model→persona tests are written
// against, and the group the persona bindings must name an item of.
const fixturePersona = Array.isArray(first.groups) ? first.groups.find(g => g.id === 'persona') : undefined
check('fixture persona group is exclusive', fixturePersona?.exclusive === true)
check('fixture persona group has two items', fixturePersona?.items.length === 2,
  JSON.stringify(fixturePersona?.items?.map(i => i.id)))

// ---------------------------------------------------------------------------
// The shipped built-ins, mounted on their own against a path that does not
// exist — the normal first-run case. The roster is deliberately kept to the
// single persona group, and its bodies are files shipped inside this package.
// ---------------------------------------------------------------------------
const builtinRoutes = []
const builtinCtx = {
  effect (fn) { fn(); return () => {} },
  webServer: { register (route) { builtinRoutes.push(route); return () => {} } },
  inject (_deps, callback) {
    callback({ systemPrompt: { context () { return () => {} }, variable () { return () => {} } } })
  },
}
apply(builtinCtx, { path: join(smokeDir, 'absent.json'), statePath: join(smokeDir, 'builtin-state.json') })

const builtinState = async () => {
  const req = Readable.from([])
  req.method = 'GET'
  req.url = '/dsh-rp-control/state?sessionId=builtin-probe'
  req.headers = { host: 'localhost:43120', 'content-type': 'application/json' }
  const chunks = []
  const res = {
    headersSent: false, writableEnded: false, destroyed: false, status: 0,
    writeHead (status) { this.status = status },
    end (text) { this.writableEnded = true; chunks.push(text) },
  }
  await builtinRoutes.find(r => r.path === '/dsh-rp-control/state').handler(req, res)
  return JSON.parse(chunks.join('') || '{}')
}

const builtin = await builtinState()
check('the built-in roster carries the persona group alone',
  builtin.groups?.length === 1 && builtin.groups[0].id === 'persona',
  JSON.stringify(builtin.groups?.map(g => g.id)))
const builtinPersona = builtin.groups?.[0]
check('built-in persona group is exclusive', builtinPersona?.exclusive === true)
check('built-in persona group has one item', builtinPersona?.items?.length === 1,
  JSON.stringify(builtinPersona?.items?.map(i => i.id)))
const shippedPersona = builtinPersona?.items?.[0]
check('persona body is read from the packaged persona file',
  shippedPersona?.id === 'dafeiyu' && shippedPersona?.textFile === undefined
    && typeof shippedPersona?.text === 'string' && shippedPersona.text.length > 500,
  JSON.stringify({ id: shippedPersona?.id, textFile: shippedPersona?.textFile, textLength: shippedPersona?.text?.length }))
check('packaged persona keeps its heading', shippedPersona?.text?.startsWith('# 大肥鱼') === true, shippedPersona?.text?.slice(0, 24))
check('packaged persona dropped human-only quote lines',
  shippedPersona?.text?.split('\n').every(line => !line.trimStart().startsWith('>')) === true)
check('packaged persona ends on its last rule line',
  shippedPersona?.text?.endsWith('自然会变成我。') === true)

// Default: nothing is on, so an untouched session injects nothing at all.
check('default off: empty selection', Object.keys(first.selection).length === 0, JSON.stringify(first.selection))
check('default off: nothing injected', provider(sessionA) === '', JSON.stringify(provider(sessionA).slice(0, 60)))
check('default off: the variable answers the fixed fallback, not empty',
  promptVariable(sessionA) === RP_PROMPT_FALLBACK, JSON.stringify(promptVariable(sessionA)))

// Single toggle on → next assembly sees it.
const sw = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'style-a', on: true })
check('POST toggles style-a on', sw.status === 200 && JSON.parse(sw.body || '{}').selection?.['style-a'] === true, sw.body)
check('style-a injected', provider(sessionA).includes('【文风甲】'))
check('the variable carries the same text the context injects',
  promptVariable(sessionA) === provider(sessionA) && promptVariable(sessionA).includes('【文风甲】'),
  JSON.stringify(promptVariable(sessionA).slice(0, 40)))

// The exclusive group: an explicit pick joins the injection.
const radioA = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'radio-a', on: true })
check('radio item A togglable', JSON.parse(radioA.body || '{}').selection?.['radio-a'] === true, radioA.body)
check('radio item A injected', provider(sessionA).includes('【互斥甲】'))

// Multi-item + cross-group order: style → radio → tail.
await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'tail-a', on: true })
const multi = provider(sessionA)
check('multi-item concatenates style+radio+tail',
  multi.includes('【文风甲】') && multi.includes('【互斥甲】') && multi.includes('【末组甲】'))
check('cross-group order style<radio<tail',
  multi.indexOf('【文风甲】') < multi.indexOf('【互斥甲】')
    && multi.indexOf('【互斥甲】') < multi.indexOf('【末组甲】'))

// Exclusive: switching radio to B turns A off atomically.
const radioB = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'radio-b', on: true })
const radioBState = JSON.parse(radioB.body || '{}').selection || {}
check('exclusive: B on, A off',
  radioBState['radio-b'] === true && radioBState['radio-a'] === undefined, JSON.stringify(radioBState))
const radioBText = provider(sessionA)
check('exclusive switched to radio B',
  radioBText.includes('【互斥乙】') && !radioBText.includes('【互斥甲】'))

// Explicitly turning it off stays off — nothing re-defaults it.
const offRadioB = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'radio-b', on: false })
const offState = JSON.parse(offRadioB.body || '{}').selection || {}
check('explicit off: nothing in the group', offState['radio-b'] === undefined && offState['radio-a'] === undefined,
  JSON.stringify(offState))
const offText = provider(sessionA)
check('explicit off: the group is absent from the injection',
  !offText.includes('【互斥乙】') && !offText.includes('【互斥甲】'))

// The persona item injects verbatim.
const personaOn = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'persona-a', on: true })
check('persona item togglable',
  personaOn.status === 200 && JSON.parse(personaOn.body || '{}').selection?.['persona-a'] === true, personaOn.body)
check('persona item injected verbatim', provider(sessionA).includes('【人设甲】'))
check('the last fixture group joins after the persona group',
  provider(sessionA).indexOf('【人设甲】') < provider(sessionA).indexOf('【末组甲】'))

const unknownItem = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'nope', on: true })
check('unknown item rejected', unknownItem.status === 400, unknownItem.body)

const badOn = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'style-a', on: 'yes' })
check('non-boolean on rejected', badOn.status === 400, badOn.body)

const noSession = await state('GET', '/dsh-rp-control/state')
check('missing session rejected', noSession.status === 400, noSession.body)

const badMethod = await state('DELETE', '/dsh-rp-control/state')
check('unsupported method rejected', badMethod.status === 405, badMethod.body)

// ---------------------------------------------------------------------------
// The persona binding pure functions, tested directly: these are the decision
// the runtime makes every turn, and they are total (no input throws).
// ---------------------------------------------------------------------------

/** A roster shaped like the built-in one, with two personas to choose between. */
const personaConfig = (over = {}) => ({
  groups: [
    { id: 'style', name: '文风', items: [{ id: 's1', name: 'S', text: '文风' }] },
    {
      id: 'persona',
      name: '人格',
      exclusive: true,
      items: [
        { id: 'persona-a', name: '人设 A', text: 'PERSONA_A' },
        { id: 'persona-b', name: '人设 B', text: 'PERSONA_B' },
      ],
    },
  ],
  ...over,
})

const bound = personaConfig({ modelPersona: { 'p/m': 'persona-b' }, defaultPersona: 'persona-a' })
check('resolvePersonaForModel: an exact model hit wins over the default',
  resolvePersonaForModel(bound, 'p/m') === 'persona-b', JSON.stringify(resolvePersonaForModel(bound, 'p/m')))
check('resolvePersonaForModel: an unbound model falls back to defaultPersona',
  resolvePersonaForModel(bound, 'other/model') === 'persona-a')
check('resolvePersonaForModel: no model at all still falls back',
  resolvePersonaForModel(bound, undefined) === 'persona-a' && resolvePersonaForModel(bound, '') === 'persona-a')
check('resolvePersonaForModel: nothing bound → undefined, so the hand-picked switch stands',
  resolvePersonaForModel(personaConfig(), 'p/m') === undefined
    && resolvePersonaForModel(personaConfig(), undefined) === undefined)
check('resolvePersonaForModel: the key is trimmed, and a blank binding is inert',
  resolvePersonaForModel(bound, '  p/m  ') === 'persona-b'
    && resolvePersonaForModel(personaConfig({ modelPersona: { 'p/m': '' } }), 'p/m') === undefined)
check('resolvePersonaForModel: a hostile config answers rather than throws',
  resolvePersonaForModel({ groups: [] }, 'p/m') === undefined
    && resolvePersonaForModel({ groups: [], modelPersona: { 'p/m': 'persona-a' } }, 'p/m') === 'persona-a')
check('resolvePersonaForModel is a pure lookup: membership in the roster is applyPersonaOverride\'s job',
  applyPersonaOverride({ groups: [] }, { s1: true }, resolvePersonaForModel({ groups: [], modelPersona: { 'p/m': 'persona-a' } }, 'p/m')).s1 === true)

check('personaSourceOf names the link the chain answered from',
  personaSourceOf(bound, 'p/m') === 'model'
    && personaSourceOf(bound, 'nope/nope') === 'default'
    && personaSourceOf(personaConfig(), 'p/m') === 'none')

check('applyPersonaOverride: the bound persona is forced on, its sibling dropped',
  JSON.stringify(applyPersonaOverride(bound, { s1: true, 'persona-b': true }, 'persona-a')) === '{"s1":true,"persona-a":true}',
  JSON.stringify(applyPersonaOverride(bound, { s1: true, 'persona-b': true }, 'persona-a')))
check('applyPersonaOverride: an explicit off inside the group is overridden too',
  JSON.stringify(applyPersonaOverride(bound, { 'persona-a': false }, 'persona-b')) === '{"persona-b":true}',
  JSON.stringify(applyPersonaOverride(bound, { 'persona-a': false }, 'persona-b')))
const handPicked = { 'persona-a': true }
check('applyPersonaOverride: no bound persona returns the same object, not a copy',
  applyPersonaOverride(bound, handPicked, undefined) === handPicked)
check('applyPersonaOverride: an id this roster no longer carries is ignored',
  applyPersonaOverride(personaConfig(), handPicked, 'ghost') === handPicked)
check('applyPersonaOverride: a roster without the persona group is left alone',
  applyPersonaOverride({ groups: [] }, handPicked, 'persona-a') === handPicked)
check('applyPersonaOverride: it never mutates the selection it was given',
  (() => {
    const before = { s1: true, 'persona-a': true, 'persona-b': false }
    const snapshot = JSON.stringify(before)
    applyPersonaOverride(bound, before, 'persona-b')
    return JSON.stringify(before) === snapshot
  })())

rmSync(smokeDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
