import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGh, GhError } from "./gh.ts";

// Stands in for `gh` by reporting the environment it was handed, so these tests
// are about what Engwire passes rather than about GitHub.
const dir = mkdtempSync(join(tmpdir(), "engwire-gh-"));
const bin = join(dir, "gh");
writeFileSync(
  bin,
  `#!/bin/sh
[ "$1" = "fail" ] && { echo "could not resolve host" >&2; exit 4; }
echo "$GH_HOST"
`,
);
chmodSync(bin, 0o755);

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("createGh", () => {
  test("pins GH_HOST over whatever the caller's environment says", async () => {
    const gh = createGh(bin, { PATH: process.env.PATH, GH_HOST: "github.acme.example" });
    expect((await gh.text(["api", "user"])).trim()).toBe("github.com");
  });

  test("a non-zero gh is a GhError carrying what went wrong", async () => {
    // The type the loop's outage policy is keyed on: a `GhError` waits for the
    // next poll, anything else takes the runner down.
    const gh = createGh(bin, { PATH: process.env.PATH });
    const error = await gh.text(["fail"]).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GhError);
    expect(error).toMatchObject({ args: ["fail"], exitCode: 4 });
    expect((error as GhError).message).toContain("could not resolve host");
  });
});
