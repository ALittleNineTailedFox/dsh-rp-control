/**
 * Settings page: the 「RP 开关」 section.
 *
 * Registered into the official `settings.section` seat, so DSH owns the nav
 * row, the dialog, and the panel column, and this module owns only the page
 * body. It edits the same override file the host reads for injection, and it
 * edits the roster *as stored* — a `textFile` item keeps its path rather than
 * silently becoming the file's current text on the first save.
 *
 * Two rules shape the page:
 *
 * - The host's `validateRpConfig` is the only judge of what may be written, so
 *   the page never pre-empts it; a refusal arrives with the offending path and
 *   is shown verbatim.
 * - The settings shell unmounts a section whenever the panel closes, so an
 *   edited roster that has not been saved is parked in `parkedDraft` instead of
 *   being dropped with the component.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
  Button,
  Checkbox,
  Input,
  Modal,
  Switch,
  Tag,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { RP_CONFIG_ROUTE, type GroupSpec, type ItemSpec, type RpConfigPayload } from '../shared.js'

/**
 * The document this page edits: the roster plus its persona bindings.
 *
 * Both halves live in one file and the host writes them as one document, so
 * the page holds them together — a save that carried only the roster would
 * silently drop `modelPersona`.
 */
interface RpDocument {
  readonly groups: readonly GroupSpec[]
  readonly modelPersona?: Record<string, string>
  readonly defaultPersona?: string
}

/** One editable document plus the state it was loaded from. */
interface Draft extends RpDocument {
  /** Serialized document the draft started from; the dirty check compares to it. */
  readonly baseline: string
  readonly source: 'builtin' | 'file'
  readonly path: string
}

/**
 * An unsaved draft parked between mounts.
 *
 * The settings shell renders a section only while its panel is open, so closing
 * the panel would otherwise discard half an hour of edits without a word. One
 * page edits one roster, so a single slot is enough.
 */
let parkedDraft: Draft | undefined

function messageOf (cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** One document, canonically serialized so two drafts compare by value. */
function serializeDocument (doc: RpDocument): string {
  return JSON.stringify({
    groups: doc.groups,
    ...(doc.modelPersona === undefined ? {} : { modelPersona: doc.modelPersona }),
    ...(doc.defaultPersona === undefined ? {} : { defaultPersona: doc.defaultPersona }),
  })
}

/** A document carrying only the fields this vocabulary owns. */
function documentOf (doc: RpDocument): RpDocument {
  return JSON.parse(serializeDocument(doc)) as RpDocument
}

/** The config payload, or the host's reason for refusing the request. */
async function readPayload (response: Response): Promise<RpConfigPayload> {
  if (response.ok) return await response.json() as RpConfigPayload
  let reason = `HTTP ${response.status}`
  try {
    const body = await response.json() as { error?: unknown, reason?: unknown }
    const parts = [body.error, body.reason].filter((part): part is string => typeof part === 'string' && part.length > 0)
    if (parts.length > 0) reason = parts.join('：')
  } catch { /* a non-JSON error body leaves the status as the reason */ }
  throw new Error(reason)
}

/** Read the roster the host would inject. */
async function fetchConfig (): Promise<RpConfigPayload> {
  return await readPayload(await fetch(RP_CONFIG_ROUTE, { credentials: 'same-origin' }))
}

/** Write a whole document — roster and persona bindings — to the override file. */
async function putConfig (doc: RpDocument): Promise<RpConfigPayload> {
  return await readPayload(await fetch(RP_CONFIG_ROUTE, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: documentOf(doc) }),
  }))
}

/** Delete the override file so the built-in roster applies again. */
async function deleteConfig (): Promise<RpConfigPayload> {
  return await readPayload(await fetch(RP_CONFIG_ROUTE, { method: 'DELETE', credentials: 'same-origin' }))
}

/** A group id no roster uses yet. */
function freshGroupId (groups: readonly GroupSpec[]): string {
  const taken = new Set(groups.map(group => group.id))
  for (let n = 1; ; n++) {
    const id = `group-${n}`
    if (!taken.has(id)) return id
  }
}

/** An item id no roster uses yet; item ids are global, not per group. */
function freshItemId (groups: readonly GroupSpec[]): string {
  const taken = new Set(groups.flatMap(group => group.items.map(item => item.id)))
  for (let n = 1; ; n++) {
    const id = `item-${n}`
    if (!taken.has(id)) return id
  }
}

