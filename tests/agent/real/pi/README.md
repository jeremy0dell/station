# Real Pi Agent Lane

This lane is opt-in and is not part of `test:all`.

Run it only when the local machine has:

- `tmux`
- Pi `0.80.5` or newer
- `pi --version` exiting `0`
- `@juicesharp/rpiv-ask-user-question` `1.20.0` or newer installed in Pi's
  agent package directory

```bash
pnpm build

STATION_REAL_PI=1 \
STATION_PI_BIN="$(command -v pi)" \
STATION_TMUX_BIN="$(command -v tmux)" \
pnpm test:e2e:pi:real
```

The launch-scaffolding test creates a temporary git worktree, starts a unique
`tmux` session, launches a Pi-shaped wrapper through `createPiHarnessProvider`,
verifies the launched argv includes `--extension <dist/piExtension.js>`, and
reconciles a provider-neutral Pi harness run with low-confidence `unknown`
status.

The callback test runs the real Pi binary in print mode against an isolated
Observer and session directory. A faux provider registered through Pi's
production extension API makes the turn deterministic and network-free. The
test verifies that `agent_end` remains a low-level working edge,
`agent_settled` carries the idle completed-turn readiness edge before quit
shutdown, and the final reconciled process state is exited.

The status-regression tests run the actual Pi TUI under `tmux` with that faux
provider and the real Station extension. They verify markerless legacy
completion, a visible `ask_user_question` dialog retaining attention while a
parallel `read` finishes, and invalid question preflight producing no attention.
Captured Station payloads are also checked to ensure question prose and options
never cross the adapter boundary. Pi `0.80.5+` is required because earlier
releases do not emit `agent_settled`.

Set `STATION_REAL_PI_ASK_USER_EXTENSION` when the question extension is
installed outside its default Pi package path. Set
`STATION_REAL_PI_PACKAGE_ROOT` only when `STATION_PI_BIN` is a wrapper whose
real path does not identify the Pi package root.
