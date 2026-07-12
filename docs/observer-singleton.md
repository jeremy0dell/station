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

## Shipped

| Change | What |
|--------|------|
| #81 | WAL + `synchronous=NORMAL` sqlite; `stn observer reap` (socket-keyed candidacy, `lsof` keeper + health tiebreak, refuse-on-ambiguity, re-verify argv+start-token before every signal, SIGTERM→SIGKILL). `resolveObserverSocketForProcessArgs` in `@station/config`. |
| #82 | Seeded socket-ownership watcher (`readSocketIdentity` + `expectedIdentity`); boot reorder — bind (`drainOnStart:false`) → arm seeded watcher → `observer.startup` reconcile, so a takeover during the scan is caught. |
| #83 | `runShutdownWithBackstop`: `stopObserver` force-exits at a 5s ceiling so a wedged drain can't hang shutdown. Self-stop is now terminal (prerequisite for eviction). |
| #84 | `bindWithStaleReclaim`: bind-first, unlink+retry only after a reprobe confirms nobody's listening. A live socket is never unlinked (killed the check-then-unlink race). |
| 3c | Durable process identity: the successful socket binder atomically publishes and fsyncs `<socketPath>.pid` with the strict `{pid, osStartTime, version, socketPath}` payload before health is enabled. The full socket filename keeps identities distinct within a shared runtime directory. Publication failure is fatal. Clean shutdown removes only its exact matching identity; `lsof` remains primary ownership evidence. |

Together these **stop the bleeding**: `reap` clears duplicates on demand, the
seeded watcher self-heals future displacements, and stop/bind are race-safe and
terminal. Phase 3c also gives later handoff and reaping work a durable,
socket-relative corroborating identity without changing current attach-or-spawn
or duplicate-reaping behavior.

## Remaining work

### 3d — explicit step-down negotiation (HIGHEST RISK — spike first)

Move singleton negotiation into the observer boot (`main.ts`) under **one**
socket-relative lock `L = dirname(socketPath)/observer.claim.lock`. Clients
(`observerProcess.ts`) shrink to attach-or-spawn.

Boot sequence under `L`:
1. **Acquire `L`** via `mkdir`. On `EEXIST`, read owner `{pid, osStartTime}`:
   if that pid is live AND start-time matches → another boot is negotiating →
   exit 0. If dead/mismatch → **reclaim atomically** via
   `rename(L, L.reclaim.<nonce>)` (exactly one racer wins; the loser gets
   `ENOENT` → backoff → reloop), winner `rmdir`s the renamed dir and re-`mkdir`s
   `L`. **Never** blind `rmdir`+recreate (that lets two claimers occupy the
   critical section).
2. **Probe** under `L` with connect-based `isSocketStale`: no listener → free;
   connect ok + incumbent version compatible-and->=mine → release `L`, exit 0
   (attach); connect ok + older-incompatible, or connect ok but unhealthy → evict.
3. **Resolve incumbent pid**: pidfile `F` preferred; else `lsof -t P`; else `ps`
   argv scan matching `observerMain` + exact resolved socket. If bound-but-
   unhealthy with no attributable pid → refuse (leave to `reap --force`).
4. **Evict + confirm by observation** (never trust the receipt — `buildStop`
   returns before the process exits): send `observer.stop`, then poll ~25ms
   requiring `connect(P)` fails AND `liveness(pid)==false`, where liveness =
   `processExists(pid) AND osStartTime(pid)==token`. Budget is **adaptive**:
   while the pid is alive but connect already fails (drain in progress), keep
   waiting to a larger cap; escalate only on no-progress past a wedge threshold.
   Escalate: re-verify identity → SIGTERM → poll → re-verify → SIGKILL → confirm
   `ESRCH`. A token/start-time mismatch at **any** step means the pid was
   recycled → do NOT signal, treat as confirmed-gone.
5. **Reclaim socket** via `bindWithStaleReclaim` (#84 — bind-first).
6. **Write pidfile** `F` (3c).
7. **Arm the seeded watcher** (#82) and reconcile.
8. **Release `L`.**

Supporting:
- Client attach-or-spawn: spawn on `unhealthy` too; concurrent spawns are safe
  because booted observers serialize on `L`.
- `stn observer stop` escalates SIGTERM→SIGKILL client-side so a wedged owner is
  killed, not error-returned.
- `restartObserver` threads the held lock (no re-entrant acquire).
- DI seams: `killProcess` / `processExists` / `osStartTime`.

**Spike before building** (the plan's adversarial panel flagged these; prove
them empirically):
- rename-steal: two processes racing to reclaim one dead-pid lockdir → exactly
  one ends up owning `L`.
- eviction end-to-end in an isolated state dir: spawn incumbent, evict via
  `observer.stop`, confirm-by-observation, new one binds; wedged incumbent →
  SIGKILL path.
- lock path is byte-identical for hook-start vs CLI-start with `XDG_RUNTIME_DIR`
  set AND unset.

### 3e — unify hook auto-start onto `L`

Route `apps/cli/src/ingress/observerStartup.ts` + `deliveryPolicy.ts` hook
auto-start through the same spawn/lock and **retire `hook-autostart.lock`**.
Two lock namespaces never mutually exclude under config-override/XDG divergence.

### Phase 4 — version order + spool + guarded self-heal (deferrable, needs 3d)

- Refine the version gate into a **total antisymmetric order** with a
  deterministic `(version, startedAt, pid)` tiebreak so no pair both-evicts
  (mutual-eviction livelock under crash-respawn / hook-restart).
- Treat `undefined` health.version as UNKNOWN → conservative attach-if-
  compatible-else-refuse, never force-replace. (The `.optional()` health fields
  `pid`/`version`/`socketPath` may be absent on an old incumbent — the policy
  must not depend on any being present.)
- Make spool consume idempotent-by-event-id OR atomic claim-by-rename **before**
  SIGKILL is a routine terminator (consume is read→ingest→unlink = at-least-once).
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