/** Placeholder body for a just-added item, so the roster is always writable. */
const NEW_ITEM_TEXT = '（在此填写这一条要注入的正文）'

/**
 * One `provider/model = persona-id` line.
 *
 * Only `=` separates the two sides: a model route never contains one, and a
 * persona item id may contain anything else. A line that does not match is
 * kept in the textarea (so a half-typed key is not eaten) but writes nothing.
 */
const PERSONA_LINE = /^([^=]+?)\s*=\s*(\S+)$/

/** The persona group's item ids, in listing order. */
function personaIdsOf (groups: readonly GroupSpec[]): string[] {
  return groups.find(group => group.id === 'persona')?.items.map(item => item.id) ?? []
}

/** Render a binding map as editable lines. */
function personaMapToText (map: Record<string, string> | undefined): string {
  if (map === undefined) return ''
  return Object.entries(map).map(([key, value]) => `${key} = ${value}`).join('\n')
}

/**
 * Parse the editable lines back into a binding map.
 *
 * Blank lines and `#` comments are skipped, so the box can carry its own
 * explanation; anything unparseable is skipped rather than refused, because
 * the host is the only judge of what may be written.
 */
function textToPersonaMap (text: string): Record<string, string> | undefined {
  const map: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const match = PERSONA_LINE.exec(line)
    if (match === null) continue
    const key = (match[1] ?? '').trim()
    if (key.length === 0) continue
    map[key] = match[2] ?? ''
  }
  return Object.keys(map).length === 0 ? undefined : map
}

/** Replace the document's persona bindings, dropping fields left empty. */
function withPersona (
  draft: Draft,
  modelPersona: Record<string, string> | undefined,
  defaultPersona: string | undefined,
): Draft {
  const { modelPersona: _map, defaultPersona: _default, ...rest } = draft
  return {
    ...rest,
    ...(modelPersona === undefined ? {} : { modelPersona }),
    ...(defaultPersona === undefined ? {} : { defaultPersona }),
  }
}

/** The chain label for one link of the model → persona → fallback chain. */
function personaSourceLabel (source: RpConfigPayload['personaDiag']): string {
  if (source === undefined) return '尚未观测到（本进程还没有组装过提示词）'
  if (source.source === 'model') return '命中 modelPersona 绑定'
  if (source.source === 'default') return '回落 defaultPersona'
  return '没有绑定，按会话里的手选开关'
}

/** The editable draft a host payload describes. */
function draftOf (payload: RpConfigPayload): Draft {
  const doc = documentOf({
    groups: payload.groups,
    ...(payload.modelPersona === undefined ? {} : { modelPersona: { ...payload.modelPersona } }),
    ...(payload.defaultPersona === undefined ? {} : { defaultPersona: payload.defaultPersona }),
  })
  return { ...doc, baseline: serializeDocument(doc), source: payload.source, path: payload.path }
}

/** Replace one group, returning a new roster. */
function withGroup (groups: readonly GroupSpec[], index: number, next: GroupSpec): GroupSpec[] {
  return groups.map((group, at) => at === index ? next : group)
}

/** Replace one item inside one group, returning a new roster. */
function withItem (
  groups: readonly GroupSpec[],
  groupIndex: number,
  itemIndex: number,
  next: ItemSpec,
): GroupSpec[] {
  const group = groups[groupIndex]
  if (group === undefined) return [...groups]
  return withGroup(groups, groupIndex, {
    ...group,
    items: group.items.map((item, at) => at === itemIndex ? next : item),
  })
}

/** One labelled field row. */
function Field (props: { readonly label: string, readonly hint?: string, readonly children: ReactNode }) {
  return (
    <label className="dsh-rcp-field">
      <span className="dsh-rcp-field-label">{props.label}</span>
      {props.children}
      {props.hint === undefined ? null : <span className="dsh-rcp-field-hint">{props.hint}</span>}
    </label>
  )
}

