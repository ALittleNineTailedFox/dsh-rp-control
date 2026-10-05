#!/usr/bin/env node
/**
 * 只读会话存档检查器 —— 验收「RP 扮演」preset 是否真的换源。
 *
 * 它只读 $DSH_HOME/sessions 下的会话存档（session.v4.jsonl.zstd），不改任何东西。
 *
 * 判据（换源成功的样子）：
 *   1. `system/message` 里就是 RP 正文（命中 RP_MARKERS 的特征串），且**没有** harness 身份、
 *      工具指导散文、AGENTS.md 一类工程纪律 —— 这证明 `complete: true` 生效了。
 *   2. 不再出现 `Current runtime context.` 的 user 快照 —— 这证明
 *      `includeRuntimeContext: false` 把 rp-control 自己那份注入也收掉了。
 *
 * 用法：
 *   node tools/dump-session.mjs                 # 最近修改的那个会话
 *   node tools/dump-session.mjs <sessionId前缀>  # 指定会话（目录名前缀即可）
 *   node tools/dump-session.mjs --all           # 所有会话，只打摘要
 *
 * 退出码：0 = 判据满足；1 = 判据不满足（仍是叠加层）；2 = 输入/环境问题。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const FILE = 'session.v4.jsonl.zstd'
/** zstd 帧的魔术字节。存档是多帧拼接的，必须逐帧解，单次解压只出第一帧。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Harness 身份 / 第一方指导 / 工程纪律的探针串 —— 换源成功后它们都该消失。 */
const HARNESS_MARKERS = [
  'You are an AI agent powered by DeepSeek Harness',
  'You are a coding agent powered by the',
  'Use the read tool',
  'Non-zero exits are reported',
  'Tokens prefixed with @',
  'MNEMON RUNTIME MEMORY PROTOCOL',
]
/**
 * RP 侧探针 —— 换源成功时它该出现在系统提示词里。
 *
 * 默认值只是随包示例人设的特征串。换成你自己那份正文的特征串，用
 * `RP_MARKERS` 环境变量覆盖（逗号分隔），例如：
 *   $env:RP_MARKERS='角色名,口头禅'; node tools/dump-session.mjs
 */
const RP_MARKERS = (process.env.RP_MARKERS ?? '示例人设,示例条目')
  .split(',')
  .map((marker) => marker.trim())
  .filter((marker) => marker.length > 0)
/** runtime-context 快照的开头（rp-control 的注入就走这条通道）。 */
const CONTEXT_HEAD = 'Current runtime context.'

const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const sessionsRoot = join(home, 'sessions')

if (typeof zstdDecompressSync !== 'function') {
  console.error(`此 Node 不带 zstd 支持（需要 Node ≥ 22.15）：${process.version}`)
  process.exit(2)
}

/** 递归收集会话存档路径。 */
function collect (dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (entry.name === FILE) out.push(full)
  }
  return out
}

/** 逐帧解压一份多帧 zstd 存档，返回 jsonl 全文。 */
function decode (path) {
  const buf = readFileSync(path)
  const offsets = []
  for (let i = 0; i <= buf.length - MAGIC.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
  }
  if (offsets.length === 0) throw new Error('不是 zstd 存档（找不到帧头）')
  let text = ''
  for (let k = 0; k < offsets.length; k++) {
    const end = offsets[k + 1] ?? buf.length
    try {
      text += zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')
    } catch {
      // 坏帧跳过：我们要的是可读性，不是完整性。
    }
  }
  return text
}

/** 从一条事件里取出消息正文；不同版本包了一层，这里两种都认。 */
function bodyOf (event) {
  const data = event?.data ?? {}
  const wrapped = data.message ?? data
  const content = wrapped?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
  }
  return ''
}

/** 检查一个会话，返回判据结果。 */
function inspect (path, verbose) {
  const events = []
  for (const line of decode(path).split('\n')) {
    if (line.trim().length === 0) continue
    try { events.push(JSON.parse(line)) } catch { /* 半行/坏行忽略 */ }
  }
  const systems = events.filter((e) => e?.type === 'system/message').map(bodyOf)
  const contexts = events
    .filter((e) => e?.type === 'user/message')
    .map(bodyOf)
    .filter((text) => text.startsWith(CONTEXT_HEAD))

  const system = systems.join('\n')
  const hitHarness = HARNESS_MARKERS.filter((m) => system.includes(m))
  const hitRp = RP_MARKERS.filter((m) => system.includes(m))
  const ok = hitRp.length > 0 && hitHarness.length === 0 && contexts.length === 0

  const name = path.slice(sessionsRoot.length + 1)
  console.log(`\n=== ${name} ===`)
  console.log(`事件 ${events.length} 条 · system/message ${systems.length} 条 · user 快照 ${contexts.length} 条`)
  console.log(`系统提示词长度 ${system.length}`)
  console.log(`  RP 标记命中      : ${hitRp.length > 0 ? hitRp.join(' / ') : '（无）'}`)
  console.log(`  harness 标记命中 : ${hitHarness.length > 0 ? hitHarness.join(' / ') : '（无）'}`)
  console.log(`  user 快照        : ${contexts.length === 0 ? '无' : `${contexts.length} 条（未换源）`}`)
  console.log(`  ⇒ ${ok ? '✅ 换源成立：系统提示词 = RP 正文，且无 user 快照' : '❌ 未换源（仍是叠加层）'}`)

  if (verbose) {
    console.log('\n---- system/message 前 600 字 ----')
    console.log(system.slice(0, 600))
    for (const [i, text] of contexts.entries()) {
      console.log(`\n---- user 快照 #${i + 1} 前 300 字 ----`)
      console.log(text.slice(0, 300))
    }
  }
  return ok
}

const args = process.argv.slice(2)
if (!statSync(sessionsRoot, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`找不到会话目录：${sessionsRoot}`)
  process.exit(2)
}
const all = collect(sessionsRoot)
if (all.length === 0) {
  console.error(`没有找到任何 ${FILE}`)
  process.exit(2)
}
const byNewest = all
  .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)

const flagAll = args.includes('--all')
const needle = args.find((a) => !a.startsWith('--'))

let targets
if (flagAll) targets = byNewest
else if (needle !== undefined) {
  targets = byNewest.filter((c) => c.path.includes(needle))
  if (targets.length === 0) {
    console.error(`没有匹配「${needle}」的会话`)
    process.exit(2)
  }
} else targets = byNewest.slice(0, 1)

let anyOk = false
for (const { path } of targets) {
  if (inspect(path, !flagAll)) anyOk = true
}
process.exit(anyOk ? 0 : 1)
