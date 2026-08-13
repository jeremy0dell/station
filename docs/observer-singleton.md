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

## Attach versus coordinated handoff

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

A winning replacement candidate may coordinate handoff only while holding the boot claim.
It revalidates holder, health, pidfile, argv, socket, and OS start token before controlled
stop and before the one permitted SIGTERM. The controlled health-plus-stop exchange uses one
connection, binding authorization to the revalidated incumbent. A stop receipt is acceptance,
not exit proof: successor bind requires both socket closure and exact incumbent death.

Automatic handoff never sends SIGKILL. A missing identity, changed owner, inaccessible
socket, wedged process, or exhausted deadline returns `OBSERVER_HANDOFF_REFUSED` and preserves
the incumbent evidence.

## Bind, readiness, and claim release

For an absent or proven-stale socket, the claim-holding child binds through the claimed
stale-reclaim path. Immediately before its only unlink attempt, it repeats zero-holder and
path-identity checks. After bind it:

1. captures socket inode and birth identity;
2. publishes and fsyncs the strict pidfile;
3. seeds the ownership watcher with the captured socket identity;
4. commits the startup gate;
5. synchronously rolls back and closes the boot claim;
6. enables health waiters;
7. runs startup reconcile outside the claim.

Publication, OS-start-token, bind, or pre-ready lifecycle failure keeps health closed and
retains the claim through socket and pidfile cleanup. A stop requested before readiness is
terminal.

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
- startup claim contention refuses explicit reap without waiting;
- automatic handoff never sends SIGKILL; only explicit force may escalate after revalidation;
- an inaccessible socket is preserved for operator diagnosis.

The actionable operator surfaces are `stn doctor`, `stn observer status`,
`stn observer reap`, existing structured logs, and redacted debug bundles.

## Non-goals

- No fd passing or `SCM_RIGHTS`; Station Host owns persistent PTYs separately.
- No launchd or systemd supervisor requirement.
- No Windows named-pipe singleton path; Observer transport is AF_UNIX.
- No thin proxy that lets an older or different build execute through incompatible code.
- No periodic duplicate killer.
- No automatic duplicate-process signal.
- No telemetry requirement for singleton inspection evidence.

## Verification

The permanent verification surface includes:

- pure duplicate-selection decision tests for keeper, candidate, FD, and ambiguity rules;
- process-evidence tests for strict `ps` and `lsof` parsing and unavailable evidence;
- boot-claim tests for immediate contention, callback release, and failure cleanup;
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