/** The RP 开关 settings page. */
export function RpSettings () {
  const [draft, setDraft] = useState<Draft | null>(parkedDraft ?? null)
  const [payload, setPayload] = useState<RpConfigPayload | null>(null)
  /**
   * The model-binding box is the one field whose raw text is not derivable
   * from the parsed document: a half-typed line parses to nothing, and
   * rebuilding the box from the map on every keystroke would delete it.
   */
  const [personaText, setPersonaText] = useState(() => personaMapToText(parkedDraft?.modelPersona))
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [toast, setToast] = useState<{ readonly id: number, readonly text: string } | null>(null)
  /**
   * Which group cards are open, by group id. Every card starts collapsed —
   * the roster is long enough that an opened-forever list is a scroll hunt —
   * and saving or restoring never touches the set, so the page keeps the shape
   * the master left it in.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toastSeq = useRef(0)
  /** A parked draft may predate the host's answer; it wins until saved or discarded. */
  const parkedAtMount = useRef(parkedDraft !== undefined)

  useEffect(() => {
    let active = true
    setLoadError('')
    void fetchConfig().then(next => {
      if (!active) return
      setPayload(next)
      if (parkedAtMount.current) return
      const fresh = draftOf(next)
      setDraft(fresh)
      setPersonaText(personaMapToText(fresh.modelPersona))
    }).catch((cause: unknown) => {
      if (active) setLoadError(messageOf(cause))
    })
    return () => { active = false }
  }, [])

  const dirty = draft !== null && serializeDocument(draft) !== draft.baseline

  // Park every unsaved change, so closing the settings panel is not a delete.
  useEffect(() => {
    parkedDraft = dirty ? draft ?? undefined : undefined
  }, [draft, dirty])

  // A reload or a window close is the one exit the page cannot ask about.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => { window.removeEventListener('beforeunload', onBeforeUnload) }
  }, [dirty])

  const showToast = (text: string): void => {
    toastSeq.current += 1
    setToast({ id: toastSeq.current, text })
  }

  /** Adopt a payload the host just answered with, clearing the draft. */
  const adopt = (next: RpConfigPayload, text: string): void => {
    parkedDraft = undefined
    const fresh = draftOf(next)
    setPayload(next)
    setDraft(fresh)
    setPersonaText(personaMapToText(fresh.modelPersona))
    setSaveError('')
    showToast(text)
  }

  const save = (): void => {
    if (draft === null || busy) return
    setBusy(true)
    setSaveError('')
    void putConfig(draft)
      .then(next => { adopt(next, '已保存到配置文件') })
      .catch((cause: unknown) => { setSaveError(messageOf(cause)) })
      .finally(() => { setBusy(false) })
  }

  const reset = (): void => {
    setConfirmReset(false)
    if (busy) return
    setBusy(true)
    setSaveError('')
    void deleteConfig()
      .then(next => { adopt(next, '已恢复内置分组') })
      .catch((cause: unknown) => { setSaveError(messageOf(cause)) })
      .finally(() => { setBusy(false) })
  }

  const discard = (): void => {
    if (draft === null) return
    const base = JSON.parse(draft.baseline) as RpDocument
    setDraft({ ...documentOf(base), baseline: draft.baseline, source: draft.source, path: draft.path })
    setPersonaText(personaMapToText(base.modelPersona))
    parkedDraft = undefined
    setSaveError('')
  }

  const setDefaultPersona = (value: string): void => {
    if (draft === null) return
    setDraft(withPersona(draft, draft.modelPersona, value.length === 0 ? undefined : value))
  }

  const setModelPersonaText = (value: string): void => {
    setPersonaText(value)
    if (draft === null) return
    setDraft(withPersona(draft, textToPersonaMap(value), draft.defaultPersona))
  }

  const groups = draft?.groups ?? []
  const source = draft?.source ?? payload?.source ?? 'builtin'
  const path = draft?.path ?? payload?.path ?? ''
  const personaDiag = payload?.personaDiag
  const baselineGroups = useMemo(
    () => (draft === null ? [] : (JSON.parse(draft.baseline) as RpDocument).groups),
    [draft],
  )
  const personaIds = useMemo(() => personaIdsOf(groups), [groups])
  const itemCount = useMemo(
    () => groups.reduce((total, group) => total + group.items.length, 0),
    [groups],
  )

  const toggleExpanded = (groupId: string): void => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  const setGroups = (next: readonly GroupSpec[]): void => {
    if (draft === null) return
    setDraft({ ...draft, groups: next })
  }

  const addGroup = (): void => {
    const id = freshGroupId(groups)
    setGroups([...groups, {
      id,
      name: '新分组',
      items: [{ id: freshItemId(groups), name: '新条目', text: NEW_ITEM_TEXT }],
    }])
    // Open the group the master just asked for, so it can be named right away.
    // Saving and resetting never touch this set, so those paths cannot pop the
    // whole list open.
    setExpanded(previous => new Set([...previous, id]))
  }

  const addItem = (groupIndex: number): void => {
    const group = groups[groupIndex]
    if (group === undefined) return
    setGroups(withGroup(groups, groupIndex, {
      ...group,
      items: [...group.items, { id: freshItemId(groups), name: '新条目', text: NEW_ITEM_TEXT }],
    }))
  }

  const removeGroup = (groupIndex: number): void => {
    const group = groups[groupIndex]
    if (group === undefined) return
    setGroups(groups.filter((_group, at) => at !== groupIndex))
    setExpanded(previous => {
      if (!previous.has(group.id)) return previous
      const next = new Set(previous)
      next.delete(group.id)
      return next
    })
  }

  const removeItem = (groupIndex: number, itemIndex: number): void => {
    const group = groups[groupIndex]
    if (group === undefined) return
    // A default that no longer exists would be refused by the host.
    const items = group.items.filter((_item, at) => at !== itemIndex)
    setGroups(withGroup(groups, groupIndex, pruneDefaults(group, items)))
  }

  return (
    <div className="dsh-rcp-root">
      <header className="dsh-rcp-head">
        <div className="dsh-rcp-head-text">
          <div className="dsh-rcp-title-row">
            <h3 className="dsh-rcp-title">RP 开关</h3>
            <Tag tone={source === 'file' ? 'info' : 'outline'}>
              {source === 'file' ? '当前：配置文件' : '当前：内置分组'}
            </Tag>
          </div>
          <p className="dsh-rcp-sub">
            勾选后，每个条目在会话里的开关状态按会话保存，随下一轮对话立即生效。
            {itemCount === 0 ? '' : ` 共 ${groups.length} 组 / ${itemCount} 条。`}
          </p>
          <p className="dsh-rcp-path" title={path}>{path}</p>
        </div>
        <div className="dsh-rcp-actions">
          <Button
            variant="outline"
            size="sm"
            icon={<IconPlusOutlineRegular size={14} />}
            disabled={draft === null || busy}
            title="新增一个分组"
            onClick={addGroup}
          >
            新增分组
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || busy}
            onClick={save}
          >
            {busy ? '处理中…' : '保存'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={busy}
            onClick={() => { setConfirmReset(true) }}
          >
            恢复内置
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || busy}
            onClick={discard}
          >
            放弃改动
          </Button>
        </div>
      </header>

      {loadError.length > 0 ? (
        <p className="dsh-rcp-note dsh-rcp-note-error" role="alert">读取配置失败：{loadError}</p>
      ) : null}
      {payload?.error !== undefined ? (
        <p className="dsh-rcp-note dsh-rcp-note-warn" role="status">
          <IconWarningOutlineRegular size={14} className="dsh-rcp-note-icon" />
          配置文件未被采用，当前使用内置分组：{payload.error}
        </p>
      ) : null}
      {payload?.textError !== undefined ? (
        <p className="dsh-rcp-note dsh-rcp-note-warn" role="status">
          <IconWarningOutlineRegular size={14} className="dsh-rcp-note-icon" />
          有条目未能取到正文，注入时被跳过：{payload.textError}
        </p>
      ) : null}
      {dirty ? (
        <p className="dsh-rcp-note dsh-rcp-note-dirty" role="status">
          有未保存的改动。离开这一页不会丢失，但只有「保存」才会写进配置文件。
        </p>
      ) : null}
      {saveError.length > 0 ? (
        <p className="dsh-rcp-note dsh-rcp-note-error" role="alert">保存失败：{saveError}</p>
      ) : null}

      <section className="dsh-rcp-card">
        <div className="dsh-rcp-card-head">
          <span className="dsh-rcp-card-name">人格 · 随模型切换</span>
          <span className="dsh-rcp-card-meta">
            可用人设：{personaIds.length === 0 ? '（没有 persona 组）' : personaIds.join(' / ')}
          </span>
        </div>
        <div className="dsh-rcp-card-fields">
          <Field
            label="默认人设 defaultPersona"
            hint="没有命中任何模型绑定时强制打开的人设。留空＝不覆盖，完全按会话里的手选开关。"
          >
            <Input
              className="dsh-rcp-file"
              value={draft?.defaultPersona ?? ''}
              aria-label="默认人设 defaultPersona"
              placeholder="例如 persona-example"
              disabled={draft === null}
              onChange={(event) => { setDefaultPersona(event.target.value) }}
            />
          </Field>
        </div>
        <Field
          label="模型绑定 modelPersona"
          hint={'每行一条：<provider>/<model> = <人设 id>。# 开头是注释，空行忽略。命中时强制打开该人设并关掉同组其它项。'}
        >
          <textarea
            className="dsh-rcp-text"
            rows={4}
            spellCheck={false}
            value={personaText}
            aria-label="模型人设绑定 modelPersona"
            placeholder={'# 例：\ndeepseek-official/deepseek-flash = persona-example'}
            disabled={draft === null}
            onChange={(event) => { setModelPersonaText(event.target.value) }}
          />
        </Field>
        <p className="dsh-rcp-hint">
          当前模型 → 命中人设 → 回落：
          {' '}<code className="dsh-rcp-meta">{personaDiag?.modelKey ?? '（未观测到）'}</code>
          {' → '}<code className="dsh-rcp-meta">{personaDiag?.personaId ?? '（无人设）'}</code>
          {' → '}{personaSourceLabel(personaDiag)}
          （取自本进程最近一次提示词组装）
        </p>
      </section>

      {draft === null
        ? (loadError.length > 0 ? null : <p className="dsh-rcp-sub">正在读取配置…</p>)
        : groups.map((group, groupIndex) => {
          const open = expanded.has(group.id)
          const defaults = defaultsOf(group)
          const groupDirty = groupIsDirty(group, baselineGroups)
          return (
            <section className="dsh-rcp-card" key={`${group.id}-${String(groupIndex)}`}>
              <div className="dsh-rcp-card-head">
                <button
                  type="button"
                  className="dsh-rcp-toggle"
                  aria-expanded={open}
                  onClick={() => { toggleExpanded(group.id) }}
                >
                  <IconChevronDownOutlineRegular
                    size={14}
                    className={`dsh-rcp-caret${open ? ' dsh-rcp-caret-open' : ''}`}
                  />
                  <span className="dsh-rcp-card-name">{group.name}</span>
                  <span className="dsh-rcp-card-meta">{group.items.length} 条</span>
                  <span className="dsh-rcp-card-meta">
                    {defaults.length === 0 ? '不设默认' : `已设 ${defaults.length} 项默认`}
                  </span>
                  {group.exclusive === true ? <Tag tone="quiet">互斥</Tag> : null}
                  {groupDirty ? <span className="dsh-rcp-changed">未保存</span> : null}
                </button>
                <span className="dsh-rcp-meta">分组 id：{group.id}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<IconTrashOutlineRegular size={14} />}
                  aria-label={`删除分组 ${group.name}`}
                  disabled={groups.length <= 1}
                  title={groups.length <= 1 ? '至少保留一个分组' : '删除这一组'}
                  onClick={() => { removeGroup(groupIndex) }}
                />
              </div>

              {!open ? null : (
                <>
                  <div className="dsh-rcp-card-fields">
                    <Input
                      className="dsh-rcp-name"
                      value={group.name}
                      aria-label="分组名称"
                      placeholder="分组名称"
                      onChange={(event) => {
                        setGroups(withGroup(groups, groupIndex, { ...group, name: event.target.value }))
                      }}
                    />
                    <span className="dsh-rcp-switch">
                      <span className="dsh-rcp-switch-text">互斥模式</span>
                      <Switch
                        checked={group.exclusive === true}
                        label={`互斥模式：${group.name}`}
                        title="打开后这一组只能同时选中一条"
                        onChange={(next) => {
                          setGroups(withGroup(groups, groupIndex, withExclusive(group, next)))
                        }}
                      />
                    </span>
                    <span className="dsh-rcp-hint">
                      每条条目下方的「默认开」＝这一组还没被碰过时自动打开的条目
                    </span>
                  </div>

                  <div className="dsh-rcp-items">
                    {group.items.map((item, itemIndex) => (
                      <div className="dsh-rcp-item" key={`${item.id}-${String(itemIndex)}`}>
                        <div className="dsh-rcp-item-head">
                          <Input
                            className="dsh-rcp-name"
                            value={item.name}
                            aria-label="条目名称"
                            placeholder="条目名称"
                            onChange={(event) => {
                              setGroups(withItem(groups, groupIndex, itemIndex, { ...item, name: event.target.value }))
                            }}
                          />
                          <Input
                            className="dsh-rcp-desc"
                            value={item.desc ?? ''}
                            aria-label="条目描述"
                            placeholder="条目描述（可选）"
                            onChange={(event) => {
                              const value = event.target.value
                              setGroups(withItem(groups, groupIndex, itemIndex, withDesc(item, value)))
                            }}
                          />
                          <Checkbox
                            className="dsh-rcp-default-box"
                            checked={defaults.includes(item.id)}
                            label="默认开"
                            title={`这一组没被碰过时默认打开「${item.name}」`}
                            onChange={(next) => {
                              setGroups(withGroup(groups, groupIndex, setDefault(group, item.id, next)))
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<IconTrashOutlineRegular size={14} />}
                            aria-label={`删除条目 ${item.name}`}
                            title="删除这一条"
                            onClick={() => { removeItem(groupIndex, itemIndex) }}
                          />
                        </div>
                        <Field label="条目正文" hint="选中这一条时，原样注入到对话里。">
                          <textarea
                            className="dsh-rcp-text"
                            rows={6}
                            spellCheck={false}
                            value={item.text ?? ''}
                            aria-label={`${item.name} 的正文`}
                            placeholder="在这里写这一条要注入的正文"
                            onChange={(event) => {
                              const value = event.target.value
                              setGroups(withItem(groups, groupIndex, itemIndex, value.length === 0
                                ? omitText(item)
                                : { ...item, text: value }))
                            }}
                          />
                        </Field>
                        <Field label="或从文件读取" hint="正文非空时忽略此项；支持 $DSH_HOME。">
                          <Input
                            className="dsh-rcp-file"
                            value={item.textFile ?? ''}
                            aria-label={`${item.name} 的正文文件`}
                            placeholder="例如 $DSH_HOME/notes/rule.md"
                            onChange={(event) => {
                              const value = event.target.value
                              setGroups(withItem(groups, groupIndex, itemIndex, value.length === 0
                                ? omitTextFile(item)
                                : { ...item, textFile: value }))
                            }}
                          />
                        </Field>
                      </div>
                    ))}
                  </div>

                  <div className="dsh-rcp-card-foot">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconPlusOutlineRegular size={14} />}
                      onClick={() => { addItem(groupIndex) }}
                    >
                      新增条目
                    </Button>
                  </div>
                </>
              )}
            </section>
          )
        })}

      <Modal
        open={confirmReset}
        title="恢复内置分组"
        closeLabel="关闭"
        description={`这会删除 ${path}，之后生效的是插件内置的 6 组开关。当前未保存的改动也会一起丢弃。`}
        onClose={() => { setConfirmReset(false) }}
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => { setConfirmReset(false) }}>取消</Button>
            <Button variant="primary" size="sm" icon={<IconTrashOutlineRegular size={14} />} onClick={reset}>
              删除配置文件
            </Button>
          </>
        )}
      />

      {toast === null ? null : (
        <Toast key={toast.id} text={toast.text} tone="success" holdMs={2400} onDone={() => { setToast(null) }} />
      )}
    </div>
  )
}

