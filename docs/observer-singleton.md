# Observer singleton lifecycle

This document is authoritative for Observer process ownership, startup exclusion,
build-aware handoff, socket displacement, duplicate discovery, and explicit reap.
[Observer Architecture](observer-architecture.md) remains authoritative for dependency
direction, application roles, and composition ownership.

## Singleton invariant and resolved-socket identity

Station permits one healthy Observer for each resolved Unix socket. The resolved socket,
not the state directory, claim path, config path, checkout, or build, is the singleton
identity.

Socket resolution follows the effective Observer process arguments and config:

1. explicit `--socket`;
2. configured `observer.socket_path`;
3. `$XDG_RUNTIME_DIR/station/observer.sock` when XDG runtime state is available;
4. `<state_dir>/run/observer.sock`.

Different sockets may run different Observers, even when they share a state directory.
Different sockets in one directory share the boot-claim database and therefore serialize
startup, but each retains its own listener and `<socketPath>.pid` process identity.

A connect succeeds only against a listener. `lsof` holder evidence is the primary local
process attribution. A pidfile corroborates identity but never proves liveness or authorizes
unlink, stop, or signal by itself.

## Startup claim and four-state socket probing

The Observer child, never an attaching client, owns startup mutation. Before provider
construction or the main Observer database opens, it acquires `BEGIN IMMEDIATE` on
`dirname(resolvedSocket)/observer.claim.sqlite` with the caller's bounded startup budget.
The active SQLite transaction is the exclusion authority; the persistent database and its
sidecars are never stale locks and must not be deleted or replaced.
On first use, Station initializes a private temporary database and publishes it with a
no-replace hard link, so contenders never open a shared empty SQLite file. File checks use
non-opening metadata reads before and after `BEGIN IMMEDIATE`; reopening and closing that inode
would release a process-scoped POSIX lock.

While holding the claim, startup classifies the socket as exactly one of:

- `absent`: no socket path exists;
- `listening`: a connection reaches a listener;
- `stale`: connection refusal, or Bun's existing-path `ENOENT`, plus strict zero-holder
  evidence;
- `inaccessible`: permissions, timeout, live or unavailable holder evidence, path
  replacement, or a non-socket collision prevents a safe conclusion.

Only `absent` and proven `stale` permit bind or stale reclaim. `listening` enters attach or
coordinated handoff. `inaccessible`, claim contention, and claim I/O failure stop startup
before providers, main SQLite, bind, pidfile publication, stop, unlink, or signal.

## Process and immutable-build identity

The successful binder publishes `<resolved socketPath>.pid` atomically at mode `0600` with
strict `{pid, osStartTime, processToken, version, socketPath}` content. `processToken` is a
per-launch UUID v4, while `version` is the Observer selector: display SemVer plus reserved
`station.<sha256>` build metadata.

Process attribution requires agreement among:

- the sole `lsof` socket holder;
- health PID, OS start token, selector, and socket when health is part of the operation;
- the strict pidfile;
- the exact source or compiled Observer argv shape, launch token, build selector, and resolved
  socket;
- the OS-reported executable image (Linux `/proc`; macOS `lsof` text-image device/inode);
- a fresh OS process-start token.

`ps lstart` has only one-second resolution on the supported macOS and Linux paths, so it is
corroborating evidence and never authorizes a signal alone. Exact argv plus the per-launch token
prevents an ordinary same-second PID replacement from inheriting authority. Missing, malformed,
stale, or conflicting evidence refuses ownership mutation. Clean shutdown removes a pidfile only
when all fields still match the process's published identity.

## Bounded stale-evidence repair

Start, stop, and restart converge when an absent or proven-stale socket has no verified
incumbent. They serialize repair with the same boot claim used by startup and explicit reap.
`status`, Doctor, snapshots, and debug evidence stay read-only. Repair receives no signal
capability and never unlinks a socket; only the successful binder may reclaim a proven-stale
socket after its existing fresh path and zero-holder checks.

The claim-holding repair applies this decision table:

| Socket admission | Strict pidfile and process evidence | Outcome |
| --- | --- | --- |
| absent or same stale inode/birth identity | pidfile absent on two reads | idempotent clean result |
| absent or same stale identity | PID positively absent | atomically remove the exact pidfile with reason `process-missing` |
| absent or same stale identity | OS start token, executable/argv, process token, build selector, or socket argv differs | atomically remove the exact pidfile with the typed drift reason |
| absent or same stale identity | installed path replaced after the admitted process launched | typed uncertainty refusal; preserve pidfile evidence |
| absent or same stale identity | exact live Observer generation | typed `OBSERVER_STALE_EVIDENCE_UNCERTAIN` refusal; preserve evidence |
| absent or same stale identity | malformed, insecure, inaccessible, timed-out, or otherwise uncertain evidence | typed fail-closed refusal; preserve evidence |
| listening, inaccessible, or changed socket/pidfile owner | any | typed refusal; preserve the current owner's evidence |

One shared read-only verifier owns exact Observer identity comparison for handoff, repair,
and equivalent reap checks. Repair reads and classifies the original pidfile generation,
then repeats strict pidfile, process, and socket checks immediately before its commit. The
commit reuses the existing atomic rename, strict parse, exact compare, delete-or-restore
mechanics. A failed compare retries at most once while retaining the original generation as
the admission baseline; it never adopts or deletes a successor's evidence. Cancellation or
deadline exhaustion before commit refuses. Once the atomic filesystem operation begins it
settles to delete the admitted exact value or restore what it claimed. Repeating repair after
a successful removal returns the same clean state.

Cooperative read-only inspection may retain `installed-path-replaced` provenance as evidence,
but it grants no handoff, repair, reap, or signal authority.

An idempotent `stn observer stop` returns `stopped: false` plus strict `evidenceRepair`
summary when no incumbent exists. Startup and restart carry a repair refusal through the
private startup report as the separate typed lifecycle `cause`. No repair result is persisted,
so this contract requires no Observer database migration.

## Attach versus coordinated handoff

Handoff reads process evidence only for the incumbent PID named by the corroborated socket and
pidfile identity. Unrelated Observer-looking processes cannot participate in that decision;
duplicate discovery remains global and fail-closed.

A listening exact-selector Observer is reused. A higher valid SemVer incumbent is also
reused by a lower candidate. The declared public version-line reset orders
`0.0.0-pre-alpha.*` after the internal `0.7.1-rc.*` previews despite ordinary SemVer
precedence. At one display version, immutable build identity provides a deterministic
winner; a losing or legacy same-version candidate refuses rather than silently delegating
to different code.

Station UI composition applies a stricter exact caller/accepted-selector admission check
after this singleton decision. That UI-only check is not another ordering, attachment, or
handoff rule; non-UI commands, hooks, ingress, and generic clients continue to use the
winner selected here.

An explicit `stn observer ensure-exact-build` request is a separate CLI lifecycle
operation for a caller that intentionally owns the configured runtime, such as a
checkout-local devbox. Before its first await, the CLI strictly parses and clones
one current-only `start-if-absent` or `restart-exact` command. Start authority
contains a proved-absent expectation and mutation requires a fresh absence read;
if a target appears during admission, only a separate independent final exact
inspection may accept it without mutation. Standalone invocation may immediately
reuse an initially complete exact target inspection, but health alone is never
reuse, stop, or replacement authority.

Restart authority contains the complete expected generation from exact
inspection: health status, PID, start time, selector, and socket; strict pidfile;
exact cooperative argv, executable path and provenance, OS start token, launch
token, selector, socket, and startup timeout; recovery assessment; and canonical
selected session handles. The restart re-inspects that generation on one pinned
physical NDJSON connection using only existing `observer.health`,
`session.recoveryAssessment`, and `observer.stop` messages. Health, recovery,
fresh health, one stop request, a `stopped: true` receipt, and peer EOF occur on
that connection with no schema negotiation or reconnect. Complete generation and
selected-handle equality is rechecked immediately before the sole cooperative
stop. Evidence drift, PID reuse, handle substitution, connection uncertainty, or
a later non-target owner refuses without stopping or replacing that owner.
Installed-path replacement authorizes only this identity-pinned cooperative
path.

One absolute deadline shrinks across inspection and OS evidence, the pinned
session, stop receipt and endpoint closure, preserve-incumbent child startup,
child health, and verification. The replacement child may accept an exact
successor or claim an absent/proven-stale endpoint, but cannot invoke ordinary
automatic handoff against a later non-exact owner. After any known or uncertain
stop/start mutation, a fresh independent exact inspection must prove the final
target generation; the admitted generation cannot count as success, and a
later non-target winner is preserved. Results retain stable activation phase,
last proven incumbent disposition, and typed cause. The operation has no retry
loop, signal, reap, repair, forced cleanup, Host, update, new wire method, or
compatibility authority.
The existing public `observer status`, `observer ensure-exact-build`,
`observer restart`, and `observer stop` JSON and exit-code surfaces remain
unchanged; generic start, automatic handoff, and deterministic winner ordering
also retain their existing behavior.

