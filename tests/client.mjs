/**
 * Client-half load smoke.
 *
 * `lib/client.js` is a CommonJS factory the web shell hands a `require`, so
 * nothing in it runs until that factory is called — a broken import, a stray
 * top-level read of a browser global, or a registration against the wrong slot
 * would only surface in the running GUI. This test calls the factory with the
 * same externals the shell supplies, then runs `apply()` against a minimal slot
 * registry and asserts both contributions register where they belong.
 *
 * React and the shared primitives are replaced by inert stand-ins: nothing here
 * renders, so only the shapes the module reads at load and call time matter.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check (name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else { failures += 1; console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${String(detail)}`}`) }
}

/** Everything the bundle touches on `react` and `react/jsx-runtime` at load. */
const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useId: () => 'test-id',
  createContext: () => ({ Provider: null, Consumer: null }),
  useContext: () => undefined,
  forwardRef: (render) => render,
  Fragment: 'fragment',
}
const jsxRuntimeStub = {
  jsx: (_type, props) => props,
  jsxs: (_type, props) => props,
  Fragment: 'fragment',
}

/** The primitives the two client modules import; all inert, all callable. */
const primitivesStub = new Proxy({}, {
  get: (_target, name) => {
    if (name === 'observeStickyMenuGroups') return () => () => {}
    return () => null
  },
})

const appended = []
globalThis.document = {
  head: { appendChild: (node) => { appended.push(node) } },
  createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  body: {},
  addEventListener: () => {},
  removeEventListener: () => {},
}

let factory
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => { factory = entry.factory },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1280,
  innerHeight: 800,
}

const bundle = join(import.meta.dirname, '..', 'lib', 'client.js')
const source = readFileSync(bundle, 'utf8')
check('bundle declares the module id', source.includes('id: "dsh-rp-control"'), source.slice(0, 80))

// The bundle assigns `window.__ModuleLoader__.load(...)`; evaluating it in this
// process is exactly what the shell's import does.
await import(`file://${bundle.replace(/\\/g, '/')}`)
check('bundle calls the module loader', typeof factory === 'function')

const requested = []
const moduleStub = (name) => {
  requested.push(name)
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return jsxRuntimeStub
  if (name === 'react-dom') return { createPortal: () => null }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  if (name === '@deepseek-ai/dsh-client-ui-slots') return {}
  throw new Error(`unexpected external request: ${name}`)
}

const client = factory(moduleStub)
check('factory exposes apply', typeof client.apply === 'function', Object.keys(client).join(','))
check('primitives requested as an external',
  requested.includes('@deepseek-ai/dsh-client-ui-primitives'), JSON.stringify(requested))
check('react requested as an external', requested.includes('react'), JSON.stringify(requested))

const registrations = []
const injected = []
const ctx = {
  effect (fn) { fn(); return () => {} },
  slots: {
    register (options, component) { registrations.push({ options, component }); return () => {} },
    inject (key, factoryFn) { injected.push(key); factoryFn() },
  },
}

client.apply(ctx)
check('both seats are injected',
  injected.join(',') === 'conversation.input.right,settings.section', JSON.stringify(injected))
check('one style element is appended', appended.length === 1, String(appended.length))
check('style carries both sheets',
  appended[0].textContent.includes('.dsh-rc-menu') && appended[0].textContent.includes('.dsh-rcp-card'),
  appended[0].textContent.slice(0, 60))

const pill = registrations[0]?.options
const section = registrations[1]?.options
check('pill registers into the composer seat',
  pill?.name === 'conversation.input.right' && pill?.id === 'rp-control' && pill?.order === 21,
  JSON.stringify(pill))
check('pill inject face carries the session id',
  typeof pill?.inject === 'function' && pill.inject('session-x')?.sessionId === 'session-x',
  JSON.stringify(pill?.inject?.('session-x')))
check('settings page registers into the settings seat',
  section?.name === 'settings.section' && section?.id === 'rp-control' && section?.label === 'RP 开关',
  JSON.stringify(section))
check('settings order avoids every installed section',
  typeof section?.order === 'number' && ![0, 15, 20, 30, 31, 40, 100, 500].includes(section.order), String(section?.order))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
