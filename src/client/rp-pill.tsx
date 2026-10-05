/**
 * Composer tool-row pill: the RP 总控 — grouped, independently togglable
 * writing switches, like the SillyTavern preset screen.
 *
 * Registered into the official `conversation.input.right` seat — the slot DSH
 * renders immediately to the left of the model selector. That seat is
 * declared `{ kind: 'list', scope: 'session' }`, so this pill coexists with
 * other plugins' pills and is handed its own session id, which is what keeps
 * the selection per-session.
 *
 * The menu is portalled to `document.body` and positioned `fixed` from the
 * pill's own viewport rect. Two earlier attempts failed for instructive
 * reasons:
 *   1. `absolute` inside the pill — the composer's ancestor clips (and
 *      stacking-contexts) it, so the menu opened and was simply invisible.
 *   2. `fixed` inside the pill — a transformed ancestor becomes the containing
 *      block for fixed descendants, so viewport coordinates landed the menu in
 *      the corner of the window.
 * Leaving the pill's subtree fixes both at once: `getBoundingClientRect()`
 * always reports viewport coordinates, and that is exactly what a `fixed`
 * element under `body` is positioned against.
 *
 * The card itself is the shared `MenuSurface` / `MenuGroup` material, so the
 * menu reads as a DSH menu in both themes; only the geometry the composer seat
 * needs — fixed coordinates, a scrolling body, a filter row — is local. Rows
 * stay `menuitemcheckbox` / `menuitemradio`, because a switch list that reports
 * itself as a command list loses the state a screen reader has to announce.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconListPenOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  MenuGroup,
  MenuSurface,
  Pill,
  Button,
  observeStickyMenuGroups,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { RP_ROUTE, type GroupSpec, type ItemSpec, type RpState } from '../shared.js'

/** Business face injected at registration time by the client entry. */
export interface RpPillFace {
  /** Session this pill instance belongs to; the seat is session-scoped. */
  sessionId: string
}

/** Gap kept between the menu and the pill, and between the menu and the viewport. */
const MENU_GAP = 8
/** Assumed width before the menu is measurable; must match the CSS min-width. */
const MENU_FALLBACK_WIDTH = 300
/** Item count from which the menu offers a filter box. */
const SEARCH_MIN_ITEMS = 8

