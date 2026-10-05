/**
 * Override-file behaviour: the editable-config half of the objective.
 *
 * Every case goes through `apply()` and the real route, so it proves the file
 * is re-read per request (an edit lands on the next turn) rather than being
 * captured once at load, and that `textFile` items are re-read too (and their
 * `>`-prefixed human-only lines are filtered out). A broken file degrades to
 * the built-in groups instead of throwing.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

let failures = 0
function check (name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else { failures += 1; console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${String(detail)}`}`) }
}

/** Mount the plugin against a config path and return its route + provider. */
function mount (config) {
  const routes = []
  const contexts = []
  const variables = []
  const promptCtx = {
    systemPrompt: {
      context (c) { contexts.push(c); return () => {} },
      variable (varName, provider) { variables.push({ name: varName, provider }); return () => {} },
    },
  }
  apply({
    effect (fn) { fn(); return () => {} },
    webServer: { register (r) { routes.push(r); return () => {} } },
    inject (_deps, callback) { callback(promptCtx) },
  }, { ...config, statePath: stateFile })
  /**
   * The host resolves the session's model out of the assembly context, so a
   * model-bearing fake is a session object whose `requestHeader()` reports one
   * — the same surface `api-session` itself reads.
   */
  const session = (sessionId, route) => ({
    agent: {
      id: sessionId,
      ...(route === undefined ? {} : { session: { requestHeader: () => ({ config: route }) } }),
    },
  })
  const provider = (sessionId, route) => contexts[0].text(session(sessionId, route))
  const promptVariable = (sessionId, route) => variables[0].provider(session(sessionId, route))
  const call = async (method, url, body) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.method = method
    req.url = url
    req.headers = { host: 'localhost:43120', 'content-type': 'application/json' }
    const chunks = []
    const res = {
      headersSent: false, writableEnded: false, destroyed: false, status: 0,
      writeHead (status) { this.status = status },
      end (text) { this.writableEnded = true; chunks.push(text) },
    }
    await routes[0].handler(req, res)
    return { status: res.status, body: chunks.join('') }
  }
  return { provider, promptVariable, call }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-rp-control-'))
const file = join(dir, 'rp-control.json')
const stateFile = join(dir, 'rp-control-state.json')
const GET = '/dsh-rp-control/state?sessionId=s1'

async function groupsOf (call) {
  return JSON.parse((await call('GET', GET)).body).groups
}

