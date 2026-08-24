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
| Machine-readable live event stream | `stn observe --json --include-snapshot --duration 3s` |
| Interactive live event stream | `stn observe --include-snapshot --duration 3s` or `stn observe --pane` |
| One command lifecycle record | `stn command get <commandId>` |
| Failed provider command details | `stn debug trace <traceOrCommandId>` or `stn command get <commandId>` |
| Redacted shareable evidence | `stn debug bundle --trace <traceId>` / `--command <commandId>` / `--latest-failure` |
| Provider hook setup | `stn hooks doctor <target>` for worktrunk, claude, codex, cursor, or opencode |
| Observer event hook setup | `stn event-hooks doctor` |
| Setup and tool readiness | `stn setup check --json`, `stn setup system --check`, or `pnpm setup:system:check` |

Use `stn debug logs [query]` for bounded historical log inspection when there is no
trace, command, or diagnostic ID yet. It reads structured JSONL logs from the
configured state directory without contacting the observer. By default it searches
`observer`, `cli`, `tui`, and `station-host` logs, excludes noisy hook logs, returns recent
`warn`/`error` records when no query is supplied, and searches all levels when a
query is supplied. Opt into hook logs explicitly:

```bash
stn debug logs protocol
stn debug logs --min-level error --limit 20
stn debug logs timeout --component hook
stn debug logs "Provider hook ignored before Observer delivery" --component hook
```

The final query finds safe local evidence for allow-listed provider hooks that
were ignored before Observer delivery because Station ownership was missing or
cwd did not match configured roots. Unsupported provider events intentionally
produce no per-occurrence log.

Each returned log record marks its `componentRole` as `logging_location`. The
component says where Station retained the record, not which subsystem owns the
failure. For a query or a single selected record, `operationalBoundaryEvidence`
groups only retained operation, command type, signal, record summary, error
code, and error message facts. `evidenceRoles` identifies that projection as
failure-and-ownership evidence while keeping the component as logging
provenance. Queried records also include bounded `matchEvidence` and scalar
`context` so a caller can cite why the record matched without treating those
facts as proof of an unrecorded mechanism.

Current-truth tools interact with the live observer. `doctor`, `snapshot`,
`observe`, `command get`, `reconcile`, and `debug bundle` all contact the
observer or start it when needed. `debug bundle` also writes a
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
external-command details: command, cwd, exit code, duration, bounded
stdout/stderr snippets, and the effective `PATH` when executable lookup fails with
`ENOENT`. The compatibility `rootCauseCodes` field retains command, envelope, index,
typed lifecycle-cause, and matching-log codes. Use `causeAssessment` for causal
interpretation: a correlated diagnostic-index root-cause declaration or a strict
lifecycle `cause` produces `explicit_root_cause`; a generic outer error code,
retained signal, or exactly matched warning/error record produces
`observed_failure` and does not establish the deeper mechanism. Trace output uses
the same `evidenceRoles` and
`operationalBoundaryEvidence` semantics as `debug logs`.

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

Hook doctor output and the `harness-tracking:*` details from
`stn setup check --json` report the requester-relative artifact owner, including
launcher and build provenance. A `different-owner` result means another
canonical Station launcher owns the shared provider artifact; `legacy-unknown`
means the existing generated artifact cannot be attributed safely. Inspect the
reported current and requested launchers before changing anything. `--yes`
confirms a normal mutation but does not transfer ownership; only run
`stn hooks install <target> --yes --takeover` when replacing that owner is
intentional. Setup apply deliberately stops on this conflict instead of choosing
an owner.

For automatic Codex hook repair, `stn hooks reconcile codex` returns the strict
provider-neutral outcome without resolved paths, scripts, raw commands, config,
or provider payloads. Use `stn hooks doctor codex` for provider-native local
detail. Automatic setup, update, Observer startup, managed launch, and resume
never transfer ownership; an ownership conflict must be resolved through the
separate explicit takeover flow.

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
the resolved health `socketPath` to locate it. Station refuses insecure existing claim
directories or files rather than changing their modes during claim acquisition.

Important files and directories:

```text
observer.sqlite
logs/observer-boot.log
logs/observer.jsonl
logs/hooks.jsonl
logs/cli.jsonl
logs/tui.jsonl
logs/station-host.jsonl
diagnostics/*/diagnostic-index.json
diagnostics/*/commands.jsonl
diagnostics/*/errors.jsonl
diagnostics/*/logs/observer.jsonl
diagnostics/panes/
spool/hooks/
run/runtime-owners/v1/
```

`run/runtime-owners/v1` contains private (`0700` directory, `0600` files) disposable-runtime records for native development HMR and the supervised setup guided E2E lane. Binary smoke uses the same relative record path beneath private checkout-and-mode-keyed state in the OS temporary directory so an ordinary next start can find a prior random smoke root. A matching next start may recover only a dead owner's exact registered process group after PID, PGID, OS start, launch-token, script, and executable evidence agree. Device-and-inode-pinned cleanup roots remain on the next record until exact deletion succeeds. A malformed, insecure, replaced, reused, or unavailable identity blocks cleanup and preserves the record for diagnosis. These records classify socket and persistence roots but never authorize signals to persistent Observer, Station Host, or Host-owned PTYs.

Use `pnpm station:runtime-inventory [-- --json]` to inspect registered disposable owners without changing them. The report distinguishes a live persistent Host/PTY cohort from a disposable launcher record, returns only keys and root classifications, and names unavailable or ambiguous evidence as a refusal. It never prints raw commands, environment, terminal contents, prompts, credentials, or absolute private paths; use its logical `logs/cli.jsonl` location with `stn debug logs "runtime." --component cli` for the correlated lifecycle evidence. For the checkout-local devbox, run `cd station && bun run station:isolated inventory`.

For terminal placement, run `stn session current` from the caller terminal and
reuse only its unexpired `source` in a raw sibling request. A detached request
has no source. If a command is rejected, inspect `stn debug trace <commandId>`
for the placement or cleanup code. Debug export redacts `authorityId` and does
not include raw caller claims or provider-private proof.

`pnpm station:runtime-prune -- --runtime <run_uuid>` is the read-only plan for one inventory record. An eligible plan prints a stable SHA-256 digest; apply only by rerunning with `--yes --expect-plan <sha256>`. Apply serializes with runtime startup, requires the same plan after acquiring the runtime-key lock, and revalidates the exact owner, group, checkout, pinned cleanup roots, registered Host sockets, and live PTYs before every signal or recursive deletion. A stale digest, active owner, PID reuse, inaccessible Host, protected PTY overlap, malformed record, or root replacement refuses cleanup and retains the record. `runtime.prune.applied` means the group and pinned binary-smoke roots were confirmed absent before record retirement; `runtime.cleanup.refused` and `runtime.cleanup.failed` retain evidence for another inspection. The command never extends `agent:cleanup`, reset, or Observer reap behavior.

`observer.sock.pid` is mode `0600` for the default socket and contains exactly:

```json
{
  "pid": 12345,
  "osStartTime": "Sat Jul 11 10:42:03 2026",
  "processToken": "00000000-0000-4000-8000-000000000001",
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

`stn observer start`, `stop`, and `restart` self-heal a strict stale pidfile only
while holding the Observer boot claim. Repair positively distinguishes a missing
process or exact identity drift, repeats pidfile/process/socket checks, and uses an
atomic compare/remove operation. It never signals and never unlinks the socket.
An idempotent stop returns `stopped: false` with `evidenceRepair.socket`,
`evidenceRepair.pidfile`, and, after removal, a non-sensitive drift `reason`.
`OBSERVER_STALE_EVIDENCE_UNCERTAIN` means ownership could not be proven stale;
`OBSERVER_STALE_EVIDENCE_OWNER_CHANGED` means evidence changed during the bounded
repair; `OBSERVER_STALE_EVIDENCE_REPAIR_FAILED` means the exact atomic pidfile
operation failed. Preserve current evidence and inspect `stn observer status`,
`lsof -t <socket>`, the strict pidfile, and `ps -ww -p <pid> -o lstart=,command=`.
Child startup surfaces these codes as the separate lifecycle `cause`, so
`stn debug trace --latest-failure` and `stn debug logs` keep the outer startup
classification distinct. Repair logs and receipts contain only socket state and
the typed drift reason; raw argv, process tokens, and collected OS errors are not
included.

`OBSERVER_SOCKET_INACCESSIBLE` means the socket exists but Station could neither
connect nor prove it stale. Preserve the socket and pidfile. Restore socket access
(normally `chmod 600 <socket>`), compare `lsof -t <socket>` with the strict
pidfile and `ps -ww -p <pid> -o lstart=,command=`, or use an isolated socket and
state directory. Do not unlink the socket or treat its pidfile as liveness proof;
`status`, `start`, `restart`, `doctor`, and provider ingress intentionally perform
no takeover while this diagnosis remains.

`ps lstart` is one-second-resolution corroboration, not an immutable process handle. Signal
authority additionally requires the exact Observer executable and canonical argv, including
the per-launch `--process-token` and exact `--build-version`, to remain unchanged. On macOS,
Station corroborates the executable path and device/inode through `lsof` text-image records;
on Linux it also reads NUL-delimited `/proc/<pid>/cmdline` and `/proc/<pid>/exe`. A missing,
denied, empty, malformed,
or nonzero `lsof` result is unavailable evidence, never proof of zero descriptors.

The pidfile and health response use the exact Observer selector shown above;
`stn --version` and `StationSnapshot.observer.version` remain the display
version (`0.7.0` in this example).

`OBSERVER_HANDOFF_REFUSED` means automatic build or cross-version replacement
could not proceed safely. Read the running/requested display versions and build
IDs in the error. When a replacement child exits, the result keeps its outer
lifecycle `error` as `OBSERVER_HANDOFF_REFUSED` once the parent has classified a
replaceable incumbent; the child report remains diagnostic and contributes only
the typed, redacted `cause` and structured `startupEvidence`. Provider ingress
rejects this outcome without creating a retry spool record. Use the outer trace ID against the same state
directory; `stn debug trace <traceId>` projects the causal code separately. A
same-version legacy or losing
identified build with stable PID/start-time health can be stopped explicitly;
missing process identity refuses rather than risking a successor. It must not
attach to different code. Compare `lsof -t <socket>` with the strict pidfile and
`ps -ww -p <pid> -o lstart=,command=`, then retry only after resolving missing
or conflicting evidence. Automatic handoff never uses SIGKILL.

Auto-starting `snapshot`, `doctor`, `command`, `reconcile`, `observe`, and
`debug bundle` boundaries preserve failures as the strict `{ error, cause?,
startupEvidence? }` lifecycle envelope instead of flattening them into prose.
Setup activation retains the same fields in its failed operation/session
outcome. The current update report uses numeric discriminator `4` with strict
`preview` and `result` shapes; older discriminator literals and report shapes
are rejected. Every `stn update --dry-run --json`, with or without
`--reap`, contains exactly one `initial` aggregate and one canonical `plan` to collect redacted
Observer, Host, terminal, retained-session, resume-capability, handle-count,
and hook-health evidence without changing runtime state. The public projection aliases
project, worktree, session, terminal-target, PTY, and PTY-instance identities within one report.
Public command, trace, and diagnostic IDs remain available for correlation, and provider IDs,
artifact revisions, and immutable build identities remain canonical.
Unknown or drifting identity remains typed in the report, including an exact
live Observer whose socket is missing and a legacy Host whose same-version
revision cannot be proved. Non-resumable dispositions are explicit. The
assessment contains no executable action or digest. A same-version
dry-run inspects current hook, Observer, Host, terminal, and recovery facts before reporting
convergence, but runs no hook, Observer, or Host mutation command. A
same-version apply resumes an interrupted crossover through the
current launcher: hook reconciliation, idempotent `observer start`, and any
preflighted Host handoff. An installed successor uses that successor launcher
for hook reconciliation before Observer restart. Hook failure prevents runtime
crossover. Recovery commands are the remaining ordered commands pinned to that
same launcher; `run-doctor` adds provider doctor before retry, and ownership
conflict exposes the explicit `hooks install <provider> --yes --takeover` choice
without granting automatic takeover authority. `stn update --json` keeps
`UPDATE_RUNTIME_CROSSOVER_FAILED` as its outer `error` and publishes the
strictly parsed successor lifecycle `cause` and `startupEvidence` separately.

`OBSERVER_EXACT_BUILD_ACTIVATION_FAILED` means an explicit configured-runtime
activation could not finish with the caller's exact immutable selector. The
result's `phase` is `inspection`, `stop`, `start`, or `verification`, and
`incumbentDisposition` reports `none`, `preserved`, `stopped`, or `unknown` for
the Observer admitted at operation start. The result's separate `cause` retains
the underlying safe code, while `startupEvidence` retains only bounded,
redacted child boot evidence when one was spawned. In a checkout devbox, exact
activation does not target the Station
Host or hosted agents and does not reset `.dev-state`. Resolve inaccessible
ownership before retrying a `preserved` result. Inspect status first for
`unknown`. For `stopped`, the isolated Observer may be down while Host-owned
PTYs remain live; rerun the same `pnpm station:devbox start` or `dev` command.
Do not use reset as routine build recovery. Exact activation never signals,
reaps, invokes devbox Host teardown, or hands off a later non-exact owner.

## Preserve Sessions Before Runtime Surgery

When an Observer or Host handoff is blocked and live agent work must survive,
make a private preservation archive before stopping, unlinking, resuming, or
replacing anything:

```bash
pnpm station:sessions:save -- --devbox
pnpm station:sessions:save -- --config ~/.config/station/config.toml
pnpm station:sessions:verify -- ~/.local/state/station-session-rescues/<timestamp>
```

The save command is read-only with respect to Station, provider sessions, and
worktrees. It captures pinned Observer health and snapshot evidence, an online
SQLite backup, recovery handles, current-build Host inventory and replay,
provider-native recovery data, and dirty or unpublished Git worktree state. It
never stops, closes, resumes, writes to, resizes, or unlinks a live runtime.
Archives contain terminal output, provider state, configuration, and untracked
files, so they are created with owner-only permissions and must be handled as
sensitive data.

A `partial` result is preservation evidence, not permission to proceed. In
particular, a build mismatch means the script deliberately skipped the
incompatible Observer snapshot or Host replay. Reopen the checkout/build named
by the health or handoff evidence and run the same command there; do not spoof
the build selector. Only consider runtime surgery after `verify` returns
`"ok": true` and every active session has provider-native recovery data.

A complete archive can drive a fail-closed migration into a separate Station
runtime. Plan first; planning verifies the archive, requires one exact recovery
handle per active session, matches the same project/worktree identities in the
target, and refuses any target worktree that already owns a session:

```bash
pnpm station:sessions:migrate -- \
  --archive ~/.local/state/station-session-rescues/<timestamp> \
  --target-config ~/.config/station/config.toml \
  --source-devbox-root ~/Developer/station
