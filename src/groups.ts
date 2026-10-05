/**
 * Built-in group roster — the sample entries this plugin ships with.
 *
 * Every body here is a placeholder ("把这里替换成你自己的……"): edit them in
 * place, or write a `$DSH_HOME/rp-control.json` override, which replaces this
 * whole roster and takes effect on the next turn (see README).
 *
 * The 人格 group shows the other half of the model: its bodies can live as real
 * files under this plugin's `personas/` directory and be referenced with a
 * `./`-prefixed `textFile`, so a persona can be maintained, and swapped per
 * model, without touching TypeScript.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRpConfig, type GroupSpec, type ItemSpec, type RpConfig } from './shared.js'

export const BUILTIN_GROUPS: readonly GroupSpec[] = [
  {
    "id": "style",
    "name": "文风",
    "desc": "写作文风模板，可多选自由组合",
    "items": [
      {
        "id": "style-plain",
        "name": "平实白描",
        "desc": "示例条目：克制的白描文风",
        "text": "【示例条目 · 平实白描】\n把这里替换成你自己的文风指令。示例：\n- 以白描为主，名词与动词推进，克制形容词与比喻\n- 每句对白单独成行，用「」包裹，不写“他说”一类引语\n- 固定在同一角色的主观视角，只写他看到、听到、触到的东西\n- 情绪用动作、物件、光影呈现，不直白点破\n- 长短段落交错，紧张处改用短句分行"
      },
      {
        "id": "style-lyrical",
        "name": "细腻抒情",
        "desc": "示例条目：重情绪渲染与画面感",
        "text": "【示例条目 · 细腻抒情】\n把这里替换成你自己的文风指令。示例：\n- 重视情绪渲染与画面感，允许长句铺陈\n- 场景从五感切入：声音、温度、气味、光线\n- 情绪层层递进：细微反常 → 动作停顿 → 神色变化\n- 浓情绪段落之后接一段日常，避免读者疲劳"
      }
    ]
  },
  {
    "id": "nsfw",
    "name": "情色",
    "desc": "成人向描写的写法要求",
    "items": [
      {
        "id": "nsfw-lexicon",
        "name": "描写示例",
        "desc": "示例条目：成人向场景的写法要求",
        "text": "【示例条目 · 成人向描写】\n把这里替换成你自己的写法要求。示例：\n- 写具体感受与身体反应，不用抽象形容词下判断\n- 节奏随情节推进变化，不堆砌同义词\n- 角色语气与性格保持一贯，不因场景改变人格"
      }
    ]
  },
  {
    "id": "writing",
    "name": "通用写作",
    "desc": "不分文风都成立的基本要求",
    "items": [
      {
        "id": "writing-core",
        "name": "写作核心要求",
        "desc": "示例条目：视角、节奏与角色塑造的基本约束",
        "text": "【示例条目 · 通用写作要求】\n- 只写场景中人物能感知到的东西，不做上帝视角的总结与评价\n- 时间、距离、数量通过人物感知和参照物呈现\n- 情绪由动作和可观察的表现传达\n- 同一场景避免重复此前用过的写法\n- 角色是普通人：设定是倾向，不是每轮都要表演标签"
      }
    ]
  },
  {
    "id": "body",
    "name": "身体",
    "desc": "当前扮演对象的外形与性格设定（互斥，同时只生效一条）",
    "exclusive": true,
    "items": [
      {
        "id": "body-a",
        "name": "示例 A",
        "desc": "示例条目：一个外形 + 性格锚点",
        "text": "【当前身体：示例 A】\n把这里换成当前扮演对象的外形与性格设定。示例：\n性格：……\n外形锚点（出图时照抄这一行）：silver hair, short hair, green eyes, black coat, ..."
      },
      {
        "id": "body-b",
        "name": "示例 B",
        "desc": "示例条目：换一个外形 + 性格锚点",
        "text": "【当前身体：示例 B】\n把这里换成另一个扮演对象。示例：\n性格：……\n外形锚点（出图时照抄这一行）：brown hair, twin tails, amber eyes, white dress, ...\n⚠️ 出图姿势要与当前身体匹配。"
      }
    ]
  },
  {
    "id": "persona",
    "name": "人格",
    "desc": "系统提示词正文，互斥；可配 modelPersona 随模型切换",
    "exclusive": true,
    "items": [
      {
        "id": "persona-example",
        "name": "示例人设",
        "desc": "示例条目：正文放在随包的 personas/example.md 里",
        "textFile": "./personas/example.md"
      },
      {
        "id": "persona-inline",
        "name": "内联示例",
        "desc": "示例条目：不引用外部文件，正文直接写在条目里",
        "text": "【示例人设 · 内联写法】\n你是一个……。\n（这一条演示把正文直接写在条目里的写法；人设较长时建议改用 textFile 指向 personas/ 下的 md 文件，便于单独维护。）"
      }
    ]
  },
  {
    "id": "image",
    "name": "出图",
    "desc": "什么时候出图、prompt 怎么写、外形 tag 从哪来",
    "items": [
      {
        "id": "image-rules",
        "name": "出图规则",
        "desc": "示例条目：出图时机 / prompt 写法 / 审图尺度",
        "text": "【示例条目 · 出图规则】\n把这里替换成你自己的出图规则。示例：\n- 什么时候出图：……\n- prompt 怎么写：……\n- 审图尺度：……"
      },
      {
        "id": "image-anchor",
        "name": "出图锚点",
        "desc": "示例条目：外形 tag 与姿势匹配规则",
        "text": "【示例条目 · 出图锚点（照抄）】\n角色 A：blue hair, long hair, blue eyes, white dress, ...\n角色 B：照抄「身体」那一组注入的外形锚点。\n⚠️ 出图姿势要跟当前身体匹配。"
      }
    ]
  }
]

/** Absolute path of the user-editable override file under the harness home. */
export function rpConfigPath (): string {
  const home = process.env['DSH_HOME']?.trim()
  const root = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(root, 'rp-control.json')
}

