// A tool the review left running. `LEAKY_IGNORE` makes it shrug off SIGTERM,
// which is what forces Engwire to escalate instead of assuming the group left
// when it was asked to.
//
// It announces itself only once that handler is installed: Bun takes long
// enough to start that a test signalling on the parent's output would otherwise
// catch it still obeying the default, and pass against a runner that never
// escalated.
if (process.env.LEAKY_IGNORE) process.on("SIGTERM", () => {});
const marker = process.env.LEAKY_MARKER!;
await Bun.write(`${marker}.ready`, "");
await Bun.sleep(Number(process.env.LEAKY_DELAY ?? 1_000));
await Bun.write(marker, "leaked\n");
