/**
 * @file Takes the runner lock and waits to be killed.
 *
 * A separate process because the thing under test is what happens when a lock
 * holder dies, and a test cannot kill itself.
 */
import { acquireLock } from "../../src/service/lock.ts";

acquireLock(process.argv[2] as string);
process.stdout.write("held\n");
await new Promise(() => {});
