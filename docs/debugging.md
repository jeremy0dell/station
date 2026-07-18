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

The Observer process-identity file follows the resolved socket rather than the
state directory. Its path is always `<resolved socketPath>.pid`, including XDG
and explicit-socket layouts where the socket directory is outside the configured
state directory. Including the socket filename keeps identities distinct when
multiple configured sockets share one directory.

The startup claim is `dirname(resolvedSocket)/observer.claim.sqlite`. It is a
persistent private SQLite file whose active `BEGIN IMMEDIATE` transaction, not
its existence, identifies a boot owner. Do not delete, rename, replace, or
"stale reclaim" it. A process exit releases the OS lock, and the next start
reuses the same inode. The socket directory is mode `0700`; the claim and any
`-journal`, `-wal`, or `-shm` sidecars are regular non-symlink files at mode
`0600`. When XDG or an explicit socket moves this file outside `state_dir`, use
the resolved health `socketPath` to locate it.

Important files and directories:

```text
observer.sqlite
logs/observer-boot.log
logs/observer.jsonl
logs/hooks.jsonl
logs/cli.jsonl
logs/tui.jsonl
diagnostics/*/diagnostic-index.json
diagnostics/*/commands.jsonl
diagnostics/*/errors.jsonl
diagnostics/*/logs/observer.jsonl
diagnostics/panes/
spool/hooks/
```

`observer.sock.pid` is mode `0600` for the default socket and contains exactly:

```json
{
  "pid": 12345,
  "osStartTime": "Sat Jul 11 10:42:03 2026",
  "version": "0.7.0+station.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "socketPath": "/resolved/socket/directory/observer.sock"
}
```

Use this file only to corroborate the identity of the process associated with
the socket. `lsof -t <resolved-socket-path>` remains the primary process-
ownership evidence, and a connect or health probe establishes liveness. A
crash or cleanup failure can leave a stale identity file, so do not signal a
process or unlink a socket from this file alone. Clean shutdown removes the
file only when the Observer still owns the socket and every identity field
matches its published value.

The pidfile and health response use the exact Observer selector shown above;
`stn --version` and `StationSnapshot.observer.version` remain the display
version (`0.7.0` in this example).

`OBSERVER_HANDOFF_REFUSED` means automatic build or cross-version replacement
could not proceed safely. Read the running/requested display versions and build
IDs in the error. A same-version legacy or losing identified build with stable
PID/start-time health can be stopped explicitly; missing process identity
refuses rather than risking a successor. It must not attach to different code.
Inspect `logs/observer-boot.log`, compare `lsof -t <socket>` with the
strict pidfile and `ps -ww -p <pid> -o lstart=,command=`, then retry only after
resolving missing or conflicting evidence. Automatic handoff never uses
SIGKILL; `stn observer reap --force` remains the explicit operator path for
confirmed duplicates, not a generic response to a live wedged owner.

`OBSERVER_BUILD_MISMATCH` means a client outlived the exact Observer selector
it accepted at launch. The failed operation was not sent to the replacement.
Close and relaunch that client, or use an isolated socket/state directory; do
not retry the stale process in a loop.

A missing, invalid, or checkout/output-mismatched `station-build-id` stops a
source client before it can claim compatibility. Run `pnpm build`, then relaunch
the client; a scoped `tsc` output is not an identified whole-repository build.

## Reading Evidence

- `logs/observer-boot.log` is the raw, local-only record of the latest observer startup attempt. Each attempt atomically replaces it at mode `0600` with a JSON-encoded command header followed by that child's stdout/stderr. It sits outside structured `stn debug logs`; an `OBSERVER_EXITED_ON_START` error includes the latest path and, when available, a redacted final 15-line tail captured from its own failed child.
- `observer.claim.sqlite` is boot-exclusion evidence only. Inspect it with
  read-only SQLite tooling after confirming no startup is in progress; never
  infer ownership from the file or sidecars being present.
