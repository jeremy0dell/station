# Observer singleton & step-down

Status: shipped-history and remaining singleton roadmap. For the current Observer runtime
ownership and lifecycle contract, see [Observer Architecture](observer-architecture.md).

How STATION keeps exactly one observer per state dir, why the old design let
duplicates accumulate, what has shipped, and the remaining work. Pick up the
unfinished phases from the "Remaining work" section — each is independently
landable.

## Problem

An observer is auto-spawned by any `stn` invocation for its state dir, but the
default socket (`~/.local/state/station/observer.sock`) is shared across all
worktrees. The intended model is one observer; losers of the race were meant to
notice and exit. They didn't: displaced observers baselined ownership from their
own first probe and never detected a takeover, so they lingered at 0% CPU
forever — 30 processes sharing one socket, 29 of them zombies, each still
draining spool events and firing hooks with stale logic.

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
  containing a space. The current `hook-autostart.lock` still keys off
  `<stateDir>/run` and therefore diverges under XDG/config overrides until 3e.

## Shipped

| Change | What |
|--------|------|
| #81 | WAL + `synchronous=NORMAL` sqlite; `stn observer reap` (socket-keyed candidacy, `lsof` keeper + health tiebreak, refuse-on-ambiguity, re-verify argv+start-token before every signal, SIGTERM→SIGKILL). `resolveObserverSocketForProcessArgs` in `@station/config`. |
| #82 | Seeded socket-ownership watcher (`readSocketIdentity` + `expectedIdentity`); boot reorder — bind (`drainOnStart:false`) → arm seeded watcher → `observer.startup` reconcile, so a takeover during the scan is caught. |
| #83 | `runShutdownWithBackstop`: `stopObserver` force-exits at a 5s ceiling so a wedged drain can't hang shutdown. Self-stop is now terminal (prerequisite for eviction). |
| #84 | `bindWithStaleReclaim`: bind-first and reprobe protect an owner that was already live at the first bind. The 3d spike found a remaining concurrent stale-reclaimer ABA, so this helper is safe only once boot attempts are serialized by `C`. |
| 3c | Durable process identity: the successful socket binder atomically publishes and fsyncs `<socketPath>.pid` with the strict `{pid, osStartTime, version, socketPath}` payload before health is enabled. The full socket filename keeps identities distinct within a shared runtime directory. Publication failure is fatal. Clean shutdown removes only its exact matching identity; `lsof` remains primary ownership evidence. |

Together these **stop the bleeding**: `reap` clears duplicates on demand, the
seeded watcher self-heals future displacements, and stop is terminal. Phase 3c
also gives later handoff and reaping work a durable, socket-relative
corroborating identity without changing current attach-or-spawn or
duplicate-reaping behavior. Concurrent reclamation of one already-stale socket
remains open until 3d serializes boot.

## Remaining work

### 3d — explicit step-down negotiation (HIGHEST RISK)

Spike result: **NO-GO for both stale-path deletion designs (directory rename and
AF_UNIX unlink/rebind); GO for a dedicated SQLite transaction claim backed by a
permanent cross-runtime adversarial test.** The current stale-socket race is
tracked in #135.

Move singleton negotiation into the observer boot (`main.ts`) under **one**
OS-lock-backed, socket-relative claim database
`C = dirname(socketPath)/observer.claim.sqlite`. Hold one `BEGIN IMMEDIATE`
transaction for the whole negotiation. Clients (`observerProcess.ts`) shrink
to attach-or-spawn.

Boot sequence while holding `C`:
1. **Acquire `C`** by opening the dedicated database with private permissions
   and starting `BEGIN IMMEDIATE` with a bounded busy timeout. `SQLITE_BUSY`
   means another boot is negotiating, so do not enter. Process death releases
   the OS transaction lock; the database file persists and needs no stale-owner
   deletion. Do not revive either rejected stale-path deletion scheme.
2. **Probe** with connect-based `isSocketStale`: no observer listener → free;
   connect ok + incumbent version compatible-and->=mine → roll back and close
   `C`, exit 0 (attach); connect ok + older-incompatible, or connect ok but
   unhealthy → evict.
