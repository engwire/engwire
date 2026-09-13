# Running on Linux

`engwire service install` supports macOS only. On Linux, run `engwire run` under your own supervisor. This page provides a systemd user unit and explains the environment, shutdown and logging settings it needs.

Engwire does not install or manage this unit. Set the executable path, PATH, installation and credential directories, and shutdown timeout for your setup. Unlike the launchd integration, this unit inherits the user manager’s environment and removes only the credential overrides listed below.

`~/.config/systemd/user/engwire.service`:

```ini
[Unit]
Description=Engwire

[Service]
# Where install.sh put it: `command -v engwire`.
ExecStart=%h/.local/bin/engwire run
Restart=always
RestartSec=5

# The runner forwards SIGTERM to an active review and kills its process group
# after ten seconds if needed. Checkout cleanup can also wait for a 60-second
# worktree prune plus Git’s five-second kill grace; local directory removal
# has no deadline. Output reads are cancelled when Git is stopped, even if a
# descendant still holds a pipe. This conservative supervisor limit allows
# the default 20-minute run_timeout plus 90 seconds for cleanup; increase it
# if you raise run_timeout.
TimeoutStopSec=21min 30s

# SIGTERM reaches the runner, which forwards it to the review itself and has
# state to write down before it goes. Measured: with the default, a stop
# SIGTERMed the leader *and* its child, which is systemd racing the sequence
# Engwire runs; with this, only the leader was signalled (docs/experiments.md).
KillMode=mixed

# Logs and worktrees hold private repository names and private source.
UMask=0077

# A user service inherits the user manager's environment, not your shell's:
# the manager starts at login, so what a `.bashrc` exports later never reaches
# it. `engwire setup` records absolute paths for `gh` and `claude`, but `git`
# is still found on PATH — as is whatever those two invoke themselves. This is
# a starting point, not an answer: if any of that lives somewhere else —
# Homebrew on Linux, `~/.bun/bin` — use the PATH your own shell has, which is
# the one `engwire doctor` passes with.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

# The rest of what launchd is given, and the half a unit file makes easy to
# forget: these say *which* installation and *whose* accounts, so the service
# resolving them differently from your shell is not a smaller setup — it is a
# different one.
#
# Commented here means "not overridden by this unit", which is not the same as
# unset. A value already in the user manager is inherited whatever this file
# says — that is the inherit-first policy the credential note below is also
# about, and these are the selectors it applies to. So check
# `systemctl --user show-environment`, and for each name below either set the
# value you mean explicitly or take the unintended one out of the manager.
# Carrying an empty value is worse than carrying nothing.
#
# ENGWIRE_HOME and the XDG pair decide which config.toml and which queue. Get
# this wrong and `engwire doctor` stays green in your shell while the service
# reads a different installation entirely — a config it never finds, and a
# queue that is not the one you just inspected.
#Environment=ENGWIRE_HOME=%h/somewhere
#Environment=XDG_CONFIG_HOME=%h/.config
#Environment=XDG_DATA_HOME=%h/.local/share
#
# These two hold the credentials the review posts with. A service that cannot
# see them is a service authenticated as nobody. CLAUDE_CONFIG_DIR has to be
# absolute even here: a relative one is refused wherever Engwire reads it, and
# the skill preflight then holds every review rather than running one.
#Environment=GH_CONFIG_DIR=%h/.config/gh
#Environment=CLAUDE_CONFIG_DIR=%h/.claude

# The direct environment credential overrides Engwire has measured. Not the same
# policy as the launchd job's allowlist, and weaker: launchd is given a list of
# what to carry, while this inherits the user manager's environment wholesale
# and then removes the names it knows about. Each of these five was measured to
# replace the stored identity — `gh` answers "Bad credentials" under a bogus
# GH_TOKEN or GITHUB_TOKEN while its keyring account works, and `claude auth
# status` drops its account and names the variable instead (docs/experiments.md).
# A credential mechanism this list has not met still gets through, which is the
# cost of a blocklist and the reason launchd's shape is the better one.
#
# Note the distinction the PATH comment above draws: a plain `export` in
# `.bashrc` is not the user manager's environment, but `systemctl --user
# import-environment`, a drop-in, or a login shell that starts the manager is.
UnsetEnvironment=GH_TOKEN GITHUB_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN

[Install]
WantedBy=default.target
```

```sh
loginctl enable-linger "$USER"        # keep running while you are logged out
systemctl --user enable --now engwire
journalctl --user -u engwire -f       # the runner's own output
```

Nothing orders this after the network. A runner that starts before one is available waits for GitHub and says so, rather than exiting into a restart loop — so ordering would only delay the honest version of that message.

`engwire status` names a logs directory. On Linux it holds the review transcripts alone. The unit above sets no `StandardOutput`, so the runner's own output goes wherever your user manager sends it — the journal, unless you have changed that default. The launchd job writes the runner’s output to `runner.log` in that directory.

`engwire uninstall` removes the data, the config, and on macOS the launchd job. It knows nothing about a unit you wrote, so retire that yourself:

```sh
systemctl --user disable --now engwire
rm ~/.config/systemd/user/engwire.service
systemctl --user daemon-reload        # the manager caches what you just deleted
```