function messageOf (cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Read the session's current selection. */
async function readRpState (sessionId: string): Promise<RpState> {
  const response = await fetch(`${RP_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as RpState
}

/** Toggle one item and return the refreshed state. */
async function writeRpState (sessionId: string, itemId: string, on: boolean): Promise<RpState> {
  const response = await fetch(RP_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, itemId, on }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as RpState
}

/**
 * Viewport position for the menu: right-aligned to the pill, opening upward
 * like the model selector's own menu, clamped so no edge leaves the screen.
 */
function placeMenu (anchor: HTMLElement, menu: HTMLElement | null): { left: number, top: number } {
  const rect = anchor.getBoundingClientRect()
  const width = menu?.offsetWidth ?? MENU_FALLBACK_WIDTH
  const height = menu?.offsetHeight ?? 0
  const left = Math.max(MENU_GAP, Math.min(rect.right - width, window.innerWidth - width - MENU_GAP))
  // The composer sits at the bottom, so upward is almost always right; flip
  // below only when the menu genuinely does not fit above the pill.
  const above = rect.top - height - MENU_GAP
  const top = above >= MENU_GAP
    ? above
    : Math.min(rect.bottom + MENU_GAP, Math.max(MENU_GAP, window.innerHeight - height - MENU_GAP))
  return { left, top }
}

/**
 * The groups a query leaves: a group whose own name matches keeps every item,
 * otherwise only the items whose name or description matches. An empty query
 * returns the roster untouched.
 */
function filterGroups (groups: readonly GroupSpec[], query: string): readonly GroupSpec[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return groups
  const result: GroupSpec[] = []
  for (const group of groups) {
    if (group.name.toLowerCase().includes(needle)) {
      result.push(group)
      continue
    }
    const items = group.items.filter((item: ItemSpec) =>
      item.name.toLowerCase().includes(needle)
      || (item.desc ?? '').toLowerCase().includes(needle))
    if (items.length > 0) result.push({ ...group, items })
  }
  return result
}

/** The RP 总控 menu: group titles + one toggle row per item. */
export function RpPill (props: RpPillFace) {
  const [state, setState] = useState<RpState | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [menuPos, setMenuPos] = useState<{ left: number, top: number } | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let active = true
    setError('')
    void readRpState(props.sessionId)
      .then(next => { if (active) setState(next) })
      .catch((cause: unknown) => { if (active) setError(messageOf(cause)) })
    return () => { active = false }
  }, [props.sessionId])

  // Position synchronously after the menu is in the DOM but before paint, so
  // the hidden first frame is never visible. Re-placed on resize and scroll
  // because the composer (and therefore the pill) moves with the layout, and
  // when the filter row changes the menu's own height.
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const anchor = anchorRef.current
    if (anchor === null) return
    const update = (): void => { setMenuPos(placeMenu(anchor, menuRef.current)) }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, state, query])

  // Close on outside press and Escape. The menu is portalled out of the pill,
  // so it has to be exempted by its own class rather than by containment.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event): void => {
      const target = event.target
      if (target instanceof Element
        && (target.closest('.dsh-rc-root') !== null || target.closest('.dsh-rc-menu') !== null)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  // A reopened menu must not remember the previous search.
  useEffect(() => { if (!open) setQuery('') }, [open])

  // Sticky group headings need the scroll container's observers; membership is
  // captured per setup, so the effect re-observes whenever the filter changes.
  useEffect(() => {
    const viewport = listRef.current
    if (!open || viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [open, state, query])

  /** Toggle one item; the menu stays open so several switches can be flipped. */
  const select = (itemId: string, on: boolean): void => {
    if (pending !== undefined) return
    setError('')
    setPending(itemId)
    void writeRpState(props.sessionId, itemId, on)
      .then(next => { setState(next) })
      .catch((cause: unknown) => { setError(messageOf(cause)) })
      .finally(() => { setPending(undefined) })
  }

  const groups = state?.groups ?? []
  const selection = state?.selection ?? {}
  const onCount = Object.keys(selection).length
  const itemCount = groups.reduce((total, group) => total + group.items.length, 0)
  const shown = useMemo(() => filterGroups(groups, query), [groups, query])
  const label = error.length > 0
    ? '预设 ?'
    : (state === null ? '预设 · …' : (onCount > 0 ? `预设 · ${onCount}` : '预设 · 关'))
  const title = error.length > 0
    ? `预设不可用：${error}`
    : '预设开关（分组 · 独立开关）'

  return (
    <div className="dsh-rc-root">
      <span className="dsh-rc-anchor" ref={anchorRef}>
        <Pill
          active={open}
          className="dsh-rc-pill"
          aria-haspopup="menu"
          aria-expanded={open}
          title={title}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconListPenOutlineRegular size={14} className="dsh-rc-pill-icon" />
          <span className="dsh-rc-pill-label">{label}</span>
          <IconChevronDownOutlineRegular
            size={12}
            className={`dsh-rc-caret${open ? ' dsh-rc-caret-open' : ''}`}
          />
        </Pill>
      </span>
      {open ? createPortal(
        <MenuSurface
          ref={menuRef}
          className="dsh-rc-menu"
          role="menu"
          aria-label="预设开关"
          style={{
            left: menuPos?.left ?? 0,
            top: menuPos?.top ?? 0,
            // Hidden only for the first unmeasured frame; `visibility` is what
            // `placeMenu` measures against, and the backing mirror it.
            visibility: menuPos === null ? 'hidden' : 'visible',
          }}
        >
          {itemCount >= SEARCH_MIN_ITEMS ? (
            <div className="dsh-rc-search">
              <Input
                className="dsh-rc-search-input"
                icon={<IconSearchOutlineRegular size={14} />}
                value={query}
                placeholder="搜索条目"
                aria-label="搜索条目"
                onChange={(event) => { setQuery(event.target.value) }}
              />
            </div>
          ) : null}
          <div className="dsh-rc-list" ref={listRef}>
            {shown.map((group: GroupSpec) => (
              <MenuGroup key={group.id} label={group.name}>
                {group.items.map((item: ItemSpec) => {
                  const on = selection[item.id] === true
                  return (
                    <Button
                      key={item.id}
                      variant="ghost"
                      size="sm"
                      role={group.exclusive === true ? 'menuitemradio' : 'menuitemcheckbox'}
                      aria-checked={on}
                      className={`dsh-rc-option${on ? ' dsh-rc-option-on' : ''}`}
                      disabled={pending !== undefined}
                      onClick={() => { select(item.id, !on) }}
                      icon={on
                        ? <IconCheckOutlineRegular size={14} className="dsh-rc-check" />
                        : <span className="dsh-rc-check-empty" />}
                    >
                      <span className="dsh-rc-option-text">
                        <span className="dsh-rc-option-name">{item.name}</span>
                        {item.desc === undefined
                          ? null
                          : <span className="dsh-rc-option-desc">{item.desc}</span>}
                      </span>
                    </Button>
                  )
                })}
              </MenuGroup>
            ))}
            {shown.length === 0
              ? <div className="dsh-rc-empty">没有匹配的条目</div>
              : null}
          </div>
          {error.length > 0 ? <div className="dsh-rc-error" role="alert">{error}</div> : null}
        </MenuSurface>,
        document.body,
      ) : null}
    </div>
  )
}

/**
 * Styles for the pill and its menu; injected by the client entry.
 *
 * The menu itself is `fixed`, portalled to the body, and painted by the shared
 * `MenuSurface` material — see the module note above — so its `left`/`top` come
 * from the component, not from CSS anchoring. Colors and radii are DSH theme
 * tokens only, so both themes follow without a scheme check here.
 */
export const RP_PILL_STYLE = `
.dsh-rc-root{position:relative;display:inline-flex;align-items:center}
.dsh-rc-anchor{display:inline-flex;align-items:center}
.dsh-rc-pill{max-width:100%}
.dsh-rc-pill-icon{flex:none;color:var(--dsw-alias-brand-primary)}
.dsh-rc-pill-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rc-caret{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dsh-rc-caret-open{transform:rotate(180deg)}

.dsh-rc-menu{position:fixed;z-index:2147483000;box-sizing:border-box;display:flex;flex-direction:column;min-width:300px;max-width:min(380px,calc(100vw - 24px));max-height:min(440px,calc(100vh - 48px));padding:4px;font-size:12.5px;line-height:1.3;color:var(--dsw-alias-label-primary);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}

.dsh-rc-search{padding:2px 2px 6px}
.dsh-rc-search-input{display:flex;width:100%;height:28px;border-radius:var(--dsw-radius-sm)}

.dsh-rc-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 2px}

.dsh-rc-list .dsh-rc-option{display:flex;width:100%;height:auto;min-height:0;justify-content:flex-start;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-sm);text-align:left;font-size:12.5px;line-height:1.3;color:var(--dsw-alias-label-primary)}
.dsh-rc-list .dsh-rc-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rc-list .dsh-rc-option:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dsh-rc-list .dsh-rc-option:disabled{opacity:.55;cursor:default}
.dsh-rc-list .dsh-rc-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-rc-list .dsh-rc-option-on{background:var(--dsw-alias-button-ghost-active-fill);box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}
.dsh-rc-list .dsh-rc-option-on:hover:not(:disabled){background:var(--dsw-alias-button-ghost-active-hover)}

.dsh-rc-check{color:var(--dsw-alias-brand-primary)}
.dsh-rc-check-empty{display:inline-block;width:14px;height:14px}
.dsh-rc-option-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsh-rc-option-name{font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rc-option-desc{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dsh-rc-empty{padding:12px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}
.dsh-rc-error{margin-top:4px;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:rgba(239,68,68,.14);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:1.4;word-break:break-word}
`