A winning replacement candidate may coordinate handoff only while holding the boot claim.
After first corroborating holder, health, pidfile, argv, socket, and OS start token, it constructs
its provider registry and completes configured provider-owned hook reconciliation within the
remaining startup deadline. Failure, cancellation, ownership conflict, or an unverified repair
ends candidate startup before stop or signal, preserving the incumbent. A successful preparation
is memoized for the successor runtime; it is not a second hook writer.

After preparation, handoff freshly revalidates the exact incumbent before controlled stop and
before the one permitted SIGTERM. Immediately before stop, the successor synchronously refuses
any pending startup cancellation and commits to replacement. A signal that wins before this commit
preserves the incumbent. A later signal is remembered but cannot strand an empty singleton between
incumbent stop and successor cleanup ownership; it is delivered to normal shutdown as soon as the
successor owns that cleanup. The controlled health-plus-stop exchange uses one connection, binding
authorization to the revalidated incumbent. A stop receipt is acceptance, not exit proof: successor
bind requires both socket closure and exact incumbent death.

Automatic handoff never sends SIGKILL. A missing identity, changed owner, inaccessible
socket, wedged process, or exhausted deadline returns `OBSERVER_HANDOFF_REFUSED` and preserves
the incumbent evidence.

## Bind, readiness, and claim release

For an absent or proven-stale socket, the claim-holding child completes the same bounded
provider-owned hook preparation before opening its main database or binding. It then binds through
the claimed stale-reclaim path. Immediately before its only unlink attempt, it repeats zero-holder
and path-identity checks. After bind it:

1. captures socket inode and birth identity;
2. publishes and fsyncs the strict pidfile;
3. seeds the ownership watcher with the captured socket identity;
4. runs the first provider-backed core reconcile while operations and health remain gated;
5. commits readiness while still holding the boot claim;
6. synchronously rolls back and closes the boot claim;
7. enables health waiters.

Provider preparation, publication, OS-start-token, bind, initial reconcile, or other pre-ready
lifecycle failure keeps health closed and retains the claim through socket and pidfile cleanup. A
stop requested before readiness is terminal. SIGINT and SIGTERM cancellation is installed before
provider preparation; it prevents pre-commit hook mutation, preserves an incumbent before the
replacement commit, and is handed to normal owned shutdown once runtime cleanup authority exists.

The spawning CLI gives the child one private inherited pipe for startup outcome reporting.
Before readiness, the child may write one strict, redacted, versioned failure report and then
close the pipe; readiness closes it without a report. The parent preserves the lifecycle
classification separately from the report's typed causal error and bounded boot-log evidence.
The channel is diagnostic transport only: malformed, missing, or oversized reports authorize
no retry, repair, unlink, stop, or signal. In particular, an exact executable/argv mismatch is
reported as `OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH` while the existing fail-closed handoff
decision continues to preserve the incumbent.

## Ownership-loss shutdown

The ownership watcher compares the bound socket's inode and birth time with the identity
captured immediately after bind. It never adopts a later pathname as its baseline.

When ownership changes, the displaced Observer marks ownership lost and starts shutdown. It
does not remove any pidfile, does not close the native listener through the unlinking server
path, destroys accepted clients, abandons the listener, closes durable state, and exits
explicitly. The shutdown backstop prevents a handler that ignores cancellation from leaving
the displaced process active.

Future displacement is handled by this watcher; duplicate inspection is not periodic.

## Duplicate discovery

After successful startup reconcile, the healthy Observer runs the same force-false plan used
by explicit reap. The promise is cached for Doctor and its result is recorded in structured
Observer logs. This inspection has no quarantine timer, retry, boot claim, cancellation
protocol, or signal authority.

The plan marks a candidate eligible only when the keeper is the sole socket holder; its
strict pidfile, OS start token, build selector, resolved socket, and exact process entry
agree; the candidate is an exact source or compiled Observer process for the same socket;
and a complete per-process `lsof -F0pft` inventory reports zero Unix-domain socket
descriptors. Missing or conflicting evidence produces a warning and never authorizes a
signal.

