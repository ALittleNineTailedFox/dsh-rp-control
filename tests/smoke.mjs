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
import { mkdtempSync, rmSync } from 'node:fs'
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
apply(ctx, { path: join(smokeDir, 'nope.json'), statePath: join(smokeDir, 'state.json') })

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
check('6 groups in order', groupIds.join(',') === 'style,nsfw,writing,body,persona,image', JSON.stringify(groupIds))
check('10 items', itemCount === 10, String(itemCount))

const bodyGroup = Array.isArray(first.groups) ? first.groups.find(g => g.id === 'body') : undefined
check('body group is exclusive', bodyGroup?.exclusive === true)
check('body group has no defaults', bodyGroup?.defaultItems === undefined, JSON.stringify(bodyGroup?.defaultItems))
check('no group carries defaults',
  first.groups.every(g => g.defaultItems === undefined && g.defaultItem === undefined),
  JSON.stringify(first.groups.map(g => [g.id, g.defaultItems ?? g.defaultItem])))

// The persona group is exclusive and reads its body from a file shipped inside
// this package: `./personas/example.md` is resolved against the plugin root, so the
// body is maintained as an ordinary markdown file and swapped per model.
const persona = Array.isArray(first.groups) ? first.groups.find(g => g.id === 'persona') : undefined
check('persona group is exclusive', persona?.exclusive === true)
check('persona group has two items', persona?.items.length === 2, JSON.stringify(persona?.items?.map(i => i.id)))
const shippedPersona = persona?.items?.[0]
check('persona body is read from the packaged persona file',
  shippedPersona?.id === 'persona-example' && shippedPersona?.textFile === undefined
    && typeof shippedPersona?.text === 'string' && shippedPersona.text.length > 200,
  JSON.stringify({ id: shippedPersona?.id, textFile: shippedPersona?.textFile, textLength: shippedPersona?.text?.length }))
check('packaged persona keeps its heading', shippedPersona?.text?.startsWith('# 示例人设') === true, shippedPersona?.text?.slice(0, 24))
check('packaged persona dropped human-only quote lines',
  shippedPersona?.text?.split('\n').every(line => !line.trimStart().startsWith('>')) === true)
check('packaged persona ends on its last rule line',
  shippedPersona?.text?.endsWith('只写这个角色自己看得到、听得到的东西') === true)

// Default: nothing is on, so an untouched session injects nothing at all.
check('default off: empty selection', Object.keys(first.selection).length === 0, JSON.stringify(first.selection))
check('default off: nothing injected', provider(sessionA) === '', JSON.stringify(provider(sessionA).slice(0, 60)))
check('default off: the variable answers the fixed fallback, not empty',
  promptVariable(sessionA) === RP_PROMPT_FALLBACK, JSON.stringify(promptVariable(sessionA)))

// Single toggle on → next assembly sees it.
const sw = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'style-plain', on: true })
check('POST toggles style-plain on', sw.status === 200 && JSON.parse(sw.body || '{}').selection?.['style-plain'] === true, sw.body)
check('style-plain injected', provider(sessionA).includes('【示例条目 · 平实白描】'))
check('the variable carries the same text the context injects',
  promptVariable(sessionA) === provider(sessionA) && promptVariable(sessionA).includes('【示例条目 · 平实白描】'),
  JSON.stringify(promptVariable(sessionA).slice(0, 40)))

// The exclusive body group: an explicit pick joins the injection.
const bodyA = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'body-a', on: true })
check('body item A togglable', JSON.parse(bodyA.body || '{}').selection?.['body-a'] === true, bodyA.body)
check('body item A injected', provider(sessionA).includes('【当前身体：示例 A】'))

// Multi-item + cross-group order: style → writing → body.
await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'writing-core', on: true })
const multi = provider(sessionA)
check('multi-item concatenates style+writing+body',
  multi.includes('【示例条目 · 平实白描】') && multi.includes('【示例条目 · 通用写作要求】')
    && multi.includes('【当前身体：示例 A】'))
check('cross-group order style<writing<body',
  multi.indexOf('【示例条目 · 平实白描】') < multi.indexOf('【示例条目 · 通用写作要求】')
    && multi.indexOf('【示例条目 · 通用写作要求】') < multi.indexOf('【当前身体：示例 A】'))

// Exclusive: switching body to B turns A off atomically.
const bodyB = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'body-b', on: true })
const bodyBState = JSON.parse(bodyB.body || '{}').selection || {}
check('exclusive: B on, A off', bodyBState['body-b'] === true && bodyBState['body-a'] === undefined, JSON.stringify(bodyBState))
const bodyBText = provider(sessionA)
check('exclusive switched to body B', bodyBText.includes('【当前身体：示例 B】') && !bodyBText.includes('【当前身体：示例 A】'))

// Explicitly turning the body off stays off — nothing re-defaults it.
const offBodyB = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'body-b', on: false })
const offState = JSON.parse(offBodyB.body || '{}').selection || {}
check('explicit off: no body', offState['body-b'] === undefined && offState['body-a'] === undefined, JSON.stringify(offState))
const offText = provider(sessionA)
check('explicit off: body absent from injection',
  !offText.includes('【当前身体：示例 B】') && !offText.includes('【当前身体：示例 A】'))

// The inlined persona rule injects verbatim.
const personaOn = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'persona-example', on: true })
check('persona item togglable',
  personaOn.status === 200 && JSON.parse(personaOn.body || '{}').selection?.['persona-example'] === true, personaOn.body)
check('persona body injected verbatim', provider(sessionA).includes('# 示例人设'))

// Cross-group: the image group (last) joins after the writing group.
await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'image-anchor', on: true })
const imgText = provider(sessionA)
check('image item injected', imgText.includes('【示例条目 · 出图锚点（照抄）】'))
check('image group joins after writing group',
  imgText.indexOf('【示例条目 · 通用写作要求】') < imgText.indexOf('【示例条目 · 出图锚点（照抄）】'))

const unknownItem = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'nope', on: true })
check('unknown item rejected', unknownItem.status === 400, unknownItem.body)

const badOn = await state('POST', '/dsh-rp-control/state', { sessionId: 'session-A', itemId: 'style-plain', on: 'yes' })
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
