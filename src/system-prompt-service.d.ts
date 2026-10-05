/**
 * Ambient typing for the `systemPrompt` service on the cordis Context.
 *
 * The service lives in the host's `@deepseek-ai/dsh-system-prompt` plugin,
 * which this bundle does not depend on directly (it arrives transitively and
 * must not become a hard requirement: a host booted without it still runs the
 * composer pill). This local declaration restores exactly the surface this
 * plugin consumes — dynamic context registration and prompt-variable
 * registration. The `export {}` keeps this a
 * module so the `declare module` below augments cordis's Context instead of
 * replacing it.
 */
export {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Prompt assembly registry provided by @deepseek-ai/dsh-system-prompt. */
    systemPrompt: {
      /**
       * Register ordered dynamic context, evaluated on every prompt assembly.
       * The provider receives the assembly context, which carries the agent
       * the assembly is for (`{ agent, scope: agent }`), so a per-session
       * contribution stays per-session.
       */
      context(contribution: {
        /** Unique name — a duplicate registration throws. */
        readonly name: string
        /** Contexts are joined in ascending order. */
        readonly order: number
        /** Static text, or a provider evaluated per assembly. */
        readonly text: string | ((context: unknown) => string)
      }): () => void
      /**
       * Register a `{{name}}` prompt variable, evaluated per assembly.
       *
       * The provider receives the same assembly context as a prompt context.
       * It may answer `''`, but the value may not be `undefined`: interpolating
       * a section that references an `undefined` variable throws, and a
       * throwing variable fails the whole assembly.
       */
      variable(
        name: string,
        provider: (context: unknown) => string,
      ): () => void
    }
  }
}
