# Real Pi Agent Lane

This lane is opt-in and is not part of `test:all`.

Run it only when the local machine has:

- `tmux`
- `pi`
- `pi --version` exiting `0`

```bash
pnpm build

STATION_REAL_PI=1 \
STATION_PI_BIN="$(command -v pi)" \
STATION_TMUX_BIN="$(command -v tmux)" \
pnpm test:e2e:pi:real
```

The current test is a conservative launch-scaffolding lane. It creates a temporary git worktree, starts a unique tmux session, launches a Pi-shaped wrapper through `PiHarnessProvider`, verifies the launched argv includes `--extension <dist/piExtension.js>`, and reconciles a provider-neutral Pi harness run with low-confidence `unknown` status.

The wrapper validates the configured real Pi binary with `pi --version` but holds the launched pane open instead of running a full Pi task. A later real callback lane should execute the actual Pi binary and assert ingested `harness.eventReported` events for provider `pi`.
