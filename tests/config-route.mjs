/**
 * Config-route behaviour: the roster the settings page reads and writes.
 *
 * Every case goes through `apply()` and the real `/dsh-rp-control/config`
 * route, so this proves the whole write path — validation, the atomic
 * tmp-then-rename write, the reset that falls back to the built-in groups, and
 * the guarantee that a roster the host cannot use never breaks prompt
 * assembly.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

let failures = 0
function check (name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else { failures += 1; console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${String(detail)}`}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-rp-config-'))
const configFile = join(dir, 'rp-control.json')
const stateFile = join(dir, 'rp-control-state.json')

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
}, { path: configFile, statePath: stateFile })

const provider = (sessionId) => contexts[0].text({ agent: { id: sessionId } })

async function call (path, method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)])
  req.method = method
  req.url = url
  req.headers = { host: 'localhost:43120', 'content-type': 'application/json', ...headers }
  const chunks = []
  const res = {
    headersSent: false, writableEnded: false, destroyed: false, status: 0,
    writeHead (status) { this.status = status },
    end (text) { this.writableEnded = true; chunks.push(text) },
  }
  const route = routes.find(r => r.path === path)
  if (route === undefined) throw new Error(`no route for ${path}`)
  await route.handler(req, res)
  return { status: res.status, body: chunks.join('') }
}

const CONFIG = '/dsh-rp-control/config'
const config = async (method, body, headers) => await call(CONFIG, method, CONFIG, body, headers)
const json = (result) => JSON.parse(result.body || '{}')

/** A roster that passes validation. */
const sample = (over = {}) => ({
  groups: [
    {
      id: 'style',
      name: '文风',
      desc: '写法',
      items: [
        { id: 'cat', name: '示例甲', desc: '测试', text: '文风正文甲' },
        { id: 'dog', name: '示例乙', textFile: '$DSH_HOME/nope.md' },
      ],
    },
  ],
  ...over,
})

