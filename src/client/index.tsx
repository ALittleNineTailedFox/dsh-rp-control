/**
 * Browser half: the composer-seat RP pill plus its settings page.
 *
 * The pill is registered into the official `conversation.input.right` seat, so
 * DSH itself decides where it lands (immediately left of the model selector)
 * and the plugin never touches product DOM or global theme. The page is
 * registered into the official `settings.section` seat for the same reason: the
 * shell owns the nav row, the dialog, and the panel column.
 */
import type { Context } from '@deepseek-ai/cordis'
import { RP_PILL_STYLE, RpPill, type RpPillFace } from './rp-pill.js'
import { RP_SETTINGS_STYLE, RpSettings } from './rp-settings.js'

export const name = 'dsh-rp-control'

/** The seat registry is the only hard dependency. */
export const inject = ['slots']

/**
 * The settings nav order. Built-in sections sit at 0/15/20 and the installed
 * plugins at 30/40/100/500, so this page lands after the built-ins and before
 * every third-party page.
 */
const SETTINGS_ORDER = 260

export function apply (ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['plugin'] = 'dsh-rp-control'
    style.textContent = `${RP_PILL_STYLE}\n${RP_SETTINGS_STYLE}`
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-rp-control: styles')

  // The seat's declaration carries no store, so its inject factory is handed
  // exactly the session id — the same identity the host resolves from the
  // assembling agent.
  const register = ctx.slots.register.bind(ctx.slots) as unknown as (
    options: object,
    component: unknown,
  ) => () => void
  const inject = ctx.slots.inject.bind(ctx.slots) as unknown as (
    key: string,
    factory: () => () => void,
  ) => void

  inject('conversation.input.right', () => register({
    name: 'conversation.input.right',
    id: 'rp-control',
    order: 21,
    inject: (sessionId: string): RpPillFace => ({ sessionId }),
  }, RpPill))

  // `settings.section` is a root-scoped list; the shell projects only `id`,
  // `order`, and `label`, and hands the component the panel's `close` callback.
  // The page reads and writes its own roster through the host route, so it
  // needs no injected data.
  inject('settings.section', () => register({
    name: 'settings.section',
    id: 'rp-control',
    order: SETTINGS_ORDER,
    label: 'RP 开关',
  }, RpSettings))
}
