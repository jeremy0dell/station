# Observer singleton & step-down

Status: shipped-history and remaining singleton roadmap. For the current Observer runtime
ownership and lifecycle contract, see [Observer Architecture](observer-architecture.md).

How STATION keeps exactly one observer per resolved socket, why the old design let
duplicates accumulate, what has shipped, and the remaining work. Pick up the
unfinished phases from the "Remaining work" section — each is independently
landable.

## Problem

An observer is auto-spawned by any `stn` invocation for its resolved socket. With
the default state directory and `XDG_RUNTIME_DIR` unset, that socket is
`~/.local/state/station/run/observer.sock`; worktrees using those defaults share
it. The intended model is one observer per resolved socket; losers of the race
were meant to notice and exit. They didn't: displaced observers baselined
ownership from their own first probe and never detected a takeover, so they
lingered at 0% CPU forever — 30 processes sharing one socket, 29 of them zombies,
each still draining spool events and firing hooks with stale logic.

The fix is herdr's lesson (see `github.com/ogulcancelik/herdr`,
`src/server/autodetect.rs` + `handoff.rs`): don't rely on passive detection —
make liveness a kernel connect, never run a second live observer, and make the
rare replacement an *explicit* coordinated hand-off where the loser exits by
protocol. STATION already separates PTYs into `station-host`, so unlike herdr it
needs **no fd-passing** — a displaced observer's state is a disposable sqlite
snapshot.

## Empirical facts (spike-confirmed)

Measured against a real observer in an isolated `/private/tmp` state dir:

- `observer.stop` exits the process in ~194ms; SIGTERM ~257ms (non-wedged);
  SIGKILL ~42ms. A **wedged drain** (a command handler that ignores its abort)
  hangs both `observer.stop` and SIGTERM — only SIGKILL is terminal.
- `journal_mode` was `delete` (a SIGKILL was not corruption-safe). Now WAL.
- `lsof -t <socket>` returns the single bound owner (kernel truth, no health
  timeout). `ps -o lstart` gives an OS start-time token (**1s** resolution on
  macOS → pair argv-match AND lstart-match AND refuse-on-ambiguity).
- Socket derivation (`resolveObserverSocketForProcessArgs`): `--socket` >
  config `socket_path` > `XDG_RUNTIME_DIR/station/observer.sock` >
  `<state_dir>/run/observer.sock`. Candidacy must key on the **resolved socket**,
  never `--state-dir` (they diverge under XDG / explicit `socket_path`).
- The proposed `mkdir` + unique-tombstone rename lock is **unsafe**. Two
  contenders can cache the same stale-owner decision; after A renames and
  recreates the lock, delayed B can rename A's new live lock and both enter.
  The embedded `owner.json` also makes the proposed tombstone `rmdir` fail with
  `ENOTEMPTY` until the metadata is removed.
- Reusing the AF_UNIX bind/stale-reclaim primitive for the claim is also
  **unsafe**. Two reclaimers can both probe the old socket as stale; after A
  unlinks and binds, delayed B can unlink A's live pathname and bind a second
  server. A barrier-forced process spike produced two live claim servers.
- A separate SQLite claim database passed 50 Node-vs-Bun process races with
  exactly one `BEGIN IMMEDIATE` transaction owner each time. Killing a Bun
  owner released the OS lock for a Node successor without stale-path deletion,
  and the database reopened with `integrity_check=ok`.
- Graceful replacement returned its stop receipt before exit, then observed
  both socket closure and exact process death before the successor bound. A
  deliberately wedged command survived the receipt and SIGTERM, required
  SIGKILL, left a stale socket that the successor reclaimed, and reopened the
  database with WAL plus `integrity_check=ok`.
- CLI and provider-hook starts resolved byte-identical proposed claim paths from
  the effective socket with XDG unset, XDG set, and an explicit config socket
  containing a space. `hook-autostart.lock` still keys off `<stateDir>/run`, but
  it throttles hook spawns only; socket ownership remains exclusively governed
  by the child-held claim beside the resolved socket.

## Shipped

