/**
 * Ambient typing for the `slots` service on the cordis Context.
 *
 * The DSH browser runtime bundles the slot runtime internally, so this local
 * declaration restores exactly the surface this plugin consumes: `register`
 * (the SlotCore typed API, verbatim) plus `inject` (declaration-lifetime
 * effects). Slot keys stay `string` because the DSH seat this plugin targets
 * arrives as a plain string and the registration site narrows through its own
 * cast.
 */
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Slot registry provided by the DSH browser runtime. */
    slots: {
      register: SlotCore['register']
      inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
    }
  }
}