try {
  // 1) A file config replaces the built-in groups (inline text).
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'style', name: '文风', items: [{ id: 'cat', name: '示例甲', desc: '测试', text: '文风正文甲' }] }],
  }))
  const one = mount({ path: file })
  const g1 = await groupsOf(one.call)
  check('file groups replace builtin', g1.length === 1 && g1[0].items[0].id === 'cat' && g1[0].items[0].text === '文风正文甲', JSON.stringify(g1))
  const sel = await one.call('POST', '/dsh-rp-control/state', { sessionId: 's1', itemId: 'cat', on: true })
  check('custom item toggleable + injectable',
    sel.status === 200 && one.provider('s1') === '文风正文甲', sel.body)

  // 2) The file is re-read per request: an edit lands without a restart.
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'style', name: '文风', items: [{ id: 'cat', name: '示例甲改', text: '改后正文甲' }] }],
  }))
  const g2 = await groupsOf(one.call)
  check('edit applies on the next request', g2[0].items[0].name === '示例甲改', JSON.stringify(g2))

  // 3) textFile: an absolute path is resolved to the file's contents.
  const md = join(dir, 'persona.md')
  writeFileSync(md, '人设正文第一版')
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'persona', name: '人格', items: [{ id: 'persona-a', name: '人设 A', textFile: md }] }],
  }))
  const three = mount({ path: file })
  const g3 = await groupsOf(three.call)
  check('textFile resolved', g3.length === 1 && g3[0].items[0].text === '人设正文第一版', JSON.stringify(g3))
  check('textFile item injects file content',
    (await three.call('POST', '/dsh-rp-control/state', { sessionId: 's1', itemId: 'persona-a', on: true })).status === 200
      && three.provider('s1') === '人设正文第一版')

  // 4) textFile is re-read too: an edit lands on the next turn.
  writeFileSync(md, '人设正文第二版')
  const g4 = await groupsOf(three.call)
  check('textFile re-read on next request', g4[0].items[0].text === '人设正文第二版', JSON.stringify(g4))

  // 5) textFile filters human-only `>` lines (quote blocks kept for humans).
  writeFileSync(md, '> 给人看的引用块\n正文第一行\n> 又一条引用\n正文第二行')
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'p', name: 'P', items: [{ id: 'm', name: 'M', textFile: md }] }],
  }))
  const g5 = await groupsOf(mount({ path: file }).call)
  check('textFile filters > lines', g5[0].items[0].text === '正文第一行\n正文第二行', JSON.stringify(g5[0].items[0].text))

  // 6) $DSH_HOME expansion in a textFile path.
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    writeFileSync(join(dir, 'home.md'), '家目录正文')
    writeFileSync(file, JSON.stringify({
      groups: [{ id: 'p', name: 'P', items: [{ id: 'm', name: 'M', textFile: '$DSH_HOME/home.md' }] }],
    }))
    const g6 = await groupsOf(mount({ path: file }).call)
    check('$DSH_HOME expanded in textFile', g6[0].items[0].text === '家目录正文', JSON.stringify(g6))
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }

  // 7) A malformed file degrades to the built-in groups instead of failing.
  writeFileSync(file, '{ this is not json')
  const g7 = await groupsOf(mount({ path: file }).call)
  check('broken JSON falls back to builtin',
    g7.some(g => g.id === 'persona') && g7.reduce((n, g) => n + g.items.length, 0) === 2,
    JSON.stringify(g7.map(g => g.id)))

  // 8) Invalid fields (groups not an array) also fall back.
  writeFileSync(file, JSON.stringify({ groups: 'nope' }))
  const g8 = await groupsOf(mount({ path: file }).call)
  check('non-array groups falls back to builtin', g8.some(g => g.id === 'persona'), JSON.stringify(g8.map(g => g.id)))

  // 9) Malformed entries are dropped, valid ones survive.
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'style', name: '文风', items: [{ id: 'ok', name: 'OK', text: 'fine' }, { id: 'bad' }, { name: 'no-id', text: 'a' }] }],
  }))
  const g9 = await groupsOf(mount({ path: file }).call)
  check('malformed items dropped, valid kept',
    g9.length === 1 && g9[0].items.length === 1 && g9[0].items[0].id === 'ok', JSON.stringify(g9))

  // 10) A missing textFile makes the item (and group) unavailable → builtin.
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'p', name: 'P', items: [{ id: 'm', name: 'M', textFile: join(dir, 'nope.md') }] }],
  }))
  const g10 = await groupsOf(mount({ path: file }).call)
  check('missing textFile drops item → builtin', g10.some(g => g.id === 'persona'), JSON.stringify(g10.map(g => g.id)))

  // 11) An empty textFile is likewise unavailable.
  writeFileSync(join(dir, 'empty.md'), '   ')
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'p', name: 'P', items: [{ id: 'm', name: 'M', textFile: join(dir, 'empty.md') }] }],
  }))
  const g11 = await groupsOf(mount({ path: file }).call)
  check('empty textFile drops item → builtin', g11.some(g => g.id === 'persona'), JSON.stringify(g11.map(g => g.id)))

  // 12) A missing file is the normal case and reports nothing.
  const missing = mount({ path: join(dir, 'absent.json') })
  const g12 = await groupsOf(missing.call)
  check('missing file uses builtin', g12.some(g => g.id === 'persona'), JSON.stringify(g12.map(g => g.id)))
  check('missing file injects nothing for an untouched session', missing.provider('never-touched') === '',
    JSON.stringify(missing.provider('never-touched').slice(0, 60)))
  const g12Persona = g12.find(g => g.id === 'persona')?.items?.[0]
  check('builtin persona body ships as a packaged file, resolved to its text',
    typeof g12Persona?.text === 'string' && g12Persona.text.length > 200 && g12Persona.textFile === undefined,
    JSON.stringify({ textFile: g12Persona?.textFile, textLength: g12Persona?.text?.length }))

  // 13) The legacy single `defaultItem` is read as a one-entry `defaultItems`,
  //     so a file written before a group could default several items still works.
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'p', name: 'P', defaultItem: 'm', items: [{ id: 'm', name: 'M', text: '旧写法默认' }] }],
  }))
  const legacy = mount({ path: file })
  const g13 = await groupsOf(legacy.call)
  check('legacy defaultItem reads as defaultItems',
    JSON.stringify(g13[0]?.defaultItems) === '["m"]' && g13[0]?.defaultItem === undefined,
    JSON.stringify(g13[0]))
  check('legacy defaultItem still injects', legacy.provider('fresh-session').includes('旧写法默认'),
    JSON.stringify(legacy.provider('fresh-session').slice(0, 40)))

  // 14) Several defaults in one group, and the untouched-group rule: an
  //     explicit value anywhere in the group suppresses all of them.
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'p', name: 'P', defaultItems: ['a', 'b'],
      items: [{ id: 'a', name: 'A', text: '默认甲' }, { id: 'b', name: 'B', text: '默认乙' }] }],
  }))
  const multi = mount({ path: file })
  const multiText = multi.provider('untouched')
  check('every default of an untouched group injects',
    multiText.includes('默认甲') && multiText.includes('默认乙'), JSON.stringify(multiText.slice(0, 60)))
  await multi.call('POST', '/dsh-rp-control/state', { sessionId: 'untouched', itemId: 'b', on: false })
  check('one explicit off suppresses the group defaults',
    !multi.provider('untouched').includes('默认甲') && !multi.provider('untouched').includes('默认乙'),
    JSON.stringify(multi.provider('untouched').slice(0, 60)))

  // 15) An exclusive group defaults at most one item even from a hand-edited
  //     file that names two: a radio group must never start with both on.
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'p', name: 'P', exclusive: true, defaultItems: ['a', 'b'],
      items: [{ id: 'a', name: 'A', text: '单选甲' }, { id: 'b', name: 'B', text: '单选乙' }] }],
  }))
  const radio = mount({ path: file })
  const g15 = await groupsOf(radio.call)
  check('exclusive file pair truncates to the first',
    JSON.stringify(g15[0]?.defaultItems) === '["a"]', JSON.stringify(g15[0]?.defaultItems))
  check('only the first exclusive default injects',
    radio.provider('radio-session').includes('单选甲') && !radio.provider('radio-session').includes('单选乙'),
    JSON.stringify(radio.provider('radio-session').slice(0, 60)))

  // 16) `./`-prefixed textFile paths resolve against the plugin package root,
  //     so a roster may ship its own persona files. `$DSH_HOME` must not win,
  //     and the other forms keep their old meaning (cases 3-6 above).
  const prevHome16 = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    mkdirSync(join(dir, 'personas'), { recursive: true })
    writeFileSync(join(dir, 'personas', 'example.md'), '家目录里的同名文件')
    writeFileSync(file, JSON.stringify({
      groups: [{ id: 'persona', name: '人格', exclusive: true,
        items: [{ id: 'persona-example', name: '示例人设', textFile: './personas/example.md' }] }],
    }))
    const packaged = mount({ path: file })
    const g16 = await groupsOf(packaged.call)
    const packagedText = g16[0]?.items?.[0]?.text
    check('a ./ textFile resolves against the plugin package root, not DSH_HOME',
      typeof packagedText === 'string' && packagedText.startsWith('# 示例人设') && packagedText.includes('示例人设'),
      JSON.stringify({ first: packagedText?.slice(0, 24), home: join(dir, 'personas', 'example.md') }))
    check('the ./ textFile is the same body the built-in roster injects',
      packagedText === g12Persona?.text,
      JSON.stringify({ packaged: packagedText?.length, builtin: g12Persona?.text?.length }))
    check('a missing ./ file drops the item and surfaces the reason',
      (() => {
        writeFileSync(file, JSON.stringify({
          groups: [{ id: 'persona', name: '人格',
            items: [{ id: 'persona-example', name: '示例人设', textFile: './personas/absent-xyz.md' }] }],
        }))
        return true
      })())
    const missingPackaged = mount({ path: file })
    const g16b = await groupsOf(missingPackaged.call)
    check('a missing ./ file falls back to the built-in roster',
      g16b.some(g => g.id === 'persona'), JSON.stringify(g16b.map(g => g.id)))
  } finally {
    if (prevHome16 === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome16
  }

  // 17) The model → persona chain, end to end through `apply()`: an exact
  //     `modelPersona` hit forces that persona, an unbound model falls back to
  //     `defaultPersona`, and with neither bound the hand-picked switch stands.
  writeFileSync(file, JSON.stringify({
    groups: [
      { id: 'persona', name: '人格', exclusive: true, items: [
        { id: 'persona-a', name: '人设 A', text: '人设正文 A' },
        { id: 'persona-b', name: '人设 B', text: '人设正文 B' },
      ] },
    ],
    modelPersona: { 'provA/modelA': 'persona-b' },
    defaultPersona: 'persona-a',
  }))
  const bound = mount({ path: file })
  const ROUTE_A = { provider: 'provA', model: 'modelA' }
  const ROUTE_B = { provider: 'provB', model: 'modelB' }
  check('a bound model forces its persona into the injected text',
    bound.provider('s-bound', ROUTE_A).includes('人设正文 B')
      && !bound.provider('s-bound', ROUTE_A).includes('人设正文 A'),
    JSON.stringify(bound.provider('s-bound', ROUTE_A).slice(0, 40)))
  check('the same session switches persona when the model switches',
    bound.provider('s-bound', ROUTE_B).includes('人设正文 A')
      && !bound.provider('s-bound', ROUTE_B).includes('人设正文 B'),
    JSON.stringify(bound.provider('s-bound', ROUTE_B).slice(0, 40)))
  check('a session with no observable model falls back to defaultPersona',
    bound.provider('s-fresh').includes('人设正文 A'), JSON.stringify(bound.provider('s-fresh').slice(0, 40)))
  check('a model already observed for a session is kept when a later probe finds none',
    bound.provider('s-bound').includes('人设正文 A') && !bound.provider('s-bound').includes('人设正文 B'),
    JSON.stringify(bound.provider('s-bound').slice(0, 40)))
  check('the forced persona reaches the rp_control_prompt variable too',
    bound.promptVariable('s-bound', ROUTE_A) === bound.provider('s-bound', ROUTE_A)
      && bound.promptVariable('s-bound', ROUTE_A).includes('人设正文 B'))
  check('the state route reports the forced persona, so the pill agrees',
    (await bound.call('GET', '/dsh-rp-control/state?sessionId=s-bound')).status === 200)
  const boundSel = JSON.parse((await bound.call('GET', '/dsh-rp-control/state?sessionId=s-bound')).body).selection
  check('the reported selection carries the model persona',
    boundSel['persona-b'] === true && boundSel['persona-a'] === undefined, JSON.stringify(boundSel))
  // The override is derived, never persisted: toggling inside the scene while a
  // model is bound must not write the forced persona into the scene state.
  await bound.call('POST', '/dsh-rp-control/state', { sessionId: 's-bound', itemId: 'persona-a', on: false })
  const persisted = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { sessions: {} }
  check('the model persona is never persisted into the session selection',
    persisted.sessions?.['s-bound']?.['persona-a'] === false
      && persisted.sessions?.['s-bound']?.['persona-b'] === undefined,
    JSON.stringify(persisted.sessions?.['s-bound']))
  check('an explicit off is still overridden in the prompt while the model is bound',
    bound.provider('s-bound', ROUTE_A).includes('人设正文 B')
      && !bound.provider('s-bound', ROUTE_A).includes('人设正文 A'),
    JSON.stringify(bound.provider('s-bound', ROUTE_A).slice(0, 40)))

  // With no bindings at all, the master keeps full manual control.
  writeFileSync(file, JSON.stringify({
    groups: [{ id: 'persona', name: '人格', exclusive: true, items: [
      { id: 'persona-a', name: '人设 A', text: '人设正文 A' },
      { id: 'persona-b', name: '人设 B', text: '人设正文 B' },
    ] }],
  }))
  const unbound = mount({ path: file })
  check('no bindings: an untouched session injects nothing',
    unbound.provider('s-free', ROUTE_A) === '', JSON.stringify(unbound.provider('s-free', ROUTE_A)))
  await unbound.call('POST', '/dsh-rp-control/state', { sessionId: 's-free', itemId: 'persona-b', on: true })
  check('no bindings: the hand-picked persona stands even for a bound-looking model',
    unbound.provider('s-free', ROUTE_A).includes('人设正文 B'), JSON.stringify(unbound.provider('s-free', ROUTE_A).slice(0, 40)))
  check('no bindings: the variable answers the fixed fallback only when nothing is on',
    unbound.promptVariable('s-never', ROUTE_A) === '（本轮未启用任何 RP 模块。）',
    JSON.stringify(unbound.promptVariable('s-never', ROUTE_A)))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