/** Drop `exclusive` rather than storing an explicit `false`. */
function omitExclusive (group: GroupSpec): GroupSpec {
  const { exclusive: _exclusive, ...rest } = group
  return rest
}

/** The defaults a group currently carries. */
function defaultsOf (group: GroupSpec): readonly string[] {
  return group.defaultItems ?? []
}

/** Store `defaultItems`, or drop the field entirely when nothing is defaulted. */
function withDefaultItems (group: GroupSpec, ids: readonly string[]): GroupSpec {
  if (ids.length === 0) {
    const { defaultItems: _defaultItems, ...rest } = group
    return rest
  }
  return { ...group, defaultItems: ids }
}

/**
 * Set one item's "default on" state.
 *
 * In an `exclusive` group the checkbox is the only control for a radio
 * choice, so checking one clears the rest — the same single-select rule the
 * host enforces on write.
 */
function setDefault (group: GroupSpec, itemId: string, on: boolean): GroupSpec {
  const current = defaultsOf(group)
  if (!on) return withDefaultItems(group, current.filter(id => id !== itemId))
  if (group.exclusive === true) return withDefaultItems(group, [itemId])
  return withDefaultItems(group, current.includes(itemId) ? [...current] : [...current, itemId])
}

/**
 * Turn exclusivity on or off.
 *
 * Switching it on can leave a group with several defaults, which the host
 * refuses; the first one is kept because it is the one the page lists first.
 */
