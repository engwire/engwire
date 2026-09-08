/**
 * Read a subprocess stream to the end, retaining a reader the caller can cancel.
 * Cancellation discards buffered output instead of returning a partial answer.
 *
 * Killing a process need not close pipes held by descendants (measured in
 * docs/experiments.md). `Response.text()` hides its reader, so a caller cannot
 * cancel that read when it abandons the process.
 *
 * This helper owns only the stream. Spawning, environments, deadlines, signals
 * and exit handling remain at each subprocess boundary.
 */
export function readText(stream: ReadableStream<Uint8Array>): {
  text: Promise<string>;
  cancel: () => void;
} {
  const reader = stream.getReader();
  let chunks: Uint8Array[] | null = [];
  const text = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || chunks === null) break;
      chunks.push(value);
    }
    // Avoid allocating a combined buffer for output discarded after a timeout.
    return chunks === null ? "" : new TextDecoder().decode(Buffer.concat(chunks));
  })();
  return {
    text,
    cancel: () => {
      chunks = null;
      void reader.cancel().catch(() => {});
    },
  };
}