try {
  // 1) No file yet: the built-in roster is in effect and reports no error.
  const initial = await config('GET')
  const initialBody = json(initial)
  check('GET without a file → 200', initial.status === 200, initial.body.slice(0, 120))
  check('GET reports the builtin source', initialBody.source === 'builtin', JSON.stringify(initialBody.source))
  check('GET reports the override path', initialBody.path === configFile, initialBody.path)
  check('GET reports no error', initialBody.error === undefined, JSON.stringify(initialBody.error))
  check('GET returns the builtin persona group alone',
    initialBody.groups?.length === 1 && initialBody.groups[0].id === 'persona',
    JSON.stringify(initialBody.groups?.map(g => g.id)))
  const builtinPersona = initialBody.groups.find(g => g.id === 'persona').items[0]
  check('GET keeps the packaged persona body as a textFile, unresolved',
    builtinPersona.textFile === './personas/example.md' && builtinPersona.text === undefined,
    JSON.stringify(builtinPersona))
  check('GET reports no text error for the builtin roster', initialBody.textError === undefined, initialBody.textError)
  check('GET reports no persona bindings for the builtin roster',
    initialBody.modelPersona === undefined && initialBody.defaultPersona === undefined,
    JSON.stringify({ m: initialBody.modelPersona, d: initialBody.defaultPersona }))

  // 2) PUT writes the roster atomically and the file becomes the source.
  const written = await config('PUT', { config: sample() })
  const writtenBody = json(written)
  check('PUT accepts a valid roster', written.status === 200, written.body.slice(0, 200))
  check('PUT reports the file source', writtenBody.source === 'file', JSON.stringify(writtenBody.source))
  check('file exists after PUT', existsSync(configFile))
  check('no stray .tmp after PUT', !existsSync(`${configFile}.tmp`))
  const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
  check('file holds only groups', JSON.stringify(Object.keys(onDisk)) === '["groups"]', JSON.stringify(Object.keys(onDisk)))
  check('file round-trips the roster',
    onDisk.groups[0].items[0].text === '文风正文甲' && onDisk.groups[0].items[1].textFile === '$DSH_HOME/nope.md',
    JSON.stringify(onDisk.groups[0].items))
  const afterPut = json(await config('GET'))
  check('GET reflects the written roster', afterPut.source === 'file' && afterPut.groups.length === 1, JSON.stringify(afterPut.groups?.length))
  check('GET keeps textFile unresolved',
    afterPut.groups[0].items[1].textFile === '$DSH_HOME/nope.md' && afterPut.groups[0].items[1].text === undefined,
    JSON.stringify(afterPut.groups[0].items[1]))

  // 3) A textFile that cannot be read is surfaced, not fatal: the item is
  //    dropped from injection and the reason rides along with the roster.
  check('unreadable textFile reported as textError',
    typeof afterPut.textError === 'string' && afterPut.textError.includes('nope.md'),
    JSON.stringify(afterPut.textError))
  const partial = provider('s1')
  check('unreadable textFile does not break assembly', typeof partial === 'string', JSON.stringify(partial.slice(0, 40)))

  // 4) Unknown fields are dropped rather than stored.
  const extra = sample({ extra: 1, groups: [{ id: 'g', name: 'G', extra: true, items: [{ id: 'i', name: 'I', text: 'x', extra: 9 }] }] })
  await config('PUT', { config: extra })
  const dropped = JSON.parse(readFileSync(configFile, 'utf8'))
  check('unknown fields dropped',
    dropped.extra === undefined && dropped.groups[0].extra === undefined && dropped.groups[0].items[0].extra === undefined,
    JSON.stringify(dropped))

  // 5) Validation refusals: every one is a 400 with the offending path.
  const refusals = [
    ['no config field', { config: undefined }, 'config must be an object'],
    ['groups not an array', { config: { groups: 'nope' } }, 'config.groups must be a non-empty array'],
    ['empty groups', { config: { groups: [] } }, 'config.groups must be a non-empty array'],
    ['group id missing', { config: { groups: [{ name: 'G', items: [{ id: 'i', name: 'I', text: 'x' }] }] } }, 'groups[0].id'],
    ['duplicate group id', { config: { groups: [
      { id: 'a', name: 'A', items: [{ id: 'i1', name: 'I', text: 'x' }] },
      { id: 'a', name: 'B', items: [{ id: 'i2', name: 'I', text: 'x' }] },
    ] } }, 'duplicated'],
    ['duplicate item id across groups', { config: { groups: [
      { id: 'a', name: 'A', items: [{ id: 'same', name: 'I', text: 'x' }] },
      { id: 'b', name: 'B', items: [{ id: 'same', name: 'I', text: 'x' }] },
    ] } }, 'duplicated'],
    ['item without text', { config: { groups: [{ id: 'a', name: 'A', items: [{ id: 'i', name: 'I' }] }] } }, 'text or textFile'],
    ['empty items', { config: { groups: [{ id: 'a', name: 'A', items: [] }] } }, 'items must be a non-empty array'],
    ['unknown default item', { config: { groups: [{ id: 'a', name: 'A', defaultItems: ['ghost'], items: [{ id: 'i', name: 'I', text: 'x' }] }] } }, 'not an item of this group'],
    ['legacy unknown default item', { config: { groups: [{ id: 'a', name: 'A', defaultItem: 'ghost', items: [{ id: 'i', name: 'I', text: 'x' }] }] } }, 'not an item of this group'],
    ['defaultItems not an array', { config: { groups: [{ id: 'a', name: 'A', defaultItems: 'i', items: [{ id: 'i', name: 'I', text: 'x' }] }] } }, 'must be an array of item ids'],
    ['defaultItems holding a non-string', { config: { groups: [{ id: 'a', name: 'A', defaultItems: [7], items: [{ id: 'i', name: 'I', text: 'x' }] }] } }, 'must hold non-empty item ids'],
    ['two defaults in an exclusive group', { config: { groups: [{ id: 'a', name: 'A', exclusive: true, defaultItems: ['i', 'j'],
      items: [{ id: 'i', name: 'I', text: 'x' }, { id: 'j', name: 'J', text: 'y' }] }] } }, 'at most one id while exclusive is true'],
    ['exclusive not boolean', { config: { groups: [{ id: 'a', name: 'A', exclusive: 'yes', items: [{ id: 'i', name: 'I', text: 'x' }] }] } }, 'exclusive must be a boolean'],
    ['item name empty', { config: { groups: [{ id: 'a', name: 'A', items: [{ id: 'i', name: '', text: 'x' }] }] } }, 'name must be a non-empty string'],
  ]
  for (const [label, body, needle] of refusals) {
    const refused = await config('PUT', body)
    const refusedBody = json(refused)
    check(`rejects ${label}`,
      refused.status === 400 && refusedBody.error === 'invalid-config' && String(refusedBody.reason).includes(needle),
      `${refused.status} ${refused.body}`)
  }
  const stillDropped = JSON.parse(readFileSync(configFile, 'utf8'))
  check('a refused PUT leaves the file untouched', stillDropped.groups[0].id === 'g', JSON.stringify(stillDropped.groups[0].id))

  // 6) Defaults: several per group, exclusive groups capped at one, and the
  //    legacy single field still accepted on the way in but never written.
  const twoDefaults = { config: {
    groups: [{ id: 'style', name: '文风', defaultItems: ['cat', 'dog'],
      items: [{ id: 'cat', name: '示例甲', text: '默认文风甲' }, { id: 'dog', name: '示例乙', text: '默认文风乙' }] }],
  } }
  const multi = await config('PUT', twoDefaults)
  check('PUT accepts several defaults in one group', multi.status === 200, multi.body.slice(0, 200))
  check('a fresh session turns on every default',
    provider('fresh').includes('默认文风甲') && provider('fresh').includes('默认文风乙'),
    JSON.stringify(provider('fresh').slice(0, 80)))
  const freshState = json(await call('/dsh-rp-control/state', 'GET', '/dsh-rp-control/state?sessionId=fresh'))
  check('the state route reports both defaults',
    freshState.selection?.cat === true && freshState.selection?.dog === true, JSON.stringify(freshState.selection))
  check('the written file carries defaultItems',
    JSON.stringify(JSON.parse(readFileSync(configFile, 'utf8')).groups[0].defaultItems) === '["cat","dog"]',
    JSON.stringify(JSON.parse(readFileSync(configFile, 'utf8')).groups[0]))
  check('the written file never carries the legacy field',
    !readFileSync(configFile, 'utf8').includes('"defaultItem"'), readFileSync(configFile, 'utf8').slice(0, 160))

  // An explicit off still suppresses the whole group's defaults.
  await call('/dsh-rp-control/state', 'POST', '/dsh-rp-control/state', { sessionId: 'fresh', itemId: 'cat', on: false })
  check('explicitly off suppresses both defaults',
    !provider('fresh').includes('默认文风甲') && !provider('fresh').includes('默认文风乙'),
    JSON.stringify(provider('fresh').slice(0, 80)))

  const legacy = await config('PUT', { config: {
    groups: [{ id: 'style', name: '文风', defaultItem: 'cat',
      items: [{ id: 'cat', name: '示例甲', text: '旧字段默认正文' }] }],
  } })
  check('PUT still accepts the legacy single defaultItem', legacy.status === 200, legacy.body.slice(0, 160))
  check('legacy input is upgraded to defaultItems',
    JSON.stringify(JSON.parse(readFileSync(configFile, 'utf8')).groups[0].defaultItems) === '["cat"]',
    JSON.stringify(JSON.parse(readFileSync(configFile, 'utf8')).groups[0]))
  check('upgraded default drives a fresh session', provider('legacy-fresh').includes('旧字段默认正文'),
    JSON.stringify(provider('legacy-fresh').slice(0, 60)))

  const deduped = await config('PUT', { config: {
    groups: [{ id: 'style', name: '文风', defaultItems: ['cat', 'cat'],
      items: [{ id: 'cat', name: '示例甲', text: '去重正文' }] }],
  } })
  check('a repeated default id is collapsed, not refused', deduped.status === 200, deduped.body.slice(0, 160))
  check('the duplicate is gone from the file',
    JSON.stringify(JSON.parse(readFileSync(configFile, 'utf8')).groups[0].defaultItems) === '["cat"]',
    JSON.stringify(JSON.parse(readFileSync(configFile, 'utf8')).groups[0].defaultItems))

  const exclusiveOne = await config('PUT', { config: {
    groups: [{ id: 'body', name: '身体', exclusive: true, defaultItems: ['cat'],
      items: [{ id: 'cat', name: '示例甲', text: '默认身体正文' }, { id: 'dog', name: '示例乙', text: '另一个身体' }] }],
  } })
  check('one default in an exclusive group is accepted', exclusiveOne.status === 200, exclusiveOne.body.slice(0, 160))
  check('the exclusive default injects for an untouched session',
    provider('exclusive-fresh').includes('默认身体正文'), JSON.stringify(provider('exclusive-fresh').slice(0, 60)))

  // A file written by hand before this vocabulary still works: the lenient
  // read path turns a lone `defaultItem` into `defaultItems`.
  writeFileSync(configFile, JSON.stringify({ groups: [{ id: 'persona', name: '人格', defaultItem: 'persona-a',
    items: [{ id: 'persona-a', name: '人设 A', text: '手写旧文件正文' }] }] }))
  const handWritten = json(await config('GET'))
  check('a hand-written legacy file is read as defaultItems',
    JSON.stringify(handWritten.groups[0].defaultItems) === '["persona-a"]' && handWritten.groups[0].defaultItem === undefined,
    JSON.stringify(handWritten.groups[0]))
  check('the legacy file injects for an untouched session', provider('legacy-file').includes('手写旧文件正文'),
    JSON.stringify(provider('legacy-file').slice(0, 60)))

  // An exclusive group whose hand-written file names two defaults keeps the
  // first: the lenient path drops rather than throws, and a radio group must
  // never come up with two switches on.
  writeFileSync(configFile, JSON.stringify({ groups: [{ id: 'body', name: '身体', exclusive: true, defaultItems: ['cat', 'dog'],
    items: [{ id: 'cat', name: '示例甲', text: '手写单选甲' }, { id: 'dog', name: '示例乙', text: '手写单选乙' }] }] }))
  const radioFile = json(await config('GET'))
  check('a hand-written exclusive pair is truncated on read',
    JSON.stringify(radioFile.groups[0].defaultItems) === '["cat"]', JSON.stringify(radioFile.groups[0].defaultItems))
  check('only the first exclusive default injects',
    provider('radio-file').includes('手写单选甲') && !provider('radio-file').includes('手写单选乙'),
    JSON.stringify(provider('radio-file').slice(0, 80)))


  // A roster with a persona group, which persona bindings must name an item of.
  const personaRoster = {
    groups: [
      { id: 'persona', name: '人格', exclusive: true, items: [
        { id: 'persona-a', name: '人设 A', text: '人设正文 A' },
        { id: 'persona-b', name: '人设 B', text: '人设正文 B' },
      ] },
    ],
  }
  const boundProvider = (sessionId, route) => contexts[0].text({
    agent: { id: sessionId, session: { requestHeader: () => ({ config: route }) } },
  })

  // 6b) Persona bindings round-trip through the same document as the roster.
  const withBindings = await config('PUT', { config: {
    ...personaRoster,
    modelPersona: { 'provA/modelA': 'persona-b' },
    defaultPersona: 'persona-a',
  } })
  check('PUT accepts persona bindings', withBindings.status === 200, withBindings.body.slice(0, 200))
  const bindingsBack = json(await config('GET'))
  check('GET returns the persona bindings',
    JSON.stringify(bindingsBack.modelPersona) === '{"provA/modelA":"persona-b"}' && bindingsBack.defaultPersona === 'persona-a',
    JSON.stringify({ m: bindingsBack.modelPersona, d: bindingsBack.defaultPersona }))
  check('the file holds groups + bindings, and nothing else',
    JSON.stringify(Object.keys(JSON.parse(readFileSync(configFile, 'utf8'))).sort()) === '["defaultPersona","groups","modelPersona"]',
    JSON.stringify(Object.keys(JSON.parse(readFileSync(configFile, 'utf8')))))
  check('a bound model forces its persona in the prompt',
    boundProvider('cr-bound', { provider: 'provA', model: 'modelA' }).includes('人设正文 B')
      && !boundProvider('cr-bound', { provider: 'provA', model: 'modelA' }).includes('人设正文 A'),
    JSON.stringify(boundProvider('cr-bound', { provider: 'provA', model: 'modelA' }).slice(0, 40)))
  check('an unbound model falls back to defaultPersona',
    boundProvider('cr-other', { provider: 'provZ', model: 'modelZ' }).includes('人设正文 A'),
    JSON.stringify(boundProvider('cr-other', { provider: 'provZ', model: 'modelZ' }).slice(0, 40)))
  // A route with no provider is reported as the bare model name, which cannot
  // match a `<provider>/<model>` binding — so it falls back, and it must not
  // shadow the paired route another node of the same context reports.
  check('a provider-less model string cannot match a paired binding',
    boundProvider('cr-bare', { model: 'modelA' }).includes('人设正文 A'),
    JSON.stringify(boundProvider('cr-bare', { model: 'modelA' }).slice(0, 40)))
  check('a bare model string never shadows a paired route in the same context',
    contexts[0].text({
      agent: { id: 'cr-shadow', model: 'modelA', session: { requestHeader: () => ({ config: { provider: 'provA', model: 'modelA' } }) } },
    }).includes('人设正文 B'))

  // The chain the page shows is read back off the assembly probe, and reflects
  // the most recent assembly — so read it right after a paired one.
  boundProvider('cr-bound', { provider: 'provA', model: 'modelA' })
  const diag = json(await config('GET')).personaDiag
  check('the payload reports the model → persona chain the last assembly resolved',
    typeof diag === 'object' && diag !== null && diag.modelKey === 'provA/modelA' && diag.personaId === 'persona-b' && diag.source === 'model',
    JSON.stringify(diag))

  // 6c) Persona binding refusals: a binding the runtime would silently ignore
  //     is a typo, and the page can only report what the host refuses.
  const bindingRefusals = [
    ['modelPersona not an object', { modelPersona: ['persona-a'] }, 'modelPersona must be an object'],
    ['modelPersona key without a provider', { modelPersona: { modelA: 'persona-a' } }, 'must be written "<provider>/<model>"'],
    ['modelPersona value not a persona item', { modelPersona: { 'a/b': 'ghost' } }, 'is not an item of the persona group'],
    ['modelPersona value not a string', { modelPersona: { 'a/b': 7 } }, 'must be a non-empty persona item id'],
    ['modelPersona value empty', { modelPersona: { 'a/b': '' } }, 'must be a non-empty persona item id'],
    ['defaultPersona not a persona item', { defaultPersona: 'ghost' }, 'is not an item of the persona group'],
    ['defaultPersona empty', { defaultPersona: '' }, 'must be a non-empty persona item id'],
    ['defaultPersona naming a non-persona item', { defaultPersona: 'style-light' }, 'is not an item of the persona group'],
  ]
  for (const [label, over, needle] of bindingRefusals) {
    const refused = await config('PUT', { config: { ...personaRoster, ...over } })
    const refusedBody = json(refused)
    check(`rejects ${label}`,
      refused.status === 400 && refusedBody.error === 'invalid-config' && String(refusedBody.reason).includes(needle),
      `${refused.status} ${refused.body}`)
  }
  check('a refused binding PUT left the file as it was',
    JSON.parse(readFileSync(configFile, 'utf8')).defaultPersona === 'persona-a')

  // A binding naming an item of a non-persona group is refused too, so the
  // runtime can never be handed a persona it would silently drop.
  const noPersonaGroup = await config('PUT', { config: { ...sample(), defaultPersona: 'cat' } })
  check('rejects a binding when the roster has no persona group',
    noPersonaGroup.status === 400 && String(json(noPersonaGroup).reason).includes('is not an item of the persona group'),
    `${noPersonaGroup.status} ${noPersonaGroup.body}`)

  // A PUT that omits the bindings clears them, because the page writes the
  // whole document it is editing.
  const cleared = await config('PUT', { config: personaRoster })
  check('PUT without bindings clears them',
    cleared.status === 200 && json(await config('GET')).defaultPersona === undefined
      && !readFileSync(configFile, 'utf8').includes('modelPersona'),
    readFileSync(configFile, 'utf8').slice(0, 160))

  // 7) Request-level refusals.
  const noJson = await config('PUT', sample(), { 'content-type': 'text/plain' })
  check('PUT without JSON content-type → 415', noJson.status === 415, `${noJson.status} ${noJson.body}`)
  const brokenJson = await config('PUT', '{ not json')
  check('PUT with broken JSON → 400 invalid-request', brokenJson.status === 400 && json(brokenJson).error === 'invalid-request', brokenJson.body)
  const notObject = await config('PUT', [1, 2, 3])
  check('PUT with a non-object body → 400', notObject.status === 400, notObject.body)
  const post = await config('POST', sample())
  check('POST → 405', post.status === 405, post.body)
  const foreign = await config('GET', undefined, { origin: 'http://evil.example' })
  check('foreign Origin → 403', foreign.status === 403, foreign.body)
  const sameOrigin = await config('GET', undefined, { origin: 'http://localhost:43120' })
  check('same Origin → 200', sameOrigin.status === 200, sameOrigin.body)

  // 8) The body limit accepts a rule body far past the old 8 KiB toggle limit.
  const longText = '守'.repeat(600 * 1024)
  const big = await config('PUT', { config: { groups: [{ id: 'big', name: '大正文', items: [{ id: 'big', name: '大', text: longText }] }] } })
  check('PUT accepts a 600k-character rule body', big.status === 200, `${big.status} ${big.body.slice(0, 120)}`)
  check('big body round-trips at full length',
    JSON.parse(readFileSync(configFile, 'utf8')).groups[0].items[0].text.length === longText.length)
  const tooBig = await config('PUT', { config: { groups: [{ id: 'big', name: '大正文', items: [{ id: 'big', name: '大', text: 'x'.repeat(5 * 1024 * 1024) }] }] } })
  check('PUT past the 4 MiB limit → 413', tooBig.status === 413, `${tooBig.status} ${tooBig.body.slice(0, 120)}`)

  // 9) A damaged file degrades to the builtin roster, reports why, and still
  //    lets the next prompt assemble.
  writeFileSync(configFile, '{ this is not json')
  const damaged = json(await config('GET'))
  check('broken file → builtin source', damaged.source === 'builtin', JSON.stringify(damaged.source))
  check('broken file → reason reported', typeof damaged.error === 'string' && damaged.error.length > 0, JSON.stringify(damaged.error))
  check('broken file → builtin roster kept', damaged.groups.length === 1, JSON.stringify(damaged.groups?.map(g => g.id)))
  check('broken file does not break assembly', typeof provider('s1') === 'string')

  writeFileSync(configFile, JSON.stringify({ groups: 'nope' }))
  const wrongShape = json(await config('GET'))
  check('structurally wrong file → builtin + reason',
    wrongShape.source === 'builtin' && typeof wrongShape.error === 'string', JSON.stringify(wrongShape.error))

  // 10) DELETE restores the builtin roster.
  const deleted = json(await config('DELETE'))
  check('DELETE → 200 builtin', deleted.source === 'builtin' && deleted.groups.length === 1, JSON.stringify(deleted.source))
  check('DELETE removes the file', !existsSync(configFile))
  check('DELETE without a file is still 200', (await config('DELETE')).status === 200)

  // 11) PUT { reset: true } is the same reset.
  await config('PUT', { config: sample() })
  check('file back before reset', existsSync(configFile))
  const reset = json(await config('PUT', { reset: true }))
  check('PUT {reset:true} → builtin', reset.source === 'builtin' && !existsSync(configFile), JSON.stringify(reset.source))

  // 12) The shipped example file is a real override document: keep it loadable
  //     so the format sample cannot drift away from the vocabulary it shows.
  const examplePath = join(import.meta.dirname, '..', 'rp-control.example.json')
  const example = JSON.parse(readFileSync(examplePath, 'utf8'))
  const exampleWrite = await config('PUT', { config: example })
  check('the shipped example file passes validation', exampleWrite.status === 200, exampleWrite.body.slice(0, 200))
  const exampleBack = json(await config('GET'))
  check('the example file round-trips',
    exampleBack.source === 'file' && exampleBack.groups.length === example.groups.length,
    JSON.stringify(exampleBack.groups?.map(g => g.id)))
  check('the example file shows one default in its exclusive group',
    JSON.stringify(exampleBack.groups[0]?.defaultItems) === '["persona-example"]',
    JSON.stringify(exampleBack.groups[0]?.defaultItems))
  check('the example file shows the persona bindings',
    Object.keys(exampleBack.modelPersona ?? {}).length === 2 && exampleBack.defaultPersona === 'persona-example',
    JSON.stringify({ m: exampleBack.modelPersona, d: exampleBack.defaultPersona }))

  // 13) A write that cannot land is reported rather than thrown.
  rmSync(dir, { recursive: true, force: true })
  const unwritable = await config('PUT', { config: sample() })
  check('unwritable path → 500 with the reason',
    unwritable.status === 500 && /write-failed/.test(json(unwritable).error ?? ''), `${unwritable.status} ${unwritable.body.slice(0, 160)}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