/** One config read: the groups plus where it came from and how it went. */
export interface LoadedRpConfig {
  readonly config: RpConfig
  readonly source: 'file' | 'builtin'
  readonly path: string
  readonly error?: string
}

/**
 * One config read before `textFile` resolution: the roster exactly as it is
 * stored, so a settings page edits what a save would write back rather than the
 * text a `textFile` happened to hold.
 */
export interface RawRpConfig {
  readonly config: RpConfig
  readonly source: 'file' | 'builtin'
  readonly path: string
  readonly error?: string
}

function messageOf (cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function homeRoot (): string {
  const home = process.env['DSH_HOME']?.trim()
  return home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
}

/**
 * Absolute path of this plugin's own package root.
 *
 * The built host bundle is always `lib/index.js`, one directory below the
 * package root, and its own module URL is the one anchor that needs no
 * `package.json` walk, no `cwd`, and no environment variable — so a `./`
 * `textFile` keeps working no matter who imported the bundle.
 */
function pluginRoot (): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Expand a `textFile` path.
 *
 * A `./`-prefixed path is relative to this plugin's package root, so the
 * built-in roster can ship its persona bodies as ordinary files next to the
 * code. Every other form keeps its older meaning: `$DSH_HOME` is expanded, an
 * absolute path is used as it stands, and a bare relative path resolves
 * against `$DSH_HOME`.
 */
function resolveTextFilePath (textFile: string): string {
  if (textFile.startsWith('./')) return resolve(pluginRoot(), textFile.slice(2))
  const root = homeRoot()
  const expanded = textFile.replace(/\$DSH_HOME/g, root)
  return isAbsolute(expanded) ? expanded : resolve(root, expanded)
}

/**
 * Normalize a textFile's contents: drop lines whose first non-space char is
 * `>` (those are human-only quote blocks, not for injection) and collapse runs
 * of 3+ blank lines to one.
 */
function filterItemText (content: string): string {
  return content
    .split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Read a textFile's contents; unreadable or empty counts as unavailable. */
function readItemText (textFile: string): { ok: true, text: string } | { ok: false, reason: string } {
  const filePath = resolveTextFilePath(textFile)
  try {
    const content = readFileSync(filePath, 'utf8')
    if (content.trim().length === 0) return { ok: false, reason: `file is empty: ${filePath}` }
    return { ok: true, text: filterItemText(content) }
  } catch (cause) {
    return { ok: false, reason: `${messageOf(cause)} (${filePath})` }
  }
}

/**
 * The persona bindings a config carries, as their own object slice.
 *
 * They are independent of the roster, so every path that rebuilds `groups`
 * (dropping items, or falling back wholesale) carries them through unchanged
 * rather than losing a deployment's model bindings to an unreadable file.
 */
function personaBindings (config: RpConfig): Pick<RpConfig, 'modelPersona' | 'defaultPersona'> {
  return {
    ...(config.modelPersona === undefined ? {} : { modelPersona: config.modelPersona }),
    ...(config.defaultPersona === undefined ? {} : { defaultPersona: config.defaultPersona }),
  }
}

/**
 * Turn every item into a resolved one: inline `text` (non-empty) wins; else
 * `textFile` is read. An item that ends up with no usable text is dropped and
 * its reason recorded, never thrown.
 */
function resolveGroupTexts (config: RpConfig): { config: RpConfig, errors: string[] } {
  const groups: GroupSpec[] = []
  const errors: string[] = []
  for (const group of config.groups) {
    const items: ItemSpec[] = []
    for (const item of group.items) {
      if (typeof item.text === 'string' && item.text.length > 0) {
        items.push({ id: item.id, name: item.name, ...(typeof item.desc === 'string' ? { desc: item.desc } : {}), text: item.text })
        continue
      }
      if (typeof item.textFile === 'string' && item.textFile.length > 0) {
        const read = readItemText(item.textFile)
        if (read.ok) {
          items.push({ id: item.id, name: item.name, ...(typeof item.desc === 'string' ? { desc: item.desc } : {}), text: read.text })
        } else {
          errors.push(`${group.id}/${item.id}: ${read.reason}`)
        }
        continue
      }
      errors.push(`${group.id}/${item.id}: no text or textFile`)
    }
    if (items.length > 0) {
      groups.push({
        id: group.id,
        name: group.name,
        ...(typeof group.desc === 'string' ? { desc: group.desc } : {}),
        ...(group.exclusive === true ? { exclusive: true } : {}),
        ...(group.defaultItems === undefined ? {} : { defaultItems: group.defaultItems }),
        items,
      })
    }
  }
  return { config: { groups, ...personaBindings(config) }, errors }
}

/**
 * Resolve `textFile` → `text` for every item, falling back to the built-in
 * groups (also resolved) when nothing survives. The built-in fallback is
 * resolved too, so a config file that names a file nothing can read still
 * leaves the master with a roster that injects something.
 */
function resolveTexts (config: RpConfig, source: 'file' | 'builtin', path: string, error?: string): LoadedRpConfig {
  const resolved = resolveGroupTexts(config)
  if (resolved.config.groups.length === 0) {
    const fallback = resolveGroupTexts({ groups: BUILTIN_GROUPS, ...personaBindings(config) })
    const errors = [error, ...resolved.errors].filter((e): e is string => typeof e === 'string' && e.length > 0)
    return { config: fallback.config, source: 'builtin', path, ...(errors.length > 0 ? { error: errors.join('; ') } : {}) }
  }
  const errors = [...(typeof error === 'string' ? [error] : []), ...resolved.errors]
  return { config: resolved.config, source, path, ...(errors.length > 0 ? { error: errors.join('; ') } : {}) }
}

/**
 * Read the stored groups from disk without resolving any `textFile`.
 *
 * A missing file is the normal case (the built-in groups apply) and reports no
 * error; every other failure returns the built-in groups plus a message, so a
 * broken config is surfaced instead of silently ignored.
 */
export function loadRpRawConfig (path: string = rpConfigPath()): RawRpConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (cause) {
    const builtin: RpConfig = { groups: BUILTIN_GROUPS }
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: builtin, source: 'builtin', path }
    }
    return { config: builtin, source: 'builtin', path, error: messageOf(cause) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return { config: { groups: BUILTIN_GROUPS }, source: 'builtin', path, error: messageOf(cause) }
  }
  const structural = resolveRpConfig(parsed, BUILTIN_GROUPS)
  if (structural.error !== undefined) {
    return { config: structural.config, source: 'builtin', path, error: structural.error }
  }
  return { config: structural.config, source: 'file', path }
}

/**
 * Read the groups from disk, with `textFile` resolved to `text`.
 *
 * Resolution also drops items whose file is missing or empty, so this is the
 * roster prompt assembly injects rather than the roster on disk; the settings
 * page reads {@link loadRpRawConfig} instead.
 */
export function loadRpConfig (path: string = rpConfigPath()): LoadedRpConfig {
  const raw = loadRpRawConfig(path)
  return resolveTexts(raw.config, raw.source, raw.path, raw.error)
}