| Change | What |
| -------- | ------ |
| #81 | WAL + `synchronous=NORMAL` sqlite; `stn observer reap` (socket-keyed candidacy, `lsof` keeper + health tiebreak, refuse-on-ambiguity, re-verify argv+start-token before every signal, SIGTERM→SIGKILL). `resolveObserverSocketForProcessArgs` in `@station/config`. |
| #82 | Seeded socket-ownership watcher (`readSocketIdentity` + `expectedIdentity`); boot reorder — bind → arm seeded watcher → `observer.startup` reconcile, so a takeover during the scan is caught. |
| #83 | `runShutdownWithBackstop`: `stopObserver` force-exits at a 5s ceiling so a wedged drain can't hang shutdown. Self-stop is now terminal (prerequisite for eviction). |
| #84 | `bindWithStaleReclaim`: bind-first and reprobe protect an owner that was already live at the first bind. The 3d spike found a concurrent stale-reclaimer ABA; 3d-a now supplies the serialization required before this helper may reclaim. |
| 3c | Durable process identity: the successful socket binder atomically publishes and fsyncs `<socketPath>.pid` with the strict `{pid, osStartTime, version, socketPath}` payload before health is enabled. The full socket filename keeps identities distinct within a shared runtime directory. Publication failure is fatal. Clean shutdown removes only its exact matching identity; `lsof` remains primary ownership evidence. |
| 3d-a / #135 | The Observer child holds `BEGIN IMMEDIATE` on `dirname(resolvedSocket)/observer.claim.sqlite` across probe, stale reclaim, bind, pidfile publication, seeded watcher setup, and ready commitment. CLI and provider-hook clients only attach or spawn; health opens after synchronous claim release. |
| 3d-b prerequisite | Hook spool replay uses stable ingress identity, completes derived observations and report recovery state idempotently after primary dedupe, and unlinks records only after direct durable processing. Automatic handoff may now request graceful shutdown without turning process-memory queue acceptance into data loss. |
| 3d-b / #137 | Startup compares a strict SemVer Observer selector under the child-held claim. The display version is extended with reserved terminal `station.<sha256>` build metadata, so an exact identified selector reuses the incumbent while materially different builds of the same display version cannot silently attach. A deterministic identity ordering elects one replacement candidate; the loser refuses. Cross-version ordering is unchanged. A winning candidate replaces an incumbent only after `lsof`, health, pidfile, argv, and OS-start-token evidence agree, graceful stop plus at most one revalidated SIGTERM completes, and both socket closure and exact process death are observed. Missing legacy identity at the same display version, invalid, conflicting, or wedged ownership refuses without SIGKILL. |
| 3e | `hook-autostart.lock` remains a state-directory rate limiter for provider-hook spawn attempts only. Every spawned child still enters the socket-relative 3d-a claim, so lock-path divergence under XDG or explicit socket configuration cannot create a second ownership authority. |

Together these **stop the bleeding**: `reap` clears duplicates on demand, the
seeded watcher self-heals future displacements, and stop is terminal. Phase 3c
also gives later handoff and reaping work a durable, socket-relative
corroborating identity without changing current attach-or-spawn or
duplicate-reaping behavior. Phase 3d-a now serializes stale-socket reclamation
before either the socket path or pidfile can be mutated.

### 3d-a/3d-b boot contract

Spike result: **NO-GO for both stale-path deletion designs (directory rename and
AF_UNIX unlink/rebind); GO for a dedicated SQLite transaction claim backed by a
permanent cross-runtime adversarial test.** #135 shipped that narrow result;
PR #137 extends its claimed listening-socket branch with version-aware replacement.

Startup ownership mutation lives in observer boot (`main.ts`) under the
OS-lock-backed claim database
`C = dirname(resolvedSocket)/observer.claim.sqlite`. It holds one `BEGIN
IMMEDIATE` transaction from the socket probe through ready-state commitment.
Clients attach or spawn and never delete the socket path themselves.

The singleton identity remains the **resolved socket**, not the state directory
or claim path. Two different sockets in one directory intentionally share `C`
and serialize startup, but retain distinct listeners and `<socketPath>.pid`
files.

Boot sequence while holding `C`:

1. **Acquire `C`** by opening the dedicated database with private permissions
   and starting `BEGIN IMMEDIATE` with a bounded busy timeout. `SQLITE_BUSY`
   means another boot is in progress, so do not enter. Process death releases
   the OS transaction lock; the database file persists and needs no stale-owner
   deletion. Do not revive either rejected stale-path deletion scheme.
