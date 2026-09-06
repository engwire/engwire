/**
 * @file Reserved extension authoring entry point: `import { definePlugin } from "engwire"`.
 *
 * The package is private and there is no plugin runtime. Keep this module independent of the runner and runtime-specific APIs so future authors can import it outside Bun. The import boundary is checked in `plugin.test.ts`.
 *
 * Capability declarations belong with the future loader: they must provide enough static metadata to explain permissions before execution, and real workflows should determine their shape.
 */

/**
 * Plugin metadata. The planned canonical name comes from `.engwire/plugins/<name>/`, using the grammar in `workflow.schema.json` under `$defs/name`, so it is not duplicated here.
 *
 * Keep this type internal until authors need to name it; exporting it later is additive.
 */
type Plugin = {
  /** One-line summary intended for future listings; formatting is not validated here. */
  description?: string;
};

/** Provides contextual typing for an object literal and returns it unchanged, without runtime validation. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
