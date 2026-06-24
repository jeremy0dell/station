# Test Layout

Tests live in predictable locations, and standard CI includes only deterministic
lanes that do not require real providers, local terminal state, credentials, or
network beyond dependency installation.

- Workspace-local unit and integration tests live under `apps/*/test`, `packages/*/test`, or `integrations/*/*/test`.
- Cross-system tests live under top-level `tests/`.
- `tests/support/` is reserved for fake providers, fake external tools, temp projects, assertions, databases, and sockets.
- `tests/diagnostics/injected-failures/` contains deterministic diagnostic bundle and evidence-index coverage for common local failures.
- `tests/agent/scripted/` contains deterministic scripted-agent tests that can run in standard CI.
- `tests/agent/scenarios/diagnosis/` contains deterministic diagnostic-oracle fixtures for agent-style bundle classification.
- Real-agent tests are reserved for `tests/agent/real/` and are opt-in only.
- `tests/e2e/release-hardening-smoke.test.ts` covers the deterministic `pnpm smoke:release` path with fake Worktrunk state and scripted smoke disabled for focused e2e speed.
- `tests/support/fake-agent/` contains helpers for launching deterministic scripted harness plans in CI.
- `tests/e2e/worktrunk-real.test.ts` is an opt-in real Worktrunk lane. Run it only with `STATION_REAL_WORKTRUNK=1` and an installed `wt` binary, optionally setting `STATION_WORKTRUNK_BIN=/path/to/wt`. It is intentionally not part of `test:all`.
- `integrations/terminal/tmux/test/integration/popup-real.test.ts` is an opt-in real tmux lane. Run it only with `STATION_REAL_TMUX=1` and an installed `tmux`, optionally setting `STATION_TMUX_BIN=/path/to/tmux`. It uses an isolated tmux server label and does not touch the normal station workbench.
- `tests/agent/real/claude/` is an opt-in real Claude lane. Run it only with `STATION_REAL_CLAUDE=1`, a logged-in `claude`, and installed `tmux`, optionally setting `STATION_CLAUDE_BIN=/path/to/claude` and `STATION_TMUX_BIN=/path/to/tmux`. It is intentionally not part of `test:all`.
- `tests/agent/real/codex/` is an opt-in real Codex lane. Run it only with `STATION_REAL_CODEX=1`, `codex login status` passing, and installed `tmux`, optionally setting `STATION_CODEX_BIN=/path/to/codex` and `STATION_TMUX_BIN=/path/to/tmux`. It is intentionally not part of `test:all`.
- `tests/agent/real/cursor/` is an opt-in real Cursor lane. Run it only with `STATION_REAL_CURSOR=1`, `agent --version` passing, and installed `tmux`, optionally setting `STATION_CURSOR_AGENT_BIN=/path/to/agent` and `STATION_TMUX_BIN=/path/to/tmux`. It is intentionally not part of `test:all`.
- `tests/e2e/real/` is the product real E2E lane. Run it only with `STATION_REAL_E2E=1`, `STATION_REAL_WORKTRUNK=1`, `STATION_REAL_CODEX=1`, real `wt`, real `tmux`, real `codex`, and a built `bin/stn`. Use `pnpm test:e2e:real`, `pnpm test:e2e:real:local`, or focused scripts such as `pnpm test:e2e:real:codex-hooks`. It creates real Worktrunk/tmux/Codex sessions, opens the TUI in a real tmux popup for popup-navigation coverage, and includes a temp project-local Codex hook that calls `stn-ingress codex`. It is intentionally excluded from `test:e2e` and `test:all`.

No random floating tests should be added outside these directories.