```

The plan is read-only: it uses `snapshot --require-running`, checks the exact
source Observer and Host census, requires each source row title to match its
session projection, verifies target worktree and Host identities, records the
target's current canonical title, refuses live target sessions on providers
being migrated, requires canonical-title import readiness, checks provider-file
conflicts, and prints a SHA-256 digest over that evidence. It never starts an
Observer or edits configuration. Apply must bind confirmation to that evidence:

```bash
pnpm station:sessions:migrate -- \
  --archive ~/.local/state/station-session-rescues/<timestamp> \
  --target-config ~/.config/station/config.toml \
  --source-devbox-root ~/Developer/station \
  --yes --expect-plan <digest-from-plan>
```

Apply intentionally has downtime. It closes only the planned source sessions
without force only after revalidating the source and target titles, proves the
source Host owns no live PTY, captures stable final provider state into a
hash-inventoried private directory, and stops the pinned source Observer before
atomically importing each canonical title and handle through the recorded
`session.importRecoveryHandle` command. It then resumes each target without a
post-launch rename and verifies both title projections, its exact Host PTY, and
provider-native identity. Source and target agents never run concurrently,
target TOML is never edited, target SQLite is never opened by the maintenance
script, and an entire devbox is never stopped as a side effect.

Only one apply process may own a digest at a time; a stale owner-private lock is
reclaimed only after its recorded process is gone. `SIGINT`, `SIGTERM`, and
`SIGHUP` stop the active child and write the last durable phase to `journal.jsonl`
plus `report.json`. Before source quiescence, the source
remains authoritative. An interruption during quiescence may leave only a subset
of source sessions running; rerun with the same digest so the journal closes the
remaining sessions. After `source-sealed`, source agents remain stopped and the
sealed directory is authoritative; the same retry accepts already-resumed exact
target sessions and continues from sealed evidence instead of rerunning live
source planning checks. A journal created by the former resume-then-rename flow
may issue one idempotent rename repair for an already-resumed target; new
journals import the canonical title before resume and do not use that repair.

Codex and OpenCode migration accept each provider's shared source database, an
absent target database, or a byte-identical target database. They refuse instead
of merging different nonempty provider databases. Override provider locations with
`--target-codex-home`, `--target-opencode-db`, and
`--target-claude-projects` when the target uses isolated homes.

After startup reconcile, the Observer performs one read-only duplicate
inspection. `stn doctor` reports this as `observer-singleton`: an eligible
candidate or evidence refusal is a warning, while a clear result is healthy.
The structured Observer log records candidate PIDs and refusal evidence. The
inspection has no signal or boot-claim authority.
Use `stn observer reap` to compare the current process, holder, pidfile,
socket-identity, start-token, launch-token, build, executable, argv, and complete
Unix-socket-FD evidence.

`stn observer reap --force` remains the explicit operator path for a confirmed
duplicate. It holds the boot claim, refreshes health and strict process/FD evidence,
sends SIGTERM, and may send SIGKILL after the manual grace period only after another
fresh revalidation. Station has no automatic duplicate-process signal path. Do not
use forced reap as a generic response to
an inaccessible socket or a live wedged owner.

`OBSERVER_BUILD_MISMATCH` means a client outlived the exact Observer selector
it accepted at launch. The failed operation was not sent to the replacement.
Close and relaunch that client, or use an isolated socket/state directory; do
not retry the stale process in a loop.

`TUI_OBSERVER_BUILD_MISMATCH` occurs earlier: a command-capable native or popup
Station launcher reached a healthy Observer selected by normal singleton policy,
but its complete caller selector did not exactly equal the accepted Observer
selector. No renderer, startup or popup reconcile, tmux popup, Station Host,
PTY, or layout effect should have started. Use the matching Observer build named
in the error to inspect and account for live terminals. When hosted work is
empty, stop the incumbent gracefully and retry, or select an isolated Observer
state directory. Do not spoof either selector.

This differs from `OBSERVER_HANDOFF_REFUSED`, where singleton ordering or safe
replacement could not produce an acceptable handoff, and from
`OBSERVER_BUILD_MISMATCH`, where an already-pinned client observed later
replacement. `HOST_UPGRADE_BLOCKED` is independent: Station Host protocol or
display build differs and the incumbent Host still owns live PTYs. Reopen the
matching Host build and account for those terminals before replacement.

A missing, invalid, or checkout/output-mismatched `station-build-id` stops a
source client before it can claim compatibility. Run `pnpm build`, then relaunch
the client; a scoped `tsc` output is not an identified whole-repository build.

## Reading Evidence

- `logs/observer-boot.log` is the raw, local-only record of the latest observer startup attempt. Each attempt atomically replaces it at mode `0600` with a JSON-encoded command header followed by that child's stdout/stderr. It sits outside ordinary lifecycle text. A failed start can expose its path and a redacted final 15-line, 64-KiB-bounded tail as structured `startupEvidence`; CRLF, lone CR/LF, U+2028, and U+2029 all count as line terminators. `debug logs` and `debug trace` keep that evidence separate from the outer error and typed cause, including each SafeError's `tag` and optional `hint`.
- A failed hosted binary smoke can upload `binary-smoke-evidence-<run-id>-<attempt>` for three days. Download it with `gh run download <run-id> --name binary-smoke-evidence-<run-id>-<attempt> --dir /tmp/station-binary-smoke-evidence-<run-id>`, then read `manifest.json` before the round's `failure.json`, bounded logs, and runtime summary. The bundle is redacted, allowlisted, and capped at 1 MiB, but collaborators with Actions access can download it. Do not run `stn debug trace` against unrelated live state and treat it as evidence for the downloaded CI run.
- Binary-smoke runtime ownership is recorded in `rounds/*/runtime/lifecycle.jsonl`. Read the owner registration and process-start events first, then the shutdown signal, any bounded escalation, refusal or rescue event, and `runtime.cleanup.completed` counts. The manifest's per-run ID must match the invocation that finalized it. A complete disposable cleanup has zero group members, private roots, Observer or Host sockets, Observer pidfiles, or active owner records; an incomplete or ambiguous cleanup retains the relevant root identity for the next ordinary start or manual inspection. Do not remove a retained root or signal a listed PID unless its executable, process group, start identity, and disposable role still match.
- `observer.claim.sqlite` is boot-exclusion evidence only. Inspect it with
  read-only SQLite tooling after confirming no startup is in progress; never
  infer ownership from the file or sidecars being present.
- `diagnostic-index.json` is the fastest summary for root-cause codes and correlated evidence.
- `commands.jsonl` is the command lifecycle record. Failed commands can include redacted provider command diagnostics when an error envelope was persisted for the command.
- `errors.jsonl` carries safe error envelopes, diagnostic IDs, trace IDs, provider context, and redacted diagnostic details when available.
- `logs/observer.jsonl` and `logs/hooks.jsonl` explain runtime events around reconcile, command execution, hook delivery, projection, spool fallback, and provider health.
- `logs/cli.jsonl` includes the native development owner lifecycle (`runtime.owner.registered`, process start, shutdown request, cleanup result/refusal/failure, orphan detection/recovery, retirement, and `runtime.prune.applied`). Query `stn debug logs "runtime." --component cli` and then `stn debug trace <traceId>`; records contain correlation, plan digests, and hashed roots, not argv, environment, terminal output, prompts, credentials, or arbitrary private paths.
- `logs/tui.jsonl` carries the strict native UI lifecycle (`ui.started`, ready/surface changes, shutdown intent/completion, and fatal errors) plus pane corruption telemetry. Lifecycle records contain IDs, typed surfaces/reasons, process outcomes, and source ordering only; they never contain terminal output, prompts, keys, foreground applications, process lists, environment variables, cwd, or repository paths. `Terminal corruption signal.` lines retain `kind` (`unhandled_sequence`, `replacement_char`, `escape_fragment`, `geometry_divergence`, `overflow_clip`, `terminal_diagnostic`, `parse_error`), the pane, and a rate-limited count. `escape_fragment` is a heuristic — a pane that prints ANSI codes as text trips it.
- `logs/station-host.jsonl` keeps the frozen `agent.attach`/`agent.detach` operational timeline and replay metrics alongside typed client, attachment, and PTY lifecycle records. Use typed records for `uiRunId`, connection/attachment correlation, and detach reasons; a detached attachment is not evidence that its PTY exited.
- `diagnostics/panes/` holds pane evidence dumps written when a detector trips: the visible grid plus the raw byte tail that produced it. Feed `rawTail` back through `createStationVtScreen` to replay the corruption offline.
- SQLite is observer-owned runtime history; inspect through existing debug/diagnostic surfaces unless a task explicitly needs database-level investigation.
- Logs and bundles are diagnostic evidence only. Reconcile from config/providers/current observer state before treating old evidence as current truth.
- Provider hook logs are delivery/setup evidence, not runtime truth. Use observer health, reconcile output, and snapshots to verify the current graph.

## Station Runtime

Station (the OpenTUI terminal workspace under `station/`) adds a second runtime process beside the observer: the `station-station-host` daemon, which owns PTYs that outlive the UI so panes can warm-reattach across a UI restart.

When Station "does nothing" or panes read "exited", inspect the `cli`, `tui`, and
`station-host` lifecycle logs, then check the process topology before the code:

- Native Station coordinates one UI per input TTY with an active SQLite write
  transaction and a cooperative Unix-socket endpoint under
  `/tmp/station-tui-<uid>/<tty-hash>.{sqlite,sock}`. Database-file presence is
  never evidence of ownership: process exit releases the transaction, and the
  file should not be deleted as a stale lock. Under native-HMR supervision the
  detached renderer and helper have no controlling TTY, so legacy-owner checks
  walk a bounded exact parent chain to the nearest controlling-TTY ancestor,
  corroborate `/dev/<tty>` against stdin, anchor and revalidate the `ps -t` scan,
  and refuse on missing, malformed, cyclic, or changing ancestry. A second
  current UI asks the incumbent to close and enters raw mode only after acquiring
  the transaction; Station sends no process signal.
- `TUI_TTY_LEGACY_OWNER_POSSIBLE` means same-TTY evidence may describe a
  pre-protocol Station. `TUI_TTY_TAKEOVER_REFUSED` and
  `TUI_TTY_TAKEOVER_TIMEOUT` mean a current endpoint did not cooperate or did
  not release ownership within two seconds. Use `Ctrl-Q` in the incumbent. If
  that is impossible, inspect candidates independently with
  `ps -t "$(tty | sed 's#^/dev/##')" -o pid=,command=` and only then send
  `kill -TERM <independently-verified-station-pid>` yourself.
- The host the UI dials must match both its host protocol and Station display build version. `host.start` in `station-host.jsonl` records both versions. `HOST_UPGRADE_BLOCKED` means a different display build owns live PTYs and handoff was not opted in; `HOST_VERSION_INCOMPATIBLE` means the running host is legacy, uses another display build, or speaks another protocol. `HOST_HANDOFF_INVALID_STATE` / `HOST_HANDOFF_MANIFEST_INVALID` diagnose negotiated handoff misuse or a bad manifest. `HOST_CLIENT_IDENTITY_MISMATCH` instead means one connection omitted or changed its UI correlation identity. Compatibility failures preserve the Host; correlation failures reject only the malformed client request. These are separate from Observer immutable-selector admission.
- The host socket defaults to `<state_dir>/run/station-host.sock` (beside `observer.sock`); override with `STATION_HOST_SOCKET_PATH`. Inspect with `pnpm stn host status` or `bun run host:list` in `station/`. Opt into live ownership transfer with `pnpm stn host handoff [--dry-run] [--fidelity processes|screen]` (default busy-host behavior remains refuse).
- Host reuse/replace keys on Host protocol major equality plus exact display `buildVersion` string equality (`stationBuildInfo().version`). It does **not** key on `compiled` vs source, and does **not** use Observer's content `buildIdentity`. Same display version ⇒ reuse (handoff refused as unnecessary). Different display versions + matching protocol ⇒ replace (handoff only when opted in). Protocol major skew ⇒ refuse (never handoffs). The successor process form follows whoever requests the handoff (`bun hostMain.ts` from source CLI, `<stn> __station-host` from a binary).
- `pnpm station:devbox` always launches a Bun source host (`STATION_HOST_ENTRY=hostMain.ts`) under checkout-local `.dev-state`. Do not point a binary `stn host handoff` at that socket unless you intend to flip packaging; afterward run `pnpm station:devbox stop` then `start`, or another deliberate handoff, before treating the lane as normal. `station:devbox status` warns when the listening host's build does not match this checkout's expected source CLI build.
- Orphaned PTY bridges park under `<state_dir>/run/pty-bridges/` when their host dies without an intentional stop, or when `beginHandoff` releases owner pipes without SIGTERM: `<ptyId>.sock` is the live control socket, `<ptyId>.park.json` the redaction-safe park state (ids, pid, geometry, timestamps — never PTY data), `<ptyId>.scrollback.json` a persisted replay export when one was written, and optional `<ptyId>.screen.json` a best-effort semantic snapshot for fidelity `screen`. A live socket answering `exit-status` means the agent is still parked and adoptable; a clean host startup reaps the dead ones automatically (`host.orphan-reap` in `station-host.jsonl` reports the counts). Unadopted parks self-reap at the TTL (`STATION_PTY_ORPHAN_TTL_MS`, default 24h). If `<ptyId>.park.json` exists without `<ptyId>.sock`, check for `<ptyId>.park.json.listen-error` — on macOS an overlong unix socket path (`sun_path` ≈ 104 bytes) fails listen with `EINVAL`, and `beginHandoff` refuses rather than returning an unadoptable manifest.
- Never kill a version-mismatched host or remove its socket until a matching build proves that its PTY list is empty. Reopen with the build named by the error to finish or explicitly close live terminals, then retry; current-protocol idle hosts replace themselves automatically. A legacy or different-protocol host requires an explicit stop only after its sessions are accounted for.
- Successful `agent.attach` entries in `station-host.jsonl` report `replayKind` (`raw-complete`, `semantic-truncation-recovery`, or `live-reset-recovery`), replay entry/byte counts, recorded geometry, and capture duration without terminal contents. `live-reset-recovery` means historical output could not be reconstructed exactly, so Station applied Host-captured control-only reset data, restored interaction modes and a valid active-buffer cursor anchor, nudged geometry for a child repaint, and retained live I/O. The associated `pty.snapshot.degraded` entry classifies the content-free cause as `unsupported-state`, `model-update-failed`, or `serialization-failed`; unsupported state also carries an optional stable, content-free `detail` classification. `HOST_SNAPSHOT_PENDING` is retried because later output may finish an incomplete parser sequence. `HOST_SNAPSHOT_FAILED` is no longer an expected live-reconstruction outcome; if it appears, confirm the PTY in `host:list` and treat it as a Host/client regression rather than an Observer session exit.

Other Station diagnostics:

- A pane reading "terminal exited 1" on every local shell in a source checkout can indicate the node-pty `spawn-helper` exec-bit issue; see [Limitations and workarounds](limitations.md#source-checkout-panes-exit-immediately).
- `stn doctor` includes a session/terminal check that reports a per-provider session breakdown (e.g. `station: 7 open · tmux: 4 detached`) and flags detached, stale, or orphaned sessions — useful when a row cannot be focused from Station.
- Station persists its pane layout to `<state_dir>/station/layout.json` (override `STATION_LAYOUT_PATH`); a malformed or absent snapshot falls back to a single fresh shell.

Station runtime files (alongside the observer state directory):

```text
run/station-host.sock
run/pty-bridges/<ptyId>.sock + .park.json (+ .scrollback.json)
logs/station-host.jsonl
station/layout.json
```

The per-TTY claim and endpoint live in the separate cross-config rendezvous
directory `/tmp/station-tui-<uid>/`; they are intentionally not state-directory
files. Inspect their owner, type, and mode when diagnosing
`TUI_TTY_OWNERSHIP_UNAVAILABLE`; for a supervised renderer also inspect its
bounded parent chain and controlling-TTY evidence. Do not infer a live owner
from the SQLite file or remove it.

## Harness Event Census

The contract these events implement is `docs/harness-signals.md`; the integration workflow is `docs/harness-authoring.md`. Attention states (`needs_attention` plus the typed `attention` kind on the agent status: `question`, `plan_approval`, `tool_approval`, `input`) are normalized at each provider boundary. When a harness behavior is unclear — or a new harness/scenario needs mapping — capture what actually happens instead of reasoning from source:

1. Every ingested report is logged as `Harness event report processed.` (or `skipped.`) in `logs/observer.jsonl` with provider, eventType, status value, attention kind, correlation keys, optional `correlationIssue`, and the projection outcome. `station_identity_cwd_mismatch` means the provider retained native identity and cwd but withheld inherited Station correlation because cwd could not belong to the stamped worktree, including a nested managed-worktree boundary. An ordinary active-owner rejection instead has no `correlationIssue`; it retains Station session/native correlation and reports `projected: false` while the durable owner remains unchanged. Other accepted reports with `projected: false` are correlation failures and change no projected state. The OpenCode plugin suppresses `permission.asked` events that OpenCode auto-accepts within its 300 ms confirmation window, so such asks produce no census line at all (see `docs/harness-signals.md` invariant 3).
2. Drive one scenario at a time in the harness TUI and watch `stn debug logs "Harness event report"` (or `stn observe --json`) alongside the harness's own native session log (for Codex: the `rollout-*.jsonl` under `$CODEX_HOME/sessions/<y>/<m>/<d>/`).
3. Scenario matrix worth capturing per harness: clarifying question during planning, plan approval ("run this plan?"), standalone question, tool/permission approval, user answers, user aborts the prompt, turn completes, compaction.

Captured sequences make good fixtures: the status mappers (`statusFrom*Event` in each `integrations/harness/*/src`) are pure, so a captured event list replays in a unit test and the expected status/attention can be asserted per event — no live timing or reconcile-cycle waiting.

## Detailed References

- Use `docs/diagnostics.md` for full doctor, debug bundle, redaction, retention, hook setup, and injected-failure details.
- Use `docs/system-dependencies.md` for setup, provider tools, and system dependency checks.
