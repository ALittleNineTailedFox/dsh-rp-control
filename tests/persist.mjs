/**
 * Selection persistence: the per-session scene state must survive a restart.
 *
 * Each case mounts a fresh instance (fresh `apply()`) against a temp state
 * file, so "mount again" genuinely simulates a host restart. Proves atomic
 * write, read-back, off-clearing, exclusive-group round-trips, and the
 * fault-tolerant empty-state fallback.
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

/** Mount the plugin against a temp config + state path and return route/provider. */
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
  }, { path: join(dir, 'nope.json'), ...config })
  const provider = (sessionId) => contexts[0].text({ agent: { id: sessionId } })
  const promptVariable = (sessionId) => variables[0].provider({ agent: { id: sessionId } })
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

const dir = mkdtempSync(join(tmpdir(), 'dsh-rp-state-'))
const stateFile = join(dir, 'rp-control-state.json')
const GET = '/dsh-rp-control/state?sessionId=s1'
const DIAG = '/dsh-rp-control/state?sessionId=s1&diag=1'

try {
  // 1) Missing state file → nothing on (no group carries a default).
  const a = mount({ statePath: stateFile })
  const aSel = JSON.parse((await a.call('GET', GET)).body).selection
  check('missing state file → nothing on', Object.keys(aSel).length === 0, JSON.stringify(aSel))
  check('missing state file → nothing injected', a.provider('s1') === '', JSON.stringify(a.provider('s1').slice(0, 60)))

  // 2) A toggle persists immediately, and a fresh instance reads it back.
  await a.call('POST', '/dsh-rp-control/state', { sessionId: 's1', itemId: 'style-plain', on: true })
  check('state file written after POST', readFileSync(stateFile, 'utf8').includes('"style-plain": true'))
  const b = mount({ statePath: stateFile })
  const bSel = JSON.parse((await b.call('GET', GET)).body).selection
  check('restart restores style-plain', bSel['style-plain'] === true, JSON.stringify(bSel))
  check('restart provider injects item', b.provider('s1').includes('【示例条目 · 平实白描】'))

  // 3) Exclusive body switch persists: B on, A off across restart.
  await b.call('POST', '/dsh-rp-control/state', { sessionId: 's1', itemId: 'body-a', on: true })
  check('body A on before the exclusive switch', b.provider('s1').includes('【当前身体：示例 A】'))
  await b.call('POST', '/dsh-rp-control/state', { sessionId: 's1', itemId: 'body-b', on: true })
  const c = mount({ statePath: stateFile })
  const cSel = JSON.parse((await c.call('GET', GET)).body).selection
  check('restart restores exclusive body B', cSel['body-b'] === true && cSel['body-a'] === undefined, JSON.stringify(cSel))
  check('restart provider injects body B',
    c.provider('s1').includes('【当前身体：示例 B】') && !c.provider('s1').includes('【当前身体：示例 A】'))

  // 4) Explicitly turning the body off stays off across restart (no re-default).
  await c.call('POST', '/dsh-rp-control/state', { sessionId: 's1', itemId: 'body-b', on: false })
  const d = mount({ statePath: stateFile })
  const dSel = JSON.parse((await d.call('GET', GET)).body).selection
  check('restart keeps body off, not re-defaulted',
    dSel['body-b'] === undefined && dSel['body-a'] === undefined, JSON.stringify(dSel))
  check('restart provider has no body',
    !d.provider('s1').includes('示例 A') && !d.provider('s1').includes('示例 B'))

  // 5) Bad JSON → empty state + reason recorded in the diag probe.
  writeFileSync(stateFile, '{ this is not json')
  const e = mount({ statePath: stateFile })
  check('bad JSON → nothing on', !e.provider('s1').includes('【当前身体：示例 A】'))
  const eProbe = JSON.parse((await e.call('GET', DIAG)).body).probe
  check('bad JSON reason in probe', typeof eProbe?.stateError === 'string' && eProbe.stateError.length > 0, JSON.stringify(eProbe))

  // 6) Invalid structure (sessions not an object) → empty + reason.
  writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: 'nope' }))
  const f = mount({ statePath: stateFile })
  check('invalid structure → nothing on', !f.provider('s1').includes('【当前身体：示例 A】'))
  const fProbe = JSON.parse((await f.call('GET', DIAG)).body).probe
  check('invalid structure reason in probe', typeof fProbe?.stateError === 'string', JSON.stringify(fProbe))

  // 7) Wrong value type (item flag is a string) → empty + reason.
  writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: { s1: { 'style-plain': 'yes' } } }))
  const g = mount({ statePath: stateFile })
  check('wrong value type → nothing on', !g.provider('s1').includes('【示例条目 · 平实白描】'))
  const gProbe = JSON.parse((await g.call('GET', DIAG)).body).probe
  check('wrong value type reason in probe', typeof gProbe?.stateError === 'string', JSON.stringify(gProbe))

  // 8) Stale item ids are silently ignored (no error, no load).
  writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: { s1: { nope: true, gone: true } } }))
  const h = mount({ statePath: stateFile })
  const hSel = JSON.parse((await h.call('GET', GET)).body).selection
  check('stale ids ignored → nothing on', hSel.nope === undefined && hSel.gone === undefined && Object.keys(hSel).length === 0, JSON.stringify(hSel))

  // 9) Atomic write leaves a well-formed file and no stray .tmp.
  writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: {} }))
  const i = mount({ statePath: stateFile })
  await i.call('POST', '/dsh-rp-control/state', { sessionId: 's2', itemId: 'writing-core', on: true })
  const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
  check('persisted shape has version 1', raw.version === 1 && typeof raw.sessions === 'object', JSON.stringify(raw))
  check('persisted sessions correct', raw.sessions.s2?.['writing-core'] === true, JSON.stringify(raw.sessions))
  check('no stray .tmp file', !existsSync(stateFile + '.tmp'))

  // 10) An untouched session's variable answers the fixed fallback, and a
  //     session that never assembled is not created by asking for it.
  check('the prompt variable is the fixed fallback for an untouched session',
    i.promptVariable('s-never') === '（本轮未启用任何 RP 模块。）', JSON.stringify(i.promptVariable('s-never')))
  check('asking for a session’s state does not invent a persisted entry',
    JSON.parse(readFileSync(stateFile, 'utf8')).sessions['s-never'] === undefined,
    JSON.stringify(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).sessions)))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