function withExclusive (group: GroupSpec, exclusive: boolean): GroupSpec {
  if (!exclusive) return omitExclusive(group)
  const current = defaultsOf(group)
  const kept = current.length > 1 ? current.slice(0, 1) : current
  return withDefaultItems({ ...group, exclusive: true }, kept)
}

/** Drop the ids of items that are no longer in the group. */
function pruneDefaults (group: GroupSpec, items: readonly ItemSpec[]): GroupSpec {
  const known = new Set(items.map(item => item.id))
  return withDefaultItems({ ...group, items }, defaultsOf(group).filter(id => known.has(id)))
}

/** Whether one group differs from the roster the draft was loaded from. */
function groupIsDirty (group: GroupSpec, baseline: readonly GroupSpec[]): boolean {
  const before = baseline.find(entry => entry.id === group.id)
  return before === undefined || JSON.stringify(before) !== JSON.stringify(group)
}

/** Drop `text`; a `textFile`-only item is the other half of the same choice. */
function omitText (item: ItemSpec): ItemSpec {
  const { text: _text, ...rest } = item
  return rest
}

/** Drop `textFile`, leaving the inline body in force. */
function omitTextFile (item: ItemSpec): ItemSpec {
  const { textFile: _textFile, ...rest } = item
  return rest
}