- `diagnostic-index.json` is the fastest summary for root-cause codes and correlated evidence.
- `commands.jsonl` is the command lifecycle record. Failed commands can include redacted provider command diagnostics when an error envelope was persisted for the command.
- `errors.jsonl` carries safe error envelopes, diagnostic IDs, trace IDs, provider context, and redacted diagnostic details when available.
- `logs/observer.jsonl` and `logs/hooks.jsonl` explain runtime events around reconcile, command execution, hook delivery, projection, spool fallback, and provider health.
- `logs/tui.jsonl` carries pane corruption telemetry from the native workspace: `Terminal corruption signal.` lines with `kind` (`unhandled_sequence`, `replacement_char`, `escape_fragment`, `geometry_divergence`, `overflow_clip`, `terminal_diagnostic`, `parse_error`), the pane, and a rate-limited count. `escape_fragment` is a heuristic — a pane that prints ANSI codes as text trips it.
- `diagnostics/panes/` holds pane evidence dumps written when a detector trips: the visible grid plus the raw byte tail that produced it. Feed `rawTail` back through `createStationVtScreen` to replay the corruption offline.
- SQLite is observer-owned runtime history; inspect through existing debug/diagnostic surfaces unless a task explicitly needs database-level investigation.
- Logs and bundles are diagnostic evidence only. Reconcile from config/providers/current observer state before treating old evidence as current truth.
- Provider hook logs are delivery/setup evidence, not runtime truth. Use observer health, reconcile output, and snapshots to verify the current graph.

## Station Runtime

Station (the OpenTUI terminal workspace under `station/`) adds a second runtime process beside the observer: the `station-station-host` daemon, which owns PTYs that outlive the UI so panes can warm-reattach across a UI restart.

When Station "does nothing" or panes read "exited", check the process topology before the code:

- Exactly one Station UI should be running. Two `bun --hot src/main.tsx` instances on one TTY fight over the screen and mouse. `pgrep -f src/main.tsx` should return a single process.
- The host the UI dials must match both its host protocol and exact Station build. `host.start` in `station-host.jsonl` records both versions. `HOST_UPGRADE_BLOCKED` means a different build owns live PTYs; `HOST_VERSION_INCOMPATIBLE` means the running host is legacy or speaks another protocol. Both are deliberate preservation failures, not stale-socket evidence.
- The host socket defaults to `<state_dir>/run/station-host.sock` (beside `observer.sock`); override with `STATION_HOST_SOCKET_PATH`. Inspect live PTYs with `bun run host:list` in `station/`.
- Never kill a version-mismatched host or remove its socket until a matching build proves that its PTY list is empty. Reopen with the build named by the error to finish or explicitly close live terminals, then retry; current-protocol idle hosts replace themselves automatically. A legacy or different-protocol host requires an explicit stop only after its sessions are accounted for.

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

## Harness Event Census

The contract these events implement is `docs/harness-signals.md`; the integration workflow is `docs/harness-authoring.md`. Attention states (`needs_attention` plus the typed `attention` kind on the agent status: `question`, `plan_approval`, `tool_approval`, `input`) are normalized at each provider boundary. When a harness behavior is unclear — or a new harness/scenario needs mapping — capture what actually happens instead of reasoning from source:

1. Every ingested report is logged as `Harness event report processed.` (or `skipped.`) in `logs/observer.jsonl` with provider, eventType, status value, attention kind, correlation keys, optional `correlationIssue`, and the projection outcome. `station_identity_cwd_mismatch` means the provider retained native identity and cwd but withheld inherited Station correlation because cwd could not belong to the stamped worktree, including a nested managed-worktree boundary. An ordinary active-owner rejection instead has no `correlationIssue`; it retains Station session/native correlation and reports `projected: false` while the durable owner remains unchanged. Other accepted reports with `projected: false` are correlation failures and change no projected state.
2. Drive one scenario at a time in the harness TUI and watch `stn debug logs "Harness event report"` (or `stn observe --json`) alongside the harness's own native session log (for Codex: the `rollout-*.jsonl` under `$CODEX_HOME/sessions/<y>/<m>/<d>/`).
3. Scenario matrix worth capturing per harness: clarifying question during planning, plan approval ("run this plan?"), standalone question, tool/permission approval, user answers, user aborts the prompt, turn completes, compaction.

Captured sequences make good fixtures: the status mappers (`statusFrom*Event` in each `integrations/harness/*/src`) are pure, so a captured event list replays in a unit test and the expected status/attention can be asserted per event — no live timing or reconcile-cycle waiting.

## Detailed References

- Use `docs/diagnostics.md` for full doctor, debug bundle, redaction, retention, hook setup, and injected-failure details.
- Use `docs/system-dependencies.md` for setup, provider tools, and system dependency checks.
