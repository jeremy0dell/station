# Debugging

Status: current living entrypoint for runtime trace and diagnostic work.

## First Move

For runtime trace IDs, command IDs, diagnostic IDs, or production symptoms, start from the debugging and observability surfaces before reading source code. Runtime evidence lives under the configured observer state directory; source search is the follow-up once the evidence identifies a code path, provider boundary, or missing instrumentation.

Use:

```bash
stn debug trace <id>
stn debug trace --latest-failure
stn debug logs [query]
```

If a redacted bundle is needed, use:

```bash
stn debug bundle --trace <traceId>
stn debug bundle --command <commandId>
stn debug bundle --latest-failure
```

## Tool Selector

Use the narrowest tool that can answer the question:

| Need | Command |
| --- | --- |
| Known trace, command, or diagnostic id | `stn debug trace <id>` |
| No id yet, historical/local symptom | `stn debug logs [query]` |
| Latest known failure | `stn debug trace --latest-failure` |
| Process status only | `stn observer status` |
| Current runtime health | `stn doctor` |
| Current normalized graph | `stn snapshot --json` |
| Current normalized graph with debug fields | `stn snapshot --json --include-debug` |
| Live event stream for agents | `stn observe --json --include-snapshot --duration 3s` |
| Live event stream for humans | `stn observe --include-snapshot --duration 3s` or `stn observe --pane` |
| One command lifecycle record | `stn command get <commandId>` |
| Failed provider command details | `stn debug trace <traceOrCommandId>` or `stn command get <commandId>` |
| Redacted shareable evidence | `stn debug bundle --trace <traceId>` / `--command <commandId>` / `--latest-failure` |
| Provider hook setup | `stn hooks doctor <target>` for worktrunk, claude, codex, cursor, or opencode |
| Observer event hook setup | `stn event-hooks doctor` |
| Setup and tool readiness | `stn setup check --json`, `stn setup system --check`, or `pnpm setup:system:check` |

Use `stn debug logs [query]` for bounded historical log inspection when there is no
trace, command, or diagnostic ID yet. It reads structured JSONL logs from the
configured state directory without contacting the observer. By default it searches
`observer`, `cli`, and `tui` logs, excludes noisy hook logs, returns recent
`warn`/`error` records when no query is supplied, and searches all levels when a
query is supplied. Opt into hook logs explicitly:

```bash
stn debug logs protocol
stn debug logs --min-level error --limit 20
stn debug logs timeout --component hook
```

Use current-truth tools only when the task permits live observer interaction.
`doctor`, `snapshot`, `observe`, `command get`, `reconcile`, and `debug bundle`
all contact the observer or start it when needed. `debug bundle` also writes a
new redacted bundle. `reconcile`, `command dispatch`, `project add/remove`,
hook install/uninstall, and setup apply commands intentionally mutate runtime,
config, hooks, or local machine state.

## Provider Command Failures

When a provider command fails, use the correlation ids before inspecting the
provider implementation:

```bash
stn debug trace <traceOrCommandId>
stn command get <commandId>
```

`stn debug trace` searches existing bundles and structured logs. When a command
error envelope includes diagnostics, the trace summary can include redacted
external-command details: command, cwd, exit code, duration, and bounded
stdout/stderr snippets. It also derives `rootCauseCodes` from command records,
error envelopes, diagnostic indexes, and matching log errors.

`stn command get <commandId>` asks the live observer for the command lifecycle
record. Failed provider commands may include the same redacted diagnostics when
the observer persisted a richer error envelope for the command. Command events
and SafeError responses intentionally remain lean; use command/debug surfaces
for the deeper provider details.

For Worktrunk lifecycle failures, check setup and doctor output before assuming
the observer is wrong:

```bash
stn setup check --json
stn doctor
```

`worktree.worktrunk.use_lifecycle_hooks = false` means automated Worktrunk
mutations pass `--no-hooks`; `true` means they pass `--yes`; unset means STATION
uses Worktrunk's default prompt behavior. Setup and doctor checks should report
the effective automation mode and whether the installed `wt` supports the flag
required by that mode.

## No-Action Mode

If the user says "no action", keep debugging read-only.

Do not start or restart the observer, retry commands, kill processes, mutate state, or write a new bundle unless explicitly asked.