/** Store `desc` only when it has content. */
function withDesc (item: ItemSpec, value: string): ItemSpec {
  return value.length === 0 ? omitDesc(item) : { ...item, desc: value }
}

/** Drop `desc`. */
function omitDesc (item: ItemSpec): ItemSpec {
  const { desc: _desc, ...rest } = item
  return rest
}

/**
 * Styles for the settings page; injected by the client entry.
 *
 * The page sits inside the shell's own panel column, so it paints cards with
 * the settings-card tokens and leaves the dialog chrome alone.
 */
export const RP_SETTINGS_STYLE = `
.dsh-rcp-root{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dsh-rcp-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.dsh-rcp-head-text{min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-rcp-title-row{display:flex;align-items:center;gap:8px}
.dsh-rcp-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.dsh-rcp-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-rcp-path{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);word-break:break-all}
.dsh-rcp-actions{display:flex;gap:6px;flex:none}

.dsh-rcp-note{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);font-size:12px;display:flex;gap:6px;align-items:flex-start}
.dsh-rcp-note-icon{flex:none;margin-top:2px}
.dsh-rcp-note-error{background:rgba(239,68,68,.12);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-rcp-note-warn{background:rgba(245,158,11,.12);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-label)}
.dsh-rcp-note-dirty{background:rgba(76,120,255,.12);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-label-secondary)}

.dsh-rcp-card{display:flex;flex-direction:column;gap:10px;padding:12px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
.dsh-rcp-card-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-rcp-toggle{display:flex;flex:1 1 320px;min-width:0;align-items:center;gap:8px;padding:2px 4px;border:0;border-radius:var(--dsw-radius-sm);background:none;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dsh-rcp-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rcp-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-rcp-caret{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dsh-rcp-caret-open{transform:rotate(180deg)}
.dsh-rcp-card-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rcp-card-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}
.dsh-rcp-changed{flex:none;padding:0 6px;border-radius:var(--dsw-radius-xs,4px);background:rgba(76,120,255,.14);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px}
.dsh-rcp-card-fields{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-rcp-card-fields .dsh-rcp-name{flex:1 1 200px;min-width:160px}
.dsh-rcp-switch{display:inline-flex;align-items:center;gap:6px;flex:none}
.dsh-rcp-switch-text{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-rcp-hint{flex:1 1 100%;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-rcp-default-box{flex:none;white-space:nowrap}

.dsh-rcp-items{display:flex;flex-direction:column;gap:10px}
.dsh-rcp-item{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dsh-rcp-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-rcp-item-head .dsh-rcp-name{flex:1 1 160px;min-width:140px}
.dsh-rcp-item-head .dsh-rcp-desc{flex:2 1 220px;min-width:160px}

.dsh-rcp-field{display:flex;flex-direction:column;gap:4px}
.dsh-rcp-field-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-rcp-field-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-rcp-text{box-sizing:border-box;width:100%;min-height:120px;max-height:360px;padding:8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:12px;line-height:1.55;resize:vertical}
.dsh-rcp-text:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsh-rcp-file{display:flex;width:100%}

.dsh-rcp-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-rcp-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:var(--dsw-font-family-mono,ui-monospace,monospace)}
`
