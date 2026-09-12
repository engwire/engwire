/**
 * @file Experimental extension authoring helper: `import { definePlugin } from "engwire"`.
 *
 * The package is private and there is no plugin runtime or supported extension API. This retained design artifact has no runner dependencies; `plugin.test.ts` checks that import boundary. Possible extensions are sketched in docs/explorations/extensions.md.
 */

/**
 * Metadata accepted by the experimental helper. No runtime consumes it.
 */
type Plugin = {
  /** Description text; formatting is not validated here. */
  description?: string;
};

/** Provides contextual typing for an object literal and returns it unchanged, without runtime validation. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