In no-action mode, inspect existing state only:

- `stn debug trace <id>` or `stn debug trace --latest-failure`
- `stn debug logs [query]`
- existing bundles under `diagnostics/`
- existing logs under `logs/`
- existing bundle `commands.jsonl`, `errors.jsonl`, and derived indexes

Avoid live observer commands in no-action mode, including `doctor`, `snapshot`,
`observe`, `command get`, `command dispatch`, `reconcile`, `debug bundle`,
`project add/remove`, hook install/uninstall, setup apply, and observer
start/stop/restart/run. `stn observer status` is non-mutating, but it is still a
live status check rather than an existing-state log read; use it only when live
status is allowed by the request.

## State Directory

The default observer state directory is:

```text
~/.local/state/station
```

It can be changed through config or observer startup options. The resolver also uses `$XDG_RUNTIME_DIR/station/observer.sock` for the socket when that environment variable is present.

Important files and directories:

```text
observer.sqlite
logs/observer.jsonl
logs/hooks.jsonl
logs/cli.jsonl
logs/tui.jsonl
diagnostics/*/diagnostic-index.json
diagnostics/*/commands.jsonl
diagnostics/*/errors.jsonl
diagnostics/*/logs/observer.jsonl
spool/hooks/
```

## Reading Evidence

- `diagnostic-index.json` is the fastest summary for root-cause codes and correlated evidence.
- `commands.jsonl` is the command lifecycle record. Failed commands can include redacted provider command diagnostics when an error envelope was persisted for the command.
- `errors.jsonl` carries safe error envelopes, diagnostic IDs, trace IDs, provider context, and redacted diagnostic details when available.
- `logs/observer.jsonl` and `logs/hooks.jsonl` explain runtime events around reconcile, command execution, hook delivery, projection, spool fallback, and provider health.
- SQLite is observer-owned runtime history; inspect through existing debug/diagnostic surfaces unless a task explicitly needs database-level investigation.
- Logs and bundles are diagnostic evidence only. Reconcile from config/providers/current observer state before treating old evidence as current truth.
- Provider hook logs are delivery/setup evidence, not runtime truth. Use observer health, reconcile output, and snapshots to verify the current graph.

## Station Runtime

Station (the OpenTUI terminal workspace under `station/`) adds a second runtime process beside the observer: the `station-station-host` daemon, which owns PTYs that outlive the UI so panes can warm-reattach across a UI restart.

When Station "does nothing" or panes read "exited", check the process topology before the code:

- Exactly one Station UI should be running. Two `bun --hot src/main.tsx` instances on one TTY fight over the screen and mouse. `pgrep -f src/main.tsx` should return a single process.
- The host the UI dials must match the UI build. A stale or version-mismatched host at the socket rejects requests, so host-backed aux shells (splits / `+sh`) fail and the pane reads "exited". Look for `host.error` / `HOST_REQUEST_FAILED` in `station-host.jsonl` at the moment a split was attempted.
- The host socket defaults to `<state_dir>/run/station-host.sock` (beside `observer.sock`); override with `STATION_HOST_SOCKET_PATH`. Inspect live PTYs with `bun run host:list` in `station/`.
- Recovery is to bring up one coherent stack: stop all `src/main.tsx` and `hostMain.ts` processes, remove the stale socket, then start a single UI + host from an up-to-date checkout.

Other Station diagnostics:

- A pane reading "terminal exited 1" on every local shell is the node-pty `spawn-helper` exec-bit issue; see `docs/known-issues.md`.
- `stn doctor` includes a session/terminal check that reports a per-provider session breakdown (e.g. `station: 7 open · tmux: 4 detached`) and flags detached, stale, or orphaned sessions — useful when a row cannot be focused from Station.
- Station persists its pane layout to `<state_dir>/station/layout.json` (override `STATION_LAYOUT_PATH`); a malformed or absent snapshot falls back to a single fresh shell.

Station runtime files (alongside the observer state directory):

```text
run/station-host.sock
logs/station-host.jsonl
station/layout.json
```

## Detailed References

- Use `docs/diagnostics.md` for full doctor, debug bundle, redaction, retention, hook setup, and injected-failure details.
- Use `docs/system-dependencies.md` for setup, provider tools, and system dependency checks.
