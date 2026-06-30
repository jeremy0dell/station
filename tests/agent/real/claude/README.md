# Real Claude Lane

Opt-in tests that exercise the real Claude Code CLI. They are skipped unless explicitly enabled and must never become required for ordinary PR or `main` CI.

## Prerequisites

- `claude` installed and logged in (`claude --version`, `claude auth status`)
- `tmux` installed (`tmux -V`)
- The repo built (`pnpm build`) — the hook capture test runs the real `bin/stn-ingress`

## Run

```sh
STATION_REAL_CLAUDE=1 pnpm test:e2e:claude:real
# or the exact nightly lane:
pnpm test:agent:nightly
```

## Nightly CI

`.github/workflows/nightly-agent-smoke.yaml` runs this lane on a schedule (and via
`workflow_dispatch`), gated to the repo owner. It installs the `claude` CLI + tmux,
builds the workspace, and authenticates non-interactively from the
`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` secrets; with neither set the run
step skips. It is deliberately a standalone scheduled workflow — never part of
PR/`main` CI — so a real-agent or upstream-CLI change cannot block a PR.

Overrides:

- `STATION_CLAUDE_BIN` — claude binary path (default `claude`)
- `STATION_TMUX_BIN` — tmux binary path (default `tmux`)
- `STATION_REAL_CLAUDE_KEEP_TEMP=1` — keep temp roots for debugging

## What it proves

- `claude-session-create.test.ts` — launch-only proof: `session.create` respawns the tmux pane running real claude in the worktree (shim log records cwd/argv) and the observer discovers a terminal-bound run. The assertion is intentionally conservative (`state: "unknown"`, `confidence: "low"`): no hook ingestion runs here, so no idle/working classification is claimed. The first interactive launch sits at the workspace trust dialog — that is expected and does not affect this test.
- `claude-hook-event-capture.test.ts` — the version-skew tripwire: real claude `-p` run with the station-generated `--settings` artifact fires hooks through the generated script and the real `bin/stn-ingress`, and the spooled `HarnessEventReport`s still parse against the package schemas with correct station correlation and no prompt text. If a claude upgrade silently breaks hook firing or payload shapes, this test catches it.
