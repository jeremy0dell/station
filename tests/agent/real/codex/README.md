# Real Codex Agent Lane

This lane is opt-in and is not part of `test:all`.

Run it only when the local machine has:

- `tmux`
- `codex`
- `codex login status` exiting `0`

```bash
STATION_REAL_CODEX=1 \
STATION_CODEX_BIN="$(command -v codex)" \
STATION_TMUX_BIN="$(command -v tmux)" \
pnpm test:e2e:codex:real
```

Optional:

- `STATION_REAL_CODEX_MODEL` — model to use for the real app-server plan turn. When unset, the test asks app-server for the current default model.
- `STATION_REAL_CODEX_KEEP_TEMP=1` — keep temp roots for debugging.

What it proves:

- `codex-session-create.test.ts` creates a temporary git worktree, starts a unique tmux session, launches Codex through a temporary shim that logs argv and then `exec`s the real Codex binary, reconciles observer state, and cleans up the tmux/temp state afterward. The assertion is intentionally conservative: station must observe a provider-neutral Codex harness run with `unknown` low-confidence status. The shim log proves tmux executed the Codex launch command; it does not try to prove Codex has a reliable idle/working signal.
- `codex-app-server-plan.test.ts` starts the real `codex app-server`, initializes JSON-RPC with `experimentalApi`, starts a real thread and plan-mode turn, reads the actual streamed App Server notifications, and asserts STATION maps the completed plan item to `needs_attention`. This is the real-agent proof that App Server can signal the plan-decision point without hook heuristics.