The `automaticEligibility` and `quarantineMs` fields remain in `stn observer reap` output as
compatibility diagnostics describing whether the current evidence meets the conservative
checklist and how long an operator should observe a legacy candidate. Station has no
automatic duplicate signaling mode.

## Explicit operator reap

`stn observer reap` is a dry run. It reports the keeper, same-socket duplicates, automatic
eligibility at the current inspection, quarantine requirements, and refusal reasons. A dry
run sends no signal.

`stn observer reap --force` is the explicit operator escalation path. It acquires the boot
claim without waiting, then revalidates health, owner, target, executable/argv identity, and
zero-Unix-socket evidence before SIGTERM. After the bounded grace period it refreshes the same
evidence and sends SIGKILL only to an unchanged surviving duplicate. Claim contention, owner
change, PID reuse, a new socket holder, or unavailable evidence aborts further signaling.

Forced output distinguishes targets already exited, targets confirmed absent after a signal,
unchanged survivors, signal refusal, and unavailable evidence. It also records whether the
keeper process/holder identity, socket inode/birth identity, and strict pidfile survived.
`--force` is for a process the operator has independently confirmed; it is not a generic
response to inaccessible ownership or a wedged live binder.

## Shutdown ordering

Once stop begins, health is gated and application operations are rejected before API routing.
Shutdown proceeds in this order:

1. drain harness ingress and stop metadata watchers;
2. stop command admission and cooperatively abort handlers;
3. stop configured event hooks;
4. revalidate socket and pidfile ownership;
5. remove only the exact owned pidfile;
6. close the server only while the captured socket identity still matches, otherwise abandon
   it;
7. close Observer SQLite;
8. exit explicitly when displacement requires it.

Pidfile cleanup failure is warned but does not hang shutdown. Leaving stale corroborating
evidence is safer than deleting another process's identity.

## Failure/refusal rules

Station fails closed for singleton mutation:

- pidfile presence is never liveness;
- claim-file presence is never ownership;
- missing, denied, empty, malformed, truncated, or nonzero `lsof` evidence never means zero
  descriptors;
- missing `ps`, executable, exact argv, launch-token, build, pidfile, socket-identity, or
  OS-start-token evidence never means safe;
- multiple socket holders are never reap targets;
- any candidate Unix-domain socket descriptor refuses reap, including a
  descriptor for an unrelated socket;
- process, socket, holder, pidfile, or argv change before or after grace refuses further signaling;
- stale-evidence repair never signals and never treats missing or uncertain evidence as signal authority;
- startup claim contention refuses explicit reap without waiting;
- automatic handoff never sends SIGKILL; only explicit force may escalate after revalidation;
- exact-build activation uses only identity-pinned cooperative stop and preserves
  a changed or unpinnable incumbent;
- an inaccessible socket is preserved for operator diagnosis.

The actionable operator surfaces are `stn doctor`, `stn observer status`,
`stn observer reap`, typed lifecycle results, existing structured logs, and redacted debug
traces and bundles.

## Non-goals

- No fd passing or `SCM_RIGHTS`; Station Host owns persistent PTYs separately.
- No launchd or systemd supervisor requirement.
- No Windows named-pipe singleton path; Observer transport is AF_UNIX.
- No thin proxy that lets an older or different build execute through incompatible code.
- No periodic duplicate killer.
- No automatic duplicate-process signal.
- No change to verified live handoff policy or terminal update/reap execution.
- No telemetry requirement for singleton inspection evidence.

## Verification

The permanent verification surface includes:

- pure duplicate-selection decision tests for keeper, candidate, FD, and ambiguity rules;
- process-evidence tests for strict `ps` and `lsof` parsing and unavailable evidence;
- boot-claim tests for immediate contention, callback release, and failure cleanup;
- stale-evidence use-case and strict pidfile-adapter tests for every drift reason,
  unavailable evidence, cancellation, owner replacement, exact compare/remove, and restore;
- use-case tests for quarantine, final revalidation, report mode, SIGTERM-only mode,
  cancellation, and survivors;
- CLI tests preserving dry-run and manual force semantics;
- Doctor tests proving `observer-singleton` `ok` and `warn` results without product-state
  mutation;
- Observer lifecycle E2E coverage for startup races, stale reclaim, inaccessible ownership,
  handoff, displacement, and keeper preservation;
- Node/Bun cross-runtime boot-claim races and compiled-binary lifecycle smoke.

Run the focused and repository gates named in [Testing](../tests/README.md) after singleton,
claim, process-evidence, diagnostics, or binary-composition changes.
