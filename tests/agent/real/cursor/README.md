# Real Cursor Agent Lane

This lane is opt-in and is not part of `test:all`.

Run it only when the local machine has:

- `tmux`
- Cursor Agent `agent`
- `agent --version` exiting `0`

```bash
STATION_REAL_CURSOR=1 \
STATION_CURSOR_AGENT_BIN="$(command -v agent)" \
STATION_TMUX_BIN="$(command -v tmux)" \
pnpm test:e2e:cursor:real
```

The launch test creates a temporary git worktree, starts a unique tmux session, launches Cursor through a temporary shim that logs argv/env and then `exec`s the real Cursor Agent binary, reconciles observer state, and cleans up the tmux/temp state afterward.

The launch assertion is intentionally conservative: station must observe a provider-neutral Cursor harness run with `unknown` low-confidence status. The shim log and tmux pane/process evidence prove the Cursor launch happened without asserting on Cursor screen text.

The hook assertion installs the generated Cursor hook, routes an active-to-stop sequence through the checkout's `stn-ingress`, and requires high-confidence idle state from the matching Observer build.