2. **Probe and negotiate** the resolved socket as `absent`, `stale`, `listening`,
   or `inaccessible`. Only `ECONNREFUSED`, or Bun's ambiguous existing-path
   `ENOENT`, with strict zero-holder `lsof` evidence is stale. Permission errors,
   timeouts, live holders, unavailable evidence, path replacement, and non-socket
   collisions are inaccessible and refuse before provider construction, main
   SQLite, bind, pidfile, stop, or signal. For a listening socket, compare strict SemVer health while still
   holding `C`: an exact identified selector or a higher-version incumbent attaches and
   the child exits 0; an elected same-version candidate or higher-version
   candidate replaces an incumbent only through verified graceful handoff;
   same-version legacy, losing, incomplete, conflicting, or wedged evidence refuses. The
   original 3d-a contract stopped at attach, while 3d-b extends this branch
   without adding client-side ownership mutation. The controlled stop request
   pins the revalidated process health and performs its final health check plus
   stop on one connection, so a socket replacement fails closed.
3. For `absent` or proven `stale`, **bind or reclaim** through the existing claimed
   bind path. The binder probes again, rechecks inode and birth time immediately
   before its one unlink attempt, captures the bound identity, publishes and fsyncs the socket-specific
   pidfile, arm the seeded ownership watcher, and commit readiness.
4. **Release `C` synchronously before health waiters are unblocked.** Startup
   reconcile follows outside the claim. A pre-ready stop or startup failure
   retains the claim through socket and pidfile cleanup, then releases it from
   the outer lifecycle cleanup path.

After stop begins, lifecycle admission rejects new command, ingress, snapshot,
diagnostic, and subscription operations before API routing. Health and repeated
stop remain lifecycle-only; health stays gated while shutdown converges.
Explicit CLI stop/restart pins PID and start time before sending stop on the same
connection; legacy health may omit build version or socket path, but missing
process identity refuses. The stop receipt is only acceptance: CLI success waits
until the endpoint is no longer listening, including through an unhealthy
shutdown transition.

Supporting:

- Normal CLI and provider-hook children receive the caller's bounded startup
  budget so SQLite contention cannot outlive the parent's health wait.
- Claim acquisition uses the low-level cross-runtime SQLite driver, not the
  Observer persistence database, migrations, or WAL configuration.
- File existence is never ownership. The claim database and SQLite sidecars are
  persistent private files and are never stale-reclaimed, renamed, or replaced.

Permanent coverage includes the 50-round Node-vs-Bun transaction race,
three-contender rounds, killed-owner recovery, production cold and stale-socket
races, inaccessible live ownership, displaced-listener abandonment, XDG/state
divergence, explicit paths with spaces, and CLI/hook timeout and non-mutation
cases. It proves mutual exclusion, not fairness.

## Remaining work

### Phase 4 — guarded self-heal (deferrable)

- Guarded self-heal: only after own-pid is the confirmed keeper AND it owns zero
  socket fds; stays OFF until `reap --force` is field-proven.

## Non-goals

- No fd-passing / SCM_RIGHTS — PTYs live in `station-host`; observer state is a
  disposable sqlite snapshot.
- No launchd/systemd supervisor — negotiation is in-process at start time.
- No Windows named-pipe path — observer is AF_UNIX only.
- No thin-client/proxy for older CLIs — version policy is attach, verified
  replacement, or refusal.

## Key files

- `apps/observer/src/runtime/main.ts` — boot negotiation, pidfile, stop.
- `apps/observer/src/runtime/observerHandoff.ts` — SemVer policy and coordinated handoff.
- `apps/observer/src/runtime/observerProcessEvidence.ts` — local process attribution and signaling adapter.
- `apps/observer/src/runtime/socketOwnership.ts` — seeded watcher (#82).
- `apps/observer/src/runtime/gracefulExit.ts` — force-exit backstop (#83).
- `packages/protocol/src/transport.ts` — `bindWithStaleReclaim` (#84).
- `apps/cli/src/observerProcess.ts` — normal CLI attach-or-spawn.
- `apps/cli/src/observerReap.ts` — reaper (#81).
- `apps/cli/src/ingress/observerStartup.ts`, `deliveryPolicy.ts` — hook attach-or-spawn and rate limiting (3d-a/3e).
- `packages/config/src/observerProcessArgs.ts` — socket resolution from argv (#81).
