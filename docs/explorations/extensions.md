# Extensions: workflows and plugins

**Status: directional exploration. Not a build contract, not a schedule, and not a public compatibility commitment.** The runner loads no workflows and no plugins, and [product.md](../product.md#not-scope-now) puts a public extension API outside current scope. This sketch preserves earlier design work for use if real routines eventually justify an extension system. A second routine alone does not establish that need or authorize this work.

Nothing here binds. [Security boundary](#security-boundary) restates two rules that do, but their authority is [SECURITY.md](../../SECURITY.md), where they follow from the review runner's own threat model rather than from any guess about extensions. Everything else, including the working assumptions immediately below, is a design position a real routine is allowed to overturn.

## Working assumptions

Not requirements. They are where the design starts, and each names what it is really made of.

- **Workflows describe routines; plugins add executable capabilities.** The split worth keeping is between a thing that can be read and a thing that must be run.
- **Workflows should be statically inspectable wherever practical.** Follows from the point above: a format nobody can inspect cannot be reviewed before it runs.
- **Public formats emerge from proven routines, not ahead of them.** The general rule from [product.md](../product.md#decision-rules), applied here.
- **Community extensions live in their authors' repositories, with GitHub as the source of truth.** A distribution choice. Cheap now, and reversible if real authors want something else.
- **Official and community extensions use the same conventions; built-in versus optional is a distribution choice.** An API-shape preference, chosen so an extension can be promoted without changing identity. Not derived from anything.

## Security boundary

This part is not speculative, and it is not this document's to define. [SECURITY.md](../../SECURITY.md) states the two rules that bind any loader that ever arrives — **publishing is not loading**, and **execution resolves from installed state, never from the working directory** — because they follow from the review runner's threat model rather than from anything designed here. Read them there; if this page ever appears to say something different, this page is wrong.

What they imply for a design is worth writing down. Repository contents may be an installation *source* and never an execution source, so the boundary is not where the bytes came from — it is that execution resolves from Engwire-controlled installed state rather than from whichever repository happens to be the process working directory. Builtins would then have the right semantics for the right reason: official extensions compiled into the binary, rather than trusted for living in the Engwire repository.

The runner's existing working-directory protections do not extend to this on their own. `scripts/build.ts` compiles out Bun's autoloading of `.env`, `bunfig.toml`, `tsconfig.json` and `package.json` precisely because the working directory may be a checkout of the branch under review, and `claude --setting-sources user` draws the same line for the agent's configuration. Both govern other people's loaders. An `.engwire/` loader would be Engwire's own code and inherits neither.

Two further positions are this sketch's own, and a real loader may argue them down: install by exact commit SHA and store it, so nothing executes a moving branch afterwards, and discover metadata without executing the third-party code that supplies it. Neither follows from the rules above — immutable installed content would satisfy that boundary without keeping a Git identity at all.

## Directional design

Everything from here is a sketch. Treat a conflict between it and a real routine's needs as the sketch being wrong.

### Repository convention

Any Git repository may publish extensions under `.engwire/`:

```text
.engwire/
├── workflows/
│   └── review-request.json
└── plugins/
    └── linear/
        └── plugin.ts
```

The file or directory name is the canonical extension name, lowercase kebab-case, and is not repeated inside the manifest. One repository may hold several of each.

### Workflows

A workflow declaratively composes capabilities Engwire already has:

```json
{
  "$schema": "https://engwire.com/schemas/workflow.json",
  "title": "Review Request",
  "on": { "github": { "event": "review_requested" } },
  "steps": [{ "uses": "agent.run", "with": { "skill": "code-review" } }]
}
```

JSON, because the artifact wants schema validation, editor autocomplete, static inspection, capability analysis and deterministic diffing — none of which survive arbitrary executable logic in the format. Behavior a workflow cannot express belongs in a plugin, not in workflow syntax.

`src/workflows/workflow.schema.json` pins that shape today, and [ADR-0002](../adr/0002-pin-the-workflow-file-format-before-a-loader.md) records why it was pinned before a loader existed and what it chose. **The schema is experimental until Engwire publishes a supported workflow API; compatibility is not guaranteed** ([ADR-0003](../adr/0003-withdraw-the-workflow-formats-compatibility-promise.md)). What a real routine needs — whether `steps` survives, whether `on` stays explicit, how values pass between steps, whether composition or a DAG appears, which capabilities are built in — is unknown until more than one routine exists.

### Plugins

A plugin teaches Engwire a capability it does not have: a source, an event, an action, a destination, an enrichment, an integration. Executable code, and therefore a stronger trust boundary than a workflow.

The `engwire` package reserves `import { definePlugin } from "engwire"` as the authoring entry point. The sketch adds no executable `defineWorkflow()` unless declarative workflows prove insufficient; if one ever arrives, compiling it to the same static representation would keep a workflow inspectable without running it.

A plugin API should expose enough static metadata to explain capabilities and requested permissions before anything runs — source repository, the exact identity it was pinned to, publisher, declared capabilities, network and secret access, official or community.

### Installation and discovery

Installation from GitHub, pinned to a SHA, with no central registry and no approval step:

```sh
engwire add alice/engwire --workflow linear-review
engwire add alice/engwire@v1 --plugin linear
```

Installing would keep working when the user is logged out, telemetry is off, any hosted Engwire service is unavailable, or the extension is unlisted, and private extension contents would never be uploaded or indexed implicitly. If that last one turns out to be a durable requirement rather than a preference, SECURITY.md is where it belongs.

If discovery ever becomes useful, a workflow directory is the likely first surface, holding metadata rather than canonical source; its URL and packaging are deferred. The preference is not to call it a marketplace: that word implies publisher relationships, distribution, trust labels, governance and possibly payments, and claiming them before they exist is a promise nobody asked for. Trust labels, if any, would need to be specific — `Official`, `Community`, `Publisher verified`, `Automated scan passed` — and a generic `Verified` means nothing. Listing is not security review.

## Deliberately not designed yet

A package registry or hosting · ratings and reviews · a paid marketplace · a publisher dashboard · a workflow compiler · executable `defineWorkflow()` · dedicated `engwire/workflows` or `engwire/plugins` repositories · multiple packaging formats · an SDK versioned separately from Engwire.

Prefer the smallest extension system that preserves the security boundary above.
