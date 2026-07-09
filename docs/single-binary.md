# Single-binary Station

> **Status: v1.1 (current).** v1 was feasibility evidence, not an
> implementation-ready roadmap; an adversarial audit of commit `e0d4307`
> found 11 blocking issues, all reproduced and confirmed (see
> [Audit findings](#audit-findings-all-confirmed)). v1.1 is subtractive:
> it corrects the SQLite contract and dispatch boundary, removes the
> observer-eviction design in favor of the canonical singleton roadmap,
> pins platform/artifact/security policy, and defines config activation,
> station-host upgrade, checksum-verified install, and real-UX acceptance.
> The Stage 0 spike evidence (S1–S4) is preserved verbatim in the
> [Evidence appendix](#evidence-appendix-spikes-s1s4). v1's phase text is
> superseded by the phases below.

How STATION becomes one compiled `stn` binary (CLI + observer + ingress +
TUI renderer + station-host) whose first run always lands in a working
native station TUI with a healthy observer connected — no brew toolchain,
no `pnpm build`, no separate `bun install`, no manual observer step. Pick
up phases from the [Dependency graph](#dependency-graph); each is
independently landable and CI-green.

## Goal and non-goals

Goal: download one verified file, run `stn`, get the native TUI connected
to a live observer. Everything else (worktrunk, tmux, diffnav, git-delta,
agent CLIs) gates *features*, never launch — captured precisely by the
`launchReady` vs `workflowReady` split below.

Non-goals:

- **Public distribution.** The repo is private; binaries ship as private
  GitHub release assets fetched by an authenticated install script. A
  binary Homebrew formula is **deferred** until a tested private-asset
  download strategy exists (see A5); the authenticated script is the only
  binary channel meanwhile.
- **Windows targets.**
- **Any observer replacement / eviction in this roadmap.** Coordinated
  single-observer behavior is owned entirely by
  [observer-singleton](observer-singleton.md). This plan *depends on* that
  roadmap's 3c/3d/3e + version-order phases; it does not add a second,
  uncoordinated eviction path (v1 did — removed, see F3).
- **Replacing the dev workflow.** Dev mode (tsc dist under Node +
  `bun --hot` TUI from source) stays byte-identical; compiled mode is new
  dispatch layered on build-time defines.

## Supported platforms, versions, and artifact policy

Pinned so the release job, install script, and acceptance suite agree.

| Axis | Policy |
|------|--------|
| Targets | `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. No Windows. |
| Build runners | Native per target (no cross-compile — only the host-matching `@opentui/core-*` optional dep installs). Use *currently available* GitHub-hosted labels resolved at implementation time; do **not** hard-code `macos-13` (F9 — Intel macOS labels are being retired). Pin exact labels in the workflow with a comment naming the check date. |
| macOS floor | Match the oldest OS the chosen Intel/arm runners image supports; state it in release notes. |
| Linux floor | glibc only for v1.1 (bun's default). Declare the built-against glibc version (the runner's) as the floor; musl is a later target, not silently implied. |
| CPU | x64 baseline = bun's default (no AVX-512 assumption); arm64 = Apple/ARMv8. |
| Artifact | `stn-v{ver}-{darwin|linux}-{arm64|x64}.tar.gz`. **Manifest below is exhaustive.** |

**Artifact manifest** (every file the binary needs on disk that
`bun build --compile` does *not* embed — F8):

- `stn` — the compiled binary.
- `stn-ingress` — symlink → `stn` (argv0 dispatch).
- `stn-tmux-popup` — the tmux popup toggle. Today a separate bin
  (`package.json` → `integrations/terminal/tmux/bin/stn-popup`); the popup
  keybinding and setup depend on it. Either ship it as a third symlink →
  `stn` routed to an internal `__tmux-popup` mode, or vendor the script.
  Decide in A4; it is **not** optional.
- `LICENSE` — required. FSL-1.1 (LICENSE:67) obliges every redistributed
  copy to include the Terms or a link and keep copyright notices. The
  archive must carry it.
- **Extracted-at-runtime integration assets** (see A4 extraction policy):
  the Pi extension file (`integrations/harness/pi/src/piExtension.ts` is
  resolved as an on-disk `../dist/piExtension.js` via
  `new URL(import.meta.url)` and handed to the external `pi` CLI — it must
  exist as a real file, so it is embedded via a file import and extracted
  to a stable per-version cache dir), and the ctty helper (A2). The
  scripted-harness `.mjs` is test-only and may stay dev-mode-only.

## Security: no ambient config in compiled mode (F1 — confirmed RCE vector)

`bun build --compile` **auto-loads `.env` and `bunfig.toml` from the
process CWD by default** (`--compile-autoload-dotenv` /
`--compile-autoload-bunfig`, both default `true` — verified: a compiled
probe run in a directory containing `.env` with `F1_INJECTED=…` saw the
value in `process.env`). Because Station reads behavior from env
(`STATION_DASHBOARD_COMMAND` is spawned with `shell: true` at
`apps/cli/src/commands/tui.ts:152`; also `STATION_*_BIN`, `STATION_NODE`,
`STATION_HOST_ENTRY`, `STATION_PTY_IMPL`, …), running `stn` inside an
untrusted checkout would let that repo's `.env` inject an arbitrary shell
command — remote code execution on `stn` launch.

Mandatory in every compile invocation (A4):

```
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig …
```

Acceptance (A4 + release): a hostile-directory test — a checkout carrying
`.env` (`STATION_DASHBOARD_COMMAND=touch /tmp/PWNED`) and a `bunfig.toml`;
launching the binary there must **not** create the marker and must not
honor either file. This is a release-blocking gate, not a smoke check.

## Target architecture

```
stn (bun build --compile, per platform, no ambient env)
│  raw-argv dispatch (BEFORE runCli — F5):
├── argv0 == "stn-ingress"  → ingress main (owns raw stdin)
├── __observer              → runCliObserverMain (bun:sqlite driver; own --config/--socket parse)
├── __ingress               → ingress main (owns raw stdin)
├── __tui / __dashboard     → TUI renderer (re-exec self: spawn(execPath, ["__tui"]))
├── __station-host          → persistent-PTY host
├── __tmux-popup            → popup toggle (replaces stn-tmux-popup bin)
└── else                    → runCli (commands, setup, doctor, …)
       └── auto-start observer: spawn(process.execPath, ["__observer", …], detached)
```

- **Raw-argv dispatch, not hidden CLI commands (F5).** v1 registered
  `__observer`/`__ingress` in the normal command registry. That is wrong:
  `parseGlobalOptions` (`apps/cli/src/main.ts:150`) strips global `--config`
  before route execution, but the observer needs its own `--config` /
  `--socket` / `--state-dir` parsing (`runObserverMain`); and ingress owns
  **raw stdin** (`apps/cli/src/ingressMain.ts` → `readStdinIfAvailable`).
  All internal modes are dispatched from raw `process.argv` in the compile
  entry **before** `runCli`, each delegating to the same function today's
  dedicated entry (`observerMain.ts`/`ingressMain.ts`) calls. Testability
  under dev Node is preserved by exporting those run-functions and calling
  the dispatcher directly in vitest — not by making them registry commands.
- **Compile entry** `station/src/bin/stnMain.ts`, compiled from the
  `station/` workspace so one graph resolves station source (bun bundles
  TS/TSX directly) and `@station/*` pnpm packages from built dist, via
  `link-station-packages.sh` extended to link `apps/cli` → `@station/cli`
  and `apps/observer` → `@station/observer`. (S1 confirmed the bundler
  resolves through `exports` and the feared `.d.ts` `paths` hazard does not
  fire.)
- **Runtime-mode seam** `packages/runtime/src/buildInfo.ts`: build-time
  defines `STATION_BUILD_VERSION` / `STATION_BUILD_COMPILED` behind `typeof`
  guards; dev tsc reports `{ version: "0.0.0-dev", compiled: false }`.
  Self-spawns route through `selfExecArgv(entry)`: compiled →
  `[process.execPath, entry]`, dev → today's command. All
  `import.meta.url === file://${process.argv[1]}` self-exec guards become
  `import.meta.main` (S1 proved the legacy form double-executes under
  compile; S4 proved `import.meta.main` is correct everywhere).
- **TUI as a re-exec child** in compiled mode: crash isolation, terminal
  restore, unchanged env contract, `STATION_DASHBOARD_COMMAND` override
  honored (but ambient `.env` no longer feeds it — see Security).
- **PTY** = in-process `Bun.Terminal` **plus a controlling-terminal helper**
  (S2, F6): a per-platform `setsid()+TIOCSCTTY+execvp` trampoline embedded
  and extracted, without which shell panes lose Ctrl-Z job control and
  orphan on a Station crash. `STATION_PTY_IMPL=bridge` is **dev-only** (it
  needs Node + node-pty native assets a binary doesn't ship) — the binary's
  in-field PTY fallback is instead `STATION_PTY_IMPL=bun-nocctty` (the plain
  adapter without job control) plus reverting the A2b default flip. The doc
  must not promise the bridge as a binary rollback.
- **SQLite** = `apps/observer/src/sqlite/driver.ts`, runtime-branched
  (`bun:sqlite` under bun, `node:sqlite` under Node), with the **full
  contract** below (F2).
- **Hooks** keep the PATH-name `stn-ingress` default; every channel ships
  the symlink.

## `launchReady` vs `workflowReady` (F11 — don't weaken setup truth)

Rather than move required checks to `recommended` (v1's B4, which erodes
what "required" means), split the setup summary into two truths:

- `launchReady` — the binary can start the TUI + observer. Needs: the
  binary itself, a writable state dir. Nothing else. Bare `stn` gates on
  this.
- `workflowReady` — full worktree workflow: worktrunk, tmux, diffnav,
  git-delta, an agent CLI, git repo cwd, a project in config. `stn setup`
  reports these as unmet *capabilities*, not as "broken."

Each check keeps its real status; `stn setup check --json` gains both
booleans. `stn` launches whenever `launchReady`; the TUI surfaces unmet
`workflowReady` capabilities inline. Bun/station-UI/`rendererRuntimeCheck`
checks are skipped when `isCompiledBinary()`.

## Phases

### A1 — foundation: buildInfo + SQLite driver + real observer version

`packages/runtime/src/buildInfo.ts` (dev-safe `typeof`-guarded defines;
exported from the package index).

`apps/observer/src/sqlite/driver.ts` — **corrected contract (F2).** The
persistence layer reads `result.changes` (`ingressDedupe.ts:19`,
`observations.ts:117`, `worktreeMetadataCurrent.ts:107,119`,
`correlations.ts:210`, …). `run()` returning `void` cannot typecheck.
Verified both drivers: `run()` yields `{changes, lastInsertRowid}`
(bun:sqlite: `number`; node:sqlite: `number | bigint`). Contract:

```ts
export type SqlRunResult = { changes: number; lastInsertRowid: number | bigint };
export type SqlStatement = {
  run(...params: SqlParam[]): SqlRunResult;       // was void — WRONG in v1
  get(...params: SqlParam[]): unknown;            // normalized: undefined when no row
  all(...params: SqlParam[]): unknown[];
};
export type SqlDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
};

// Branch on runtime, never on import failure (node:sqlite silently kills bun).
export const openSqlDatabase: (path: string) => SqlDatabase =
  typeof Bun !== "undefined"
    ? adaptBunSqlite((await import("bun:sqlite")).Database)
    : adaptNodeSqlite((await import("node:sqlite")).DatabaseSync);
```

The bun adapter normalizes `get()` `null → undefined` and coerces
`changes` to `number` (callers already wrap in `Number(...)`; keep that).
The driver must also assert, once at open: WAL mode set, `synchronous`,
and that migrations run identically — the observer's `openObserverSqlite`
already applies `PRAGMA journal_mode = WAL` and migrations, so the driver
only needs to guarantee both `exec` and `prepare().run()` semantics match.

Feed `stationBuildInfo().version` into `createObserverCore` (fixes the
hardcoded `"0.0.0"` in `reconcile/core.ts`), surfacing a real version in
observer health. `stn --version`.

**Tests:** vitest driver-mapping units (node); a bun-lane test (`bun test`)
for the bun driver asserting `run().changes`, `get()`-no-row `undefined`,
integer round-trip, and WAL; and a **cross-runtime test**: a DB *created*
by the node driver, then *opened and read* by the bun driver (and vice
versa), proving migration/schema compatibility across the two engines.

### A2 — `Bun.Terminal` PTY adapter + controlling-terminal helper (two PRs)

`station/src/terminal/pty/bunTerminalProcess.ts` implementing
`StationTerminalProcess`; shared emitter extracted from
`LocalPtyTerminalProcess`. The payload command is spawned through a **ctty
helper** (S2, F6): `setsid()`, `ioctl(0, TIOCSCTTY)`, `execvp(payload)`.

Helper lifecycle (all required before the A2b default flip):

- **Source + build**: a tiny C source per platform (arm64/x64 × darwin/
  linux), compiled in release CI, checked in as source. `TIOCSCTTY` differs
  per platform (macOS `0x20007461`); no magic constants in TS.
- **Embedding + extraction**: embedded via file import; extracted to a
  per-version, per-user cache dir (e.g. `<stateDir>/run/helpers/<ver>/`)
  with `0700`, `chmod +x`, and an integrity check (size/hash) before use.
- **Concurrency**: extraction is idempotent and lock-guarded (two panes
  racing must not observe a half-written helper). Reuse if present + valid.
- **`noexec` policy**: if the cache dir is on a `noexec` mount, fall back
  to a temp exec-capable dir or surface a clear diagnostic; never silently
  drop to the no-ctty path.
- **Cleanup**: stale-version helpers pruned on observer start.

`createLocalPtyTerminal` becomes a selector. **A2a**: adapter opt-in
(`STATION_PTY_IMPL=bun`), default stays the bridge. **A2b**: default flip,
gated on ≥1 week daily-driving A2a and the acceptance below. In-field undo
for binary users is `STATION_PTY_IMPL=bun-nocctty` + reverting the flip —
**not** the bridge (dev-only).

**Per-platform job-control + orphan tests (release-blocking):** on every
target, in a real PTY, verify Ctrl-Z suspends and resumes (`fg`), that a
`SIGKILL` of the Station process leaves **no** orphaned pane children, and
that `terminal.close()` is paired with an explicit `child.kill()` (S2:
close alone does not kill).

### A3 — self-exec seam + raw-argv dispatch

`apps/cli/src/selfExec.ts`; raw-argv dispatcher in the compile entry and a
dev-mode equivalent, routing `__observer`/`__ingress`/`__tui`/`__dashboard`/
`__station-host`/`__tmux-popup` **before** `runCli` (F5). Export the
run-functions from `observerMain.ts`/`ingressMain.ts`/renderer/host so
dispatch is unit-testable. Swap every self-exec guard to `import.meta.main`.
Rewrite spawn sites (`observerProcess.ts`, `ingress/observerStartup.ts`,
`commands/tui.ts`, `observerProviders.ts` + `ensureHostRunning.ts`,
`notify/focusAction.ts`, `registry/popup.ts`, `scripted/launch.ts`) through
`selfExecArgv`. `Bun.env → process.env` in `station/src`.

### A4 — compile entry + build script + asset extraction + CI smoke

`station/src/bin/stnMain.ts`; `scripts/build-binary.mjs` + `build:binary`.
Compile command carries **both** ambient-config disable flags (F1) and the
version/compiled defines. Asset-extraction module resolves the Pi extension
and ctty helper from embedded files to the per-version cache on first use.
`link-station-packages.sh` extended for the app links.

CI `binary-smoke` (ubuntu): `--version`, `--help`, `setup check --json`
(asserting the `launchReady`/`workflowReady` split), an **observer round
trip through the binary** in an isolated state dir, an ingress receipt via
the `stn-ingress` symlink, the **hostile-directory RCE test** (F1), and the
**detached self-spawn** check (folds in S5). Note: `observerReap.ts`'s
ps-matcher must learn the compiled argv shape.

### A5 — release pipeline (private, deterministic, verifiable)

`.github/workflows/release.yml` on `v*` tags, native-runner matrix
(labels resolved at build time per the platform table — not `macos-13`).
Requirements v1 omitted:

- **Reuse the existing gate**: tag builds must run the same deterministic
  checks as `standard-ci` + `pnpm smoke:release`, not bypass them.
- **Checksums**: emit `SHA256SUMS`, sign or at least publish it; the
  install script verifies each artifact against it before extraction.
- **License**: include `LICENSE` in every archive (F9 / LICENSE:67).
- **Homebrew (F10)**: a release created with the default `GITHUB_TOKEN`
  **does not** trigger the existing `release: published` bump workflow
  (`homebrew-bump.yml`). Either fold the tap update into `release.yml` (with
  a PAT / `COMMITTER_TOKEN`) or dispatch it explicitly. **Until a tested
  private-asset download strategy exists, defer the binary formula** and
  ship only the authenticated install script.
- **Rollback**: deleting a published tag is **not** rollback. Define
  immutable rollback = publish a superseding patch release pointing the
  install script / `latest` at the prior good version; never mutate or
  delete a published artifact.
- `scripts/install.sh`: authenticated `gh api` download → checksum verify →
  `xattr -d com.apple.quarantine` (defensive; gh/curl set none per S3) →
  install to `~/.local/bin` with the `stn-ingress` symlink → PATH hint.

### A6 — cleanup (after one release on the ctty PTY path)

Delete the bridge, node-pty, `repair-node-pty`, `STATION_NODE`, and their
tests, once the per-platform acceptance has been green for a full release
cycle. Keep `STATION_DASHBOARD_COMMAND` / `STATION_HOST_ENTRY` /
`STATION_BUN` as dev escape hatches.

## Track B — first-run guarantee

### B1 — config-tolerant launch

In-memory defaults, write-on-configure (no auto-written stub — it poisons
`stn setup`'s clean create path). Lift `emptyConfig` to
`packages/config/src/firstRun.ts`; add `handleConfigError` hooks on
`registry/tui.ts` + `registry/popup.ts` that degrade **only**
`CONFIG_FILE_NOT_FOUND` without an explicit `--config`; broken config and
explicit `--config` keep the hard error. The renderer's empty-state is the
first-run screen.

### B2 — observer boot guarantee (no eviction — F3)

Boot log `<stateDir>/logs/observer-boot.log` replacing `stdio:"ignore"`;
child-exit race → immediate `OBSERVER_EXITED_ON_START` with a boot-log
tail (kills the silent 30s hang); default health wait 30s → 10s with
progressive stderr from the tui/popup call sites only.

**Removed from v1:** the client-side unhealthy-incumbent SIGTERM eviction.
It conflicts with [observer-singleton](observer-singleton.md), which is
explicitly consolidating to **one** socket-relative `observer.claim.lock`
with process-identity revalidation, total version ordering, and spool
safety (3d/3e + Phase 4). Adding a second, uncoordinated client killer is
exactly what that roadmap removes. **Dependency, not duplication:** the
version-aware upgrade behavior this plan needs (B3) is delivered by the
singleton roadmap's version-order phase. If that lands, B3 consumes it; if
not, B3 ships **only** the same-version restart in B-config below and the
schema-mismatch UX — never an out-of-band kill.

### B-config — config activation (F4 — v1 was wrong)

v1 claimed B3 closes the "config-less observer keeps serving
`emptyConfig()` after `stn setup`" gap. It does not: B3 restarts only an
**older-version** observer, so a same-version first-run `setup` leaves the
observer on `emptyConfig()` indefinitely. Fix, one of (pick in
implementation, prefer the first):

1. **`stn setup` explicitly reloads/restarts the observer** on writing a
   config that changes project membership — a targeted `restartObserver`
   (same-version safe: stop via RPC works) after `configWriter` succeeds,
   with a user-visible line.
2. **Health exposes configuration identity** (config path + a content hash);
   the CLI restarts when the running observer's config identity differs from
   the on-disk config. This also generalizes to external edits.

Either way, the first-run flow must guarantee the observer reflects the new
project without a manual restart — that is the headline UX and must be in
the acceptance suite.

### B3 — version + schema UX (scoped down)

Same-version config activation via B-config. Renderer exit code 86 =
"restart observer" on a `halted` + `PROTOCOL_SCHEMA_MISMATCH` state → the
CLI parent restarts once and respawns the renderer. Older-binary-version
auto-restart is **deferred to the singleton version-order phase**; this
plan does not implement its own version eviction.

### B-host — station-host upgrade behavior (F7 — was undefined)

`ensureHostRunning` reuses an existing host if health responds, but host
health carries only `{ok, protocolVersion}` (`packages/station-host/src/
protocol.ts`). An upgraded binary would keep talking to an old host process
driving **live PTYs**. Define:

- Host health must carry the build version (mirror A1's observer fix).
- Compatibility rule: reuse iff `protocolVersion` matches **and** version is
  compatible; otherwise graceful replacement.
- Live-PTY policy: what happens to existing PTYs + scrollback on
  replacement — either a reattach/handoff (preferred; the host already
  snapshots scrollback on attach) or an explicit, announced session end.
  Undefined behavior here means silent session loss on upgrade; the
  acceptance suite exercises upgrade-with-live-host.

## Dependency graph

One graph replaces v1's two prose landing-orders.

```
A1 ─────────────┬─► A2a ─► A2b ──────────────┐
 (buildInfo,     │   (ctty helper + per-       │
  sqlite,        │    platform job-control     │
  real version)  │    acceptance)              │
                 ├─► A3 ─► A4 ─► A5 ─► A6       │
                 │   (raw dispatch; compile +   (delete bridge after
                 │    RCE gate; release;         one green release)
                 │    checksum/license/brew)
                 │
                 └─► B3 (schema/version UX) ◄── observer-singleton version-order phase
B1 ─► B2 ─► B-config ─► B3
              (config activation — headline UX)
B-host  (independent; needed before upgrade is advertised safe)

External dependency: observer-singleton 3c/3d/3e + version order
  → required before any older-version observer handoff is claimed safe.
```

Suggested merge order: A1 → B1 → B2 → B-config → A2a → A3 → A4 → A2b →
B-host → A5 → A6, with B3's version half gated on the singleton roadmap.

## Verification (F11 — prove the headline UX, not a proxy)

Unit/integration (every PR): vitest fake-seam tests; bun-lane driver + PTY
tests; the cross-runtime SQLite test (A1).

CI smoke (A4): the binary end-to-end minus TTY, **including** the
hostile-directory RCE gate and detached self-spawn.

**Release acceptance (every target, on a clean box with no Node/Bun/
node_modules on PATH):** this is the gate v1 lacked. `STATION_DASHBOARD_
COMMAND=true` and `HOME=$(mktemp -d)` do **not** count — and note
`mktemp` HOME can still inherit an `XDG_RUNTIME_DIR` socket, so the harness
must scrub `XDG_RUNTIME_DIR`/`XDG_STATE_HOME` too. The manual/automated
flow:

1. Launch bare `stn` outside tmux in a sanitized, isolated env → real
   OpenTUI renderer draws, observer connects, first-run screen shows.
2. Open a shell pane → **Ctrl-Z suspends, `fg` resumes** (real job control).
3. Run `stn setup` adding a project → the **same** observer reflects the new
   project immediately (B-config), no manual restart.
4. Bare `stn` inside tmux → popup path via `stn-tmux-popup`.
5. `stn-ingress` symlink delivers a provider hook event end to end.
6. Upgrade the binary while **live host PTYs** exist → reattach without
   session loss (B-host).
7. Rollback → install script returns to the prior good version (immutable).

## Audit findings (all confirmed)

Against `e0d4307`, reproduced this session (bun 1.3.14, darwin-arm64):

1. **Ambient `.env`/`bunfig` RCE** — compiled binary auto-loads cwd `.env`
   into `process.env` (proven); `STATION_DASHBOARD_COMMAND` runs with
   `shell: true`. Fix: `--no-compile-autoload-dotenv` +
   `--no-compile-autoload-bunfig` (both exist, default true) + hostile-dir
   gate. Arguably broader than reported — the whole `STATION_*` env surface
   is attacker-controlled, not just the dashboard command.
2. **SQLite facade wrong** — `run(): void` cannot typecheck against
   `result.changes` (6+ sites). Both engines return
   `{changes, lastInsertRowid}`. Corrected in A1.
3. **Eviction conflicts with the singleton design** — removed; deferred to
   observer-singleton (B2/B3). Design-coherence issue, not a runtime bug,
   but real.
4. **First-run config stays stale** — B3 only restarts older versions;
   same-version `setup` leaves `emptyConfig()`. New B-config.
5. **Internal modes misrouted** — `parseGlobalOptions` strips `--config`;
   ingress owns raw stdin. Dispatch from raw argv before `runCli` (A3).
6. **PTY rollback promise false** — `STATION_PTY_IMPL=bridge` needs Node +
   node-pty assets a binary lacks; ctty helper had no lifecycle. Fixed in
   A2 + architecture.
7. **station-host upgrades undefined** — health is protocol-number-only.
   New B-host.
8. **Artifact inventory incomplete** — `stn-tmux-popup`, Pi extension file,
   LICENSE. New manifest + extraction policy.
9. **Release not shippable** — runner label, OS/CPU/glibc floors, gate
   bypass, checksums, license, real rollback. Fixed in A5 + platform table.
   (Sub-claim "`macos-13` retired": consistent with GitHub's Intel-macOS
   deprecation; **not independently verified from this environment** — pin
   available labels at implementation time rather than trust the name.)
10. **Homebrew automation diverges** — `GITHUB_TOKEN`-created releases don't
    trigger `release: published`. Fold in or dispatch; defer the formula.
11. **Verification proves a proxy, not the UX** — new release-acceptance
    suite on clean boxes.

## Evidence appendix: spikes S1–S4

Verified 2026-07-09, bun 1.3.14, darwin-arm64, against a scratch clone of
merged main (`pnpm build` + station `bun install` + hand-linked
`@station/cli`/`@station/observer`). S5 stays deferred to A4's CI smoke.
These are load-bearing evidence for v1.1; the probes are runnable.

**Feasibility probes (re-run after any bun upgrade):**

- `@opentui/core` 0.4.1 compiles: platform `index.bun.js` is
  `await import("./libopentui.dylib", { with: { type: "file" } })`; core
  handles bunfs paths. Dylib embeds automatically.
- `Bun.Terminal` real PTY:
  `bun -e 'const t=new Bun.Terminal({cols:80,rows:24,data(_,c){out+=new TextDecoder().decode(c)}});let out="";const p=Bun.spawn(["/bin/echo","hi"],{terminal:t});p.exited.then(c=>setTimeout(()=>{console.log(out.includes("hi")&&c===0?"ok":"bad");t.close()},200))'`
  → `ok`.
- node-pty hangs under bun (same echo via `require("node-pty")` times out).
- `require("node:sqlite")` silently kills bun:
  `bun -e 'process.stdout.write("before\n");require("node:sqlite");process.stdout.write("after\n")'`
  prints only `before`. → runtime-branched driver.
- `node:net` unix sockets work under bun.

**S1 — PASS (bundle graph).** 807 modules → 73MB in ~70ms. Bundler
resolved every `@station/*` import via node_modules `exports`; the
`apps/cli/tsconfig.json` `.d.ts` `paths` hazard did **not** fire.
`jsxImportSource` applied to bundled `.tsx`; opentui dylib embedded; the
binary rendered the dashboard under a PTY (live alt-screen). Two defects,
both mapped: top-level `node:sqlite` kills startup (one value-import in
`apps/observer/dist/sqlite.js`; hand-shimming `bun:sqlite` there made it
work — A1); and `main.ts`'s `file://${argv[1]}` self-exec guard fires for
every bundled module under compile → `runCli` runs twice (A3 → `import.meta.main`).

**S2 — PASS with the A2 ctty amendment.** Output complete before
`p.exited` resolves (no drain race). Kernel PTY backpressure bounds
memory: a slow `data` callback throttled a 200MB `cat` to peak RSS 31MB
(`TerminalOptions` also exposes a `drain` callback). Resize: 0 throws, 1
works → keep 2/1 clamps. `terminal.close()` does **not** kill the child
(dispose must). No controlling terminal by default (`ps` → `TTY ??`,
TPGID 0): Ctrl-Z arrives as literal `^Z` and children **orphan** on parent
exit/SIGKILL. A `setsid()+TIOCSCTTY` trampoline fixes both — verified:
Ctrl-Z suspends and children die with the parent even under SIGKILL. →
A2's ctty helper (F6).

**S3 — PASS for the install path.** Compiled output is ad-hoc
linker-signed (`flags=adhoc,linker-signed`) and runs unmodified; a
`com.apple.quarantine` xattr (browser-download simulation) makes macOS
SIGKILL it (exit 137). gh/curl set no quarantine → A5 path unaffected;
installer strips defensively. Developer-ID + notarization only for
browser-download distribution (deferred).

**S4 — PASS.** `import.meta.main`: dev-imported `false` / dev-standalone
`true` / compiled-entry `true` / compiled-imported `false`. The legacy
`file://argv[1]` guard is `true` for imported modules under compile and
must not survive A3.
