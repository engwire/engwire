/**
 * @file Keep extension scaffolding out of the runner's runtime import graph and detect unreached source files.
 *
 * Type-only dependencies are erased before bundling and are outside this check. A module containing only types also counts as unreached; review it explicitly if one is introduced.
 */

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** Excluded from the runner's current runtime import graph. */
const RESERVED = ["src/plugin.ts", "src/workflows/workflow.schema.json"];

test("the runner reaches every file under src/ except the reserved ones", async () => {
  const built = await Bun.build({
    entrypoints: [join(root, "src", "main.ts")],
    target: "bun",
    metafile: true,
  });
  // Metafile keys are relative to the working directory, not to the root.
  const reached = new Set(Object.keys(built.metafile!.inputs).map((input) => resolve(input)));
  const unreached = [...new Bun.Glob("src/**/*").scanSync(root)]
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) => !reached.has(join(root, file)))
    .sort();

  expect(unreached).toEqual(RESERVED.toSorted());
});
