/**
 * One owner for the version number.
 *
 * `package.json` is where `bun run build` reads it, so it is the source and
 * this is a view of it. Bun inlines the JSON at compile time, so the released
 * binary has no file to find at runtime.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