3. **Resolve incumbent identity**: `lsof -t P` is primary binder evidence;
   pidfile `F`, health PID, and `ps` argv + OS start token corroborate it. Capture
   the exact resolved socket and refuse on missing or conflicting evidence. If
   bound-but-unhealthy has no attributable pid, leave it to `reap --force`.
4. **Evict + confirm by observation** (never trust the receipt — `buildStop`
   returns before the process exits): send `observer.stop`, then poll ~25ms
   requiring `connect(P)` fails AND `liveness(pid)==false`, where liveness =
   `processExists(pid) AND osStartTime(pid)==token`. Budget is **adaptive**:
   while the pid is alive but connect already fails (drain in progress), keep
   waiting to a larger cap; escalate only on no-progress past a wedge threshold.
   Escalate: re-verify identity → SIGTERM → poll → re-verify → SIGKILL → confirm
   `ESRCH`. Revalidate pidfile, argv, start token, and socket ownership before
   every signal. A token mismatch means the captured process identity is gone,
   so do not signal it; it does **not** prove the socket is free.
5. **Reclaim socket** via `bindWithStaleReclaim` (#84 — bind-first).
6. **Write pidfile** `F` (3c).
7. **Arm the seeded watcher** (#82) and reconcile.
8. **Commit or roll back the claim transaction and close `C`.** The database
   file remains for the next negotiation.

Supporting:
- Client attach-or-spawn: spawn on `unhealthy` too; concurrent spawns are safe
  because booted observers serialize on `C`.
- `restartObserver` threads the held claim (no re-entrant acquire).
- DI seams: `killProcess` / `processExists` / `osStartTime`.
- Automatic SIGKILL is not shippable until spool consumption is idempotent by
  event ID or atomically claimed by rename. Until then a wedged incumbent must
  refuse or escalate only through an explicit operator path. After that
  prerequisite, `stn observer stop` may use the same guarded SIGTERM→SIGKILL
  escalation instead of returning with the wedged owner still alive.

Implementation starts red with deterministic two-process regressions for both
rejected cached-stale ABA schedules. Then preserve the 50-round Node-vs-Bun
transaction race, killed-owner recovery, process-level eviction, and CLI/hook
path-parity cases from the spikes as permanent coverage.

### 3e — unify hook auto-start onto `C`

Route `apps/cli/src/ingress/observerStartup.ts` + `deliveryPolicy.ts` hook
auto-start through the same spawn/claim and **retire `hook-autostart.lock`**.
Two lock namespaces never mutually exclude under config-override/XDG divergence.

### Phase 4 — version order + guarded self-heal (deferrable, needs 3d)

- Refine the version gate into a **total antisymmetric order** with a
  deterministic `(version, startedAt, pid)` tiebreak so no pair both-evicts
  (mutual-eviction livelock under crash-respawn / hook-restart).
- Treat `undefined` health.version as UNKNOWN → conservative attach-if-
  compatible-else-refuse, never force-replace. (The `.optional()` health fields
  `pid`/`version`/`socketPath` may be absent on an old incumbent — the policy
  must not depend on any being present.)
- Guarded self-heal: only after own-pid is the confirmed keeper AND it owns zero
  socket fds; stays OFF until `reap --force` is field-proven.

## Non-goals

- No fd-passing / SCM_RIGHTS — PTYs live in `station-host`; observer state is a
  disposable sqlite snapshot.
- No launchd/systemd supervisor — negotiation is in-process at start time.
- No Windows named-pipe path — observer is AF_UNIX only.
- No thin-client/proxy for older CLIs — version policy is attach-or-refuse.

## Key files

- `apps/observer/src/runtime/main.ts` — boot negotiation, pidfile, stop.
- `apps/observer/src/runtime/socketOwnership.ts` — seeded watcher (#82).
- `apps/observer/src/runtime/gracefulExit.ts` — force-exit backstop (#83).
- `packages/protocol/src/transport.ts` — `bindWithStaleReclaim` (#84).
- `apps/cli/src/observerProcess.ts` — attach-or-spawn, restart lock threading.
- `apps/cli/src/observerReap.ts` — reaper (#81).
- `apps/cli/src/ingress/observerStartup.ts`, `deliveryPolicy.ts` — hook auto-start (3e).
- `packages/config/src/observerProcessArgs.ts` — socket resolution from argv (#81).
