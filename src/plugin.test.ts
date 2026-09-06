import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { definePlugin as packageEntry } from "engwire";
import { definePlugin } from "./plugin.ts";

describe("definePlugin", () => {
  test("hands back exactly what it was given", () => {
    const plugin = { description: "Answer Linear issues" };

    expect(definePlugin(plugin)).toBe(plugin);
  });

  test("rejects metadata the type does not describe", () => {
    // Contextual typing is the whole product here, and only tsc can see it:
    // widening the parameter to `unknown` leaves every runtime check above green.
    // An unused @ts-expect-error fails the typecheck, so the next line is the assertion.
    // @ts-expect-error description is string metadata
    definePlugin({ description: 42 });
  });
});

describe("engwire", () => {
  test("is the specifier an author writes, resolved as one", () => {
    // Exercise package resolution in Bun and tsc, then confirm it reaches this module.
    expect(packageEntry).toBe(definePlugin);
  });

  test("pulls none of the runner in behind it", async () => {
    // Builtins appear in import lists rather than as separate inputs, so check both.
    // This does not detect erased type imports or runtime-specific globals; those still need review.
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "plugin.ts")],
      target: "bun",
      metafile: true,
    });
    const inputs = Object.values(built.metafile!.inputs);
    expect(inputs).toHaveLength(1);
    expect(inputs.flatMap((input) => input.imports)).toEqual([]);
  });
});
