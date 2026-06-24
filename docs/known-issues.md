# Known Issues

These are accepted limitations and testing gaps for the current local-use checkpoint.

## Product Limitations

- Real E2E remains opt-in because it requires local Worktrunk, tmux, real harness CLIs, credentials or model access, and isolated temporary projects.
- station is still a private workspace package. There is no public npm package, installer, or release artifact outside this repository.
- The scripted/fake-provider release smoke is deterministic, but it does not prove a real harness model response or real Worktrunk shell integration.
- Station does not include a row-level inspect/debug panel in v1. Use `stn doctor`, `stn snapshot --json`, and `stn debug bundle` for support evidence.
- Real provider status can be conservative. Provider hooks can promote correlated live rows to working, needs attention, or idle when supported, but terminal-only rows may remain unknown until a reliable hook or provider status signal arrives.
- Worktrunk hook installation is explicit and reversible; it is not applied by `pnpm smoke:release`.
- Cleanup and remove workflows should be tested only against disposable projects or isolated real-e2e temp state.

## Station

Station is the OpenTUI/React terminal workspace under `station/`. See `docs/local-development.md` for how to run it and `docs/debugging.md` for the runtime-topology checklist.

- A pane reading "terminal exited 1" on every local shell/split usually means the node-pty `spawn-helper` lost its execute bit (a `bun install` clears it → `posix_spawnp failed`). Station now re-asserts `+x` before every spawn, so this self-heals; if it persists, run `bun run repair:node-pty` in `station/`.
- Runtime host drift can make correct code look broken: two `bun --hot` UIs sharing one TTY fight over the screen and mouse, and a stale or version-mismatched `station-station-host` daemon at the default socket rejects requests so host-backed aux shells read "exited". Check the running process topology before iterating on code — see the Station Runtime checklist in `docs/debugging.md`.
- The welcome intro is seeded only at store creation, and `bun --hot` preserves the store across reloads, so it appears only on a true cold boot, not a hot reload. Set `welcome_on_boot = false` in `station.toml` to disable it.
- Agents whose terminal lives in a detached external session (e.g. tmux) cannot be focused from Station; clicking such a row raises a toast naming where the agent lives instead of focusing it. `stn doctor` reports a per-provider session breakdown to diagnose this.
- The hand (pointer) cursor over the floating station button can still drop on hover. The earlier width-stabilization fix addressed data-churn drops but did not fully resolve it; the documented `setCursorStyle`/`appliedPointer` desync was ruled out empirically, so the remaining cause is in hover-event delivery. Tracked for a live-repro investigation.

## UX TODOs

- Station should show an explicit refresh-in-progress state while a manual `Z` refresh is reconciling observer state, so slow refreshes do not look like dropped input.

## Diagnostics Gaps

- Diagnostic file retention is reported through `stn doctor`, but log and debug-bundle cleanup is not currently wired to the retention policy.
- A malformed JSONL log line can cause diagnostics collection to fail instead of skipping the bad record and preserving the remaining logs.
- Debug bundles write `logs/observer.jsonl`, but the manifest `sections` list does not currently name that nested log file.

## Test Coverage Gaps

- `packages/provider-hooks` has focused delivery and autostart-lock tests, but lacks direct coverage for stale socket removal, child cleanup after observer startup timeout, missing observer entry path failures, and stdin byte-limit enforcement.
- `packages/observability` has redaction and evidence-index tests, but lacks focused regression coverage for malformed JSONL log handling, retention enforcement wiring, and manifest completeness for nested bundle files.
