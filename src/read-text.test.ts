/**
 * Test cancellation directly: a caller that races a rejected deadline can
 * return promptly even if it forgets to cancel its output reads. An endless
 * stream makes cancellation observable independently of subprocess timing.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readText } from "./read-text.ts";

/** A stream that yields what it is given and then stays open forever. */
function endless(...chunks: string[]): { stream: ReadableStream<Uint8Array>; closed: boolean } {
  const state = { stream: null as unknown as ReadableStream<Uint8Array>, closed: false };
  state.stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    },
    // Called when the reader is cancelled, which is how this test can tell the
    // difference between giving up on the read and simply not reading.
    cancel() {
      state.closed = true;
    },
  });
  return state;
}

describe("readText", () => {
  test("reads a stream that ends", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("gh version "));
        controller.enqueue(new TextEncoder().encode("2.31.0\n"));
        controller.close();
      },
    });

    expect(await readText(stream).text).toBe("gh version 2.31.0\n");
  });

  test("gives up on a stream that does not end", async () => {
    // The whole point. A descendant holding a killed process's pipe leaves a
    // stream exactly like this one, and a caller waiting on it waits for the
    // descendant — for `git` that is the runner's one execution slot, held by a
    // checkout that has already been stopped.
    const held = endless("partial output");
    const reading = readText(held.stream);

    reading.cancel();

    expect(await reading.text).toBe("");
    // Not merely resolved: the stream was released, so nothing is still reading.
    expect(held.closed).toBe(true);
  });

  test("discards what it had rather than returning half an answer", async () => {
    // A truncated version string read as complete would be worse than none:
    // `ghVersionProblem` would report a `gh` that is too old rather than one
    // that never answered.
    const held = endless("gh version 2.3");
    const reading = readText(held.stream);
    // Let the first chunk land, so there is something to be tempted by.
    await Bun.sleep(10);

    reading.cancel();

    expect(await reading.text).toBe("");
  });

  test("cancelling a stream that already failed does not take the process down", async () => {
    // `reader.cancel()` rejects when the stream has errored, and an unhandled
    // rejection ends a Bun process with status 1 — so the `.catch` is the
    // difference between a runner that records a failed checkout and one that
    // simply dies mid-review. A broken pipe while a checkout is being abandoned
    // is exactly when both happen at once.
    //
    // Asked of a child, because `bun test` swallows the rejection and the
    // assertion would pass either way in process. The same reason
    // `paths.test.ts` spawns one, and the same seam.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `import { readText } from ${JSON.stringify(join(import.meta.dir, "read-text.ts"))};
         let fail = () => {};
         const stream = new ReadableStream({ start(c) { fail = (e) => c.error(e); } });
         const reading = readText(stream);
         // Observed, so the read's own rejection is not what is being measured.
         reading.text.then(() => {}, () => {});
         fail(new Error("broken pipe"));
         reading.cancel();
         await Bun.sleep(50);`,
      ],
      // Anywhere but the source tree: a child resolves its caches against the
      // working directory and would leave them here.
      cwd: tmpdir(),
      stdout: "ignore",
      stderr: "ignore",
    });

    expect(await child.exited).toBe(0);
  });

  test("cancelling twice, or after the answer arrived, changes nothing", async () => {
    // Cleanup may repeat cancellation or run after the stream has ended.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("done"));
        controller.close();
      },
    });
    const reading = readText(stream);

    expect(await reading.text).toBe("done");
    expect(() => {
      reading.cancel();
      reading.cancel();
    }).not.toThrow();
    expect(await reading.text).toBe("done");
  });
});
