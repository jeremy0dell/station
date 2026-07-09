# Single-binary Station

How STATION becomes one compiled `stn` binary (CLI + observer + ingress + TUI
renderer + station-host) whose first run always lands in a working native
station TUI with a healthy observer connected — no brew toolchain, no
`pnpm build`, no separate `bun install`, no manual observer step. Pick up
stages from "Landing order" — each phase is independently landable and
CI-green.

## Goal and non-goals

Goal: download one file, run `stn`, get the native TUI connected to a live
observer. Everything else (worktrunk, tmux, diffnav, git-delta, agent CLIs)
gates *features*, never launch.

Non-goals for this plan:

- Public distribution. The repo is private; binaries ship as private GitHub
  release assets with a gh-authenticated install script. Public
  curl-install / homebrew-core wait on the repo opening up
  (see [Homebrew packaging](homebrew.md) blockers).
- Windows targets.
- The full observer-singleton 3d claim-lock hand-off
  ([observer-singleton](observer-singleton.md)) — this plan's eviction logic
  is deliberately narrower and forward-compatible with it.
- Replacing the dev workflow. Dev mode (tsc dist under Node + `bun --hot`
  TUI from source) stays byte-identical; compiled mode is a new dispatch
  layered on build-time defines.

## Why this is now feasible (empirical facts, verified 2026-07-09, bun 1.3.14, darwin-arm64)

Re-run these probes after any bun upgrade; each unlocks a load-bearing
decision.

- **`@opentui/core` 0.4.1 supports `bun build --compile` natively.** The
  platform packages' `index.bun.js` is
  `await import("./libopentui.dylib", { with: { type: "file" } })` and core
  handles bunfs paths (`isBunfsPath` in its bundle). The TUI's native dylib
  embeds automatically — no extract-and-dlopen shim needed.
- **`Bun.Terminal` provides real PTYs.** Probe:

  ```bash
  bun -e 'const t = new Bun.Terminal({ cols: 80, rows: 24, data(_, c) { out += new TextDecoder().decode(c); } });
  let out = ""; const p = Bun.spawn(["/bin/echo", "hi"], { terminal: t });
  p.exited.then((code) => setTimeout(() => { console.log(out.includes("hi") && code === 0 ? "ok" : "bad"); t.close(); }, 200));'
  ```

  Prints `ok`. Instance API: `close, closed, controlFlags, inputFlags,
  localFlags, outputFlags, ref, unref, resize, setRawMode, write`. This
  replaces node-pty, its `spawn-helper` binary, `localPtyBridge.cjs`, and the
  hidden **Node runtime dependency** (`station/src/terminal/pty/localPtyTerminal.ts`
  spawns `node` for the bridge today).
- **node-pty hangs under bun** — `pty.spawn` never fires `onData`/`onExit`
  (probe: same echo test via `require("node-pty")`; times out). This is why
  the Node bridge subprocess exists; it cannot be kept in a bun-only binary.
- **`require("node:sqlite")` under bun silently kills the process** — exit 0,
  no output, no throw (probe: `bun -e 'process.stdout.write("before\n");
  require("node:sqlite"); process.stdout.write("after\n")'` prints only
  `before`). The observer's sqlite layer must branch on runtime and must
  never *evaluate* the `node:sqlite` import under bun. `bun:sqlite` works.
- **`node:net` unix-socket server + client work under bun** (probe: bind a
  socket in tmpdir, round-trip a payload). `packages/protocol/src/transport.ts`
  ports as-is.
- **Known bundler hazard:** `apps/cli/tsconfig.json` maps `@station/*` paths
  to **`.d.ts` files** — if bun's bundler honors nearest-tsconfig paths for
  files under `apps/cli/`, imports resolve to declaration files (spike S1).
- `station/scripts/link-station-packages.sh` already symlinks built
  `@station/*` dists into `station/node_modules/@station/`; `runCli` is
  already exported from `apps/cli/src/main.ts`.

## Target architecture

```
stn (bun build --compile, per platform)
├── default argv        → CLI (runCli — commands, setup, doctor, …)
│     └── auto-start:     spawn(process.execPath, ["__observer", …], detached)
├── __observer           → runCliObserverMain (bun:sqlite driver)
├── __ingress            → ingress main; also selected when basename(argv0) == "stn-ingress"
├── __tui / __dashboard  → TUI renderer child: spawn(process.execPath, ["__tui"])
└── __station-host       → persistent-PTY host (feature-flagged)
```

- **Compile entry** `station/src/bin/stnMain.ts`, compiled from the
  `station/` workspace so one graph resolves both worlds: station source
  (bun bundles TS/TSX directly) and `@station/*` pnpm packages **from built
  dist**, via `link-station-packages.sh` extended to also link
  `apps/cli` → `@station/cli` and `apps/observer` → `@station/observer`.
  Renderer/host entries dispatch *before* the CLI so renderer children never
  execute CLI config loading.
- **Internal dispatch** uses hidden `__`-prefixed subcommands registered in
  the normal CLI command registry — they work under dev Node too
  (`node dist/main.js __observer …`), which makes dispatch vitest-testable
  without compiling.
- **Runtime-mode seam**: `packages/runtime/src/buildInfo.ts` reads build-time
  defines `STATION_BUILD_VERSION` / `STATION_BUILD_COMPILED` behind `typeof`
  guards, so dev tsc output stays valid under Node and reports
  `{ version: "0.0.0-dev", compiled: false }`. Every self-spawn site asks one
  helper (`selfExecArgv(entry)`): compiled → `[process.execPath, entry]`,
  dev → today's exact behavior.
- **TUI stays a child process in compiled mode** (re-exec self, not
  in-process): keeps crash isolation and terminal-restore semantics, the env
  contract (`STATION_OBSERVER_SOCKET_PATH`, `STATION_TUI_POPUP`, focus-origin
  vars), and the `STATION_DASHBOARD_COMMAND` override. Same binary, so the
  cost is one fork + shared page cache.
- **PTY**: in-process `Bun.Terminal` adapter behind the existing
  `StationTerminalProcess` interface, in both dev and compiled modes (the PTY
  consumer always runs under bun already). `STATION_PTY_IMPL=bridge` keeps
  the legacy bridge for one release as an escape hatch.
- **SQLite**: `apps/observer/src/sqlite/driver.ts` chooses the driver at
  module load on `typeof Bun !== "undefined"` — `bun:sqlite` under bun,
  `node:sqlite` under Node (vitest lanes unchanged).
- **Hooks**: generated provider hook scripts keep the PATH-name
  `stn-ingress` default — a name survives binary upgrades where an absolute
  versioned path would not. Every install channel ships `stn-ingress` as a
  symlink to `stn`; the binary routes on argv0.

## Stage 0 — Spikes

Timebox each to half a day; record findings in this doc under a `## Spike
results` section (create it with the first result). Work happens on a scratch
branch that is never merged; only the doc update lands.

### S1 — Bundle graph (highest risk; unblocks A4)

Procedure:

1. `pnpm build`; extend the link script by hand:
   `ln -sfn ../../../apps/cli station/node_modules/@station/cli` (and
   observer).
2. Scratch entry `station/src/bin/spike.ts`:
   `import { runCli } from "@station/cli"` + `import` of
   `../dashboardRenderer/main.tsx`, dispatching on argv.
3. `bun build --compile --define STATION_BUILD_VERSION='"0.0.0-spike"' --define STATION_BUILD_COMPILED=true station/src/bin/spike.ts --outfile /tmp/stn-spike`.
4. Run `/tmp/stn-spike --version` from an empty directory, and the dashboard
   entry with `STATION_SOURCE=mock`.

Pass: binary builds; `--version` prints; dashboard renders against the mock
source; no module resolves to a `.d.ts`. Fail modes and fix ladder for the
`.d.ts` `paths` hazard: (a) delete the `paths` block from
`apps/cli/tsconfig.json` and let `moduleResolution: bundler` resolve through
node_modules `exports` (verify `tsc --noEmit` still passes — the block may be
legacy); (b) repoint entries at `dist/index.js`; (c) last resort, a
`Bun.build()` JS-API pass with a resolver plugin. Also confirm here:
`jsxImportSource: "@opentui/react"` applies to bundled `.tsx`, and the
opentui dylib is embedded (run from a machine path with no
`node_modules` nearby).

### S2 — `Bun.Terminal` flow control and drain ordering (unblocks A2)

Procedure: spawn `cat /tmp/500mb-file` into a `Bun.Terminal` whose `data`
callback sleeps 5ms per chunk; watch RSS.

Pass criteria:

- Memory stays bounded (kernel PTY backpressure) OR the instance exposes a
  usable pause/resume (probe `controlFlags`/`inputFlags`/`localFlags` and any
  undocumented methods).
- Short-lived commands (`printf` burst then exit) deliver **complete** output
  before the exit event — the bridge's drain-before-exit comment exists
  because `process.exit` used to truncate final bursts.
- `resize` below the bridge floors (cols 2 / rows 1) doesn't throw — else the
  adapter clamps like the bridge does.
- Closing the terminal while the child lives kills the child (this replaces
  the bridge's stdin-close backstop); no orphaned shells after the harness
  process is SIGKILLed.

### S3 — macOS Gatekeeper (unblocks A5)

Ad-hoc `codesign` per bun's compile docs (JIT entitlements), then simulate a
download: `xattr -w com.apple.quarantine "0081;…" stn` and launch. Pass: runs
without a Gatekeeper block on macOS 14+. Notarization is out of scope; note
findings for the release checklist.

### S4 — `import.meta.main` under bundling (unblocks A3)

Bundle an entry importing a module that guards top-level execution with
`if (import.meta.main)`. Pass: entry sees `true`, imported module sees
`false`, and the same file still runs standalone under `bun --hot`.

### S5 — Detached self-spawn on Linux (folds into A4's CI smoke)

`spawn(process.execPath, ["__observer", …], { detached: true })` from the
compiled binary on ubuntu; observer survives parent exit. Expected fine;
cheap to confirm in CI rather than locally.

## Stage 1 — Foundation (Track A, phase A1)

Lands green on today's CI with zero behavior change. No compile anywhere yet.

**Create `packages/runtime/src/buildInfo.ts`** (export from
`packages/runtime/src/index.ts`):

```ts
// Injected by `bun build --compile --define STATION_BUILD_VERSION=... --define STATION_BUILD_COMPILED=true`.
declare const STATION_BUILD_VERSION: string | undefined;
declare const STATION_BUILD_COMPILED: boolean | undefined;

export type StationBuildInfo = { version: string; compiled: boolean };

export function stationBuildInfo(): StationBuildInfo {
  return {
    version: typeof STATION_BUILD_VERSION === "string" ? STATION_BUILD_VERSION : "0.0.0-dev",
    compiled: typeof STATION_BUILD_COMPILED === "boolean" && STATION_BUILD_COMPILED,
  };
}

export function isCompiledBinary(): boolean {
  return stationBuildInfo().compiled;
}
```

Scalar defines, not a JSON object; the `typeof` guards keep dev tsc output
valid under Node, and the expression survives verbatim into
`packages/runtime/dist`, where a later compile's `--define` still rewrites it.

**Create `apps/observer/src/sqlite/driver.ts`** plus a minimal ambient
`bun:sqlite` module declaration (so tsc needs no `@types/bun`):

```ts
export type SqlParam = string | number | bigint | null | Uint8Array;
export type SqlStatement = {
  run(...params: SqlParam[]): void;
  get(...params: SqlParam[]): unknown; // normalized: undefined when no row
  all(...params: SqlParam[]): unknown[];
};
export type SqlDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
};

// Branch on runtime, NOT on import failure: require("node:sqlite") under bun
// silently exits the process, so it must never be evaluated there.
export const openSqlDatabase: (path: string) => SqlDatabase =
  typeof Bun !== "undefined"
    ? adaptBunSqlite((await import("bun:sqlite")).Database)
    : adaptNodeSqlite((await import("node:sqlite")).DatabaseSync);
```

The bun adapter normalizes `get()` `null` → `undefined` and maps
`exec`/`prepare`/`close` 1:1 — the whole consumed surface, verified against
`apps/observer/src/sqlite.ts`.

**Modify:**

- `apps/observer/src/sqlite.ts` — `DatabaseSync` → `SqlDatabase` via the
  driver; `ObserverSqliteHandle.database: SqlDatabase`.
- `apps/observer/src/persistence/*.ts` (~10 files) — type-import swap only;
  they use nothing beyond exec/prepare/run/get/all.
- `apps/observer/src/runtime/main.ts` — pass
  `version: stationBuildInfo().version` into `createObserverCore`, fixing the
  hardcoded `"0.0.0"` default (`apps/observer/src/reconcile/core.ts`) so
  observer health carries a real version (contract field already exists).
- `apps/cli` — `stn --version` prints `stationBuildInfo().version`.

**Tests:** vitest driver-mapping units (node driver — lanes unchanged); one
bun-lane test file run by the station-bun CI job (`bun test`) opening the bun
driver, running a migration-shaped exec/prepare round trip, and asserting
`get()` with no row is `undefined`; observer-core unit asserting health
`version` equals the injected build version.

## Track A — packaging (remaining phases)

### A2 — `Bun.Terminal` PTY adapter (two PRs: opt-in, then default flip)

`station/src/terminal/pty/bunTerminalProcess.ts` implementing
`StationTerminalProcess` (same MIN_COLS=2/MIN_ROWS=1 clamps as the bridge);
extract the listener/pending-data/diagnostic machinery from
`LocalPtyTerminalProcess` into a shared emitter module;
`createLocalPtyTerminal` becomes a selector. **A2a** lands the adapter
opt-in only (`STATION_PTY_IMPL=bun` selects it; default stays the bridge)
so it can be daily-driven without commitment. **A2b** is a one-line default
flip (`Bun.Terminal` present and `STATION_PTY_IMPL !== "bridge"` → adapter)
after at least a week of real use with no bridge fallbacks — flipping back
is a one-line revert, and `STATION_PTY_IMPL=bridge` stays the in-field undo
that needs no rebuild.
`defaultShell`/`defaultShellArgs`/`createPtyEnv` stay put (host reuses them).
Flow control per S2 findings; cap the pre-listener pending buffer
(drop-oldest + diagnostic) so a listener-less pane can't OOM. A2a runs the
new adapter cases (completeness-on-fast-exit, clamp, kill-on-dispose,
env-scrub) against the opt-in path; A2b repoints the default pty tests
(`localPtyTerminal.test.ts`, `ptyPipeline.smoke.test.ts`) at the adapter.
Bridge and its hardening test stay until A6.

### A3 — self-exec seam + hidden dispatch (dev behavior unchanged)

`apps/cli/src/selfExec.ts` (`selfExecArgv(entry)` returning
`[process.execPath, entry]` when compiled, `undefined` in dev). Register
hidden registry routes `__observer` (→ `runCliObserverMain`) and `__ingress`;
argv0 compat in `apps/cli/src/main.ts`
(`basename(process.argv0) === "stn-ingress"` → `__ingress`). Rewrite each
spawn site as `selfExecArgv(...) ?? <current dev command>`:

- `apps/cli/src/observerProcess.ts` `defaultSpawnObserver` (also introduce a
  single `resolveObserverSpawnCommand` seam — Track B2 reuses it for boot
  logging).
- `apps/cli/src/ingress/observerStartup.ts` + `ingress/command.ts` —
  generalize `observerEntryPath` to `observerCommand: string[]`.
- `apps/cli/src/commands/tui.ts` `spawnRenderer` — compiled:
  `[process.execPath, "__tui"|"__dashboard"]`, skipping the
  `isStationUiInstalled()` preflight; dev: `bun run --cwd station` as today;
  `STATION_DASHBOARD_COMMAND` wins in both modes.
- `apps/cli/src/observerProviders.ts` `resolveStationHostEntry` +
  `integrations/terminal/station/src/host/ensureHostRunning.ts` — generalize
  `{bunCommand, hostEntry}` to `hostCommand: string[]`.
- `apps/cli/src/commands/notify/focusAction.ts` and
  `commands/registry/popup.ts` — compiled: `[process.execPath]` alone (never
  bake a bunfs argv[1] into a command string).
- `integrations/harness/scripted/src/launch.ts` — compiled: `"node"` on PATH
  (test-only integration); dev: `process.execPath`.

Refactor `station/src/main.tsx`, `station/src/dashboardRenderer/main.tsx`,
`station/src/host/hostMain.ts` into exported run functions executed under
`if (import.meta.main)` (per S4), and swap the ~8 `Bun.env` uses to
`process.env`.

### A4 — compile entry + build script + CI smoke

`station/src/bin/stnMain.ts` (dispatch `__tui`/`__dashboard`/
`__station-host` before delegating everything else to `runCli`);
`scripts/build-binary.mjs` + root `build:binary` script:
`pnpm build` → extended `link-station-packages.sh` (adds `@station/cli`,
`@station/observer` app links) → `bun build --compile --minify --sourcemap
--define … station/src/bin/stnMain.ts --outfile dist-bin/stn` → smoke
`dist-bin/stn --version`. New CI `binary-smoke` job: version/help,
`stn setup check --json` in a temp HOME, an observer round trip through the
binary in an isolated state dir, and an ingress receipt. Note:
`apps/cli/src/observerReap.ts`'s ps-matcher must learn the compiled argv
shape (`["stn", "__observer", …]`) alongside `observerMain.js`.

### A5 — release pipeline (private distribution)

`.github/workflows/release.yml` on `v*` tags; native-runner matrix
(macos-14 → darwin-arm64, macos-13 → darwin-x64, ubuntu-24.04 → linux-x64,
ubuntu-24.04-arm → linux-arm64 — native runners avoid cross-compile issues
with per-platform `@opentui/core-*` optional deps); per job: build → ad-hoc
codesign (macOS, per S3) → `stn-v{ver}-{os}-{arch}.tar.gz` containing `stn` +
`stn-ingress` symlink; fan-in writes `SHA256SUMS` and `gh release create`.
Distribution while private: `scripts/install.sh` downloads via
authenticated `gh api` (documented requirement: `gh auth login` or a token);
binary Homebrew formula `packaging/homebrew/station-bin.rb.template` with
per-platform url/sha blocks and `bin.install_symlink "stn" => "stn-ingress"`
(tap needs a token-backed download strategy until the repo is public); the
source formula template gets a superseded header. Public curl-install is
deferred by decision, not design — the same artifacts serve it later.

### A6 — cleanup (after one release on the new PTY path)

Delete `localPtyBridge.cjs`, the bridge selector branch,
`ensureSpawnHelperExecutable`, `repair-node-pty`, the `node-pty` dependency,
`localPtyBridgeHardening.test.ts`, `STATION_PTY_IMPL`, and `STATION_NODE`.
Keep `STATION_HOST_ENTRY`/`STATION_BUN`/`STATION_DASHBOARD_COMMAND` as dev
escape hatches.

## Track B — first-run guarantee

Independent of Track A until B3; B1/B2 improve today's source install
immediately.

### B1 — config-tolerant launch (bare `stn` reaches the TUI)

Decision: **in-memory defaults, write-on-configure** — never auto-write a
config stub. A stub poisons `stn setup`'s clean create path
(`configWriter.ts` only takes `renderNewSetupConfig` when config status is
`missing`, and the append path's guard rejects a stub that can't declare a
harness). The renderer (`station/src/config/stationConfig.ts`) and the
observer (`emptyConfig()` when spawned without `--config`) already tolerate
missing config; the CLI front door is the only intolerant layer.

Lift `emptyConfig` into `packages/config/src/firstRun.ts`
(`firstRunConfig()`); add `handleConfigError` hooks (existing mechanism,
pattern: `registry/doctor.ts`) to `registry/tui.ts` and `registry/popup.ts`
that catch **only** `CONFIG_FILE_NOT_FOUND` **without** an explicit
`--config`, print a one-line "starting with defaults — run `stn setup` to
add projects" notice, and run the tui/popup command with `firstRunConfig()`
plus `STATION_FIRST_RUN=1` in the renderer env. Broken config and explicit
`--config` keep the hard error. The renderer's existing empty-state
("No projects configured yet." + welcome intro) is the first-run screen.
Known gap: a config-less observer keeps serving `emptyConfig` after the user
later writes a config — B3's restart machinery closes this; until then the
setup success message says to restart.

### B2 — observer boot guarantee

All in `apps/cli/src/observerProcess.ts` unless noted:

- **Boot log**: replace `stdio: "ignore"` with stdout/stderr → 
  `<stateDir>/logs/observer-boot.log` (rewritten per boot attempt, 0600,
  header line with the exact spawn command).
- **Fail-fast**: race `waitForObserverHealth` against child exit; a child
  that dies pre-health yields immediate `OBSERVER_EXITED_ON_START` with a
  15-line boot-log tail in the hint — kills the silent 30s hang (missing
  entry, bad node, crashed migration).
- **Bounded wait**: default health timeout 30s → 10s; progressive stderr
  messages at ~1.5s ("Starting Station observer…") and ~5s (points at the
  boot log) from the tui/popup call sites only (the other seven
  `startObserver` sites and the hook path stay silent).
- **Minimal incumbent eviction**: on `startObserver` finding an unhealthy
  socket, evict **only** when the probe error is `PROTOCOL_SCHEMA_MISMATCH`
  with a provably **older** incumbent schema (plumb the incumbent's
  `schemaVersion` onto the mismatch SafeError in
  `packages/protocol/src/client.ts`): best-effort `stop` RPC, then SIGTERM
  the socket holder via the reap module's socket-holder lookup, wait ≤3s,
  reclaim. Never evict hung-but-possibly-healthy or newer-schema incumbents
  (newer → "upgrade stn" error). Escape hatch `STATION_NO_OBSERVER_EVICT=1`.
  Forward-compatible with singleton 3d: the SIGTERM becomes a negotiated
  step-down behind the same function.

### B3 — version-aware upgrades (needs A1's real version)

- `startObserver` on a **running** observer: if the CLI is a real release
  (`!== "0.0.0-dev"`) and the observer's health version is older, one-shot
  `restartObserver` (self-terminating: the restarted observer reports the
  new version). Dev builds never auto-evict, so parallel checkouts sharing
  the default socket don't fight.
- Renderer exit code 86 = "restart observer": on `halted` +
  `PROTOCOL_SCHEMA_MISMATCH` the TUI offers "press R to restart the
  observer"; R exits 86; the CLI parent restarts the observer and respawns
  the renderer exactly once (a second 86 exits with upgrade copy — the
  mid-session mismatch case usually means a newer stn owns the socket).

### B4 — setup and doctor re-tiering (surgical)

In `apps/cli/src/commands/setup/planner.ts`: worktrunk, tmux, diffnav,
git-delta, agent CLI, git-project, and config-**missing** move
`required` → `recommended`, each message naming the feature it gates
("worktree sessions", "See diff (split right)", …); config-**invalid** stays
required. Bun + station-UI checks and doctor's `rendererRuntimeCheck`
(`BUN_RUNTIME_MISSING`/`STATION_UI_NOT_INSTALLED`) are skipped when
`isCompiledBinary()`. `nextSteps` puts bare `stn` first once required-ok.
Update `setup-profiles` fixtures; add a container-lane `binary-only` profile
(docs/setup-testing.md) asserting launchable-but-features-missing, plus a
first-run smoke: bare `stn tui` with `STATION_DASHBOARD_COMMAND=true` so the
config-less boot + observer spawn + health path runs unmocked in CI without
a TTY.

## Landing order

```
A1 foundation ─┬─► A2a/A2b pty adapter ─► A3 self-exec ─► A4 compile+smoke ─► A5 release ─► A6 cleanup
               └─► B3 version-aware upgrades
B1 config-tolerant launch ─► B2 observer boot guarantee ─► B3 ─► B4 re-tiering
```

Suggested merge order: A1 → B1 → B2 → A2a → A3 → B3 → A4 → A2b → B4 → A5 → A6.
Stage 0 spikes precede A2/A3/A4/A5 as marked; S1 findings may add a small
"fix tsconfig paths" pre-phase.

## Experimentation and exit strategy

The plan's safety model is not "be careful" — it is that every phase has a
defined place to experiment, a merge gate, and an undo that does not depend
on memory. Three global rules, then the per-phase table.

**Experimentation protocol (applies to every spike and phase):**

1. Exploratory work happens in a scratch clone or worktree on a throwaway
   branch. Experimental builds are never `pnpm link --global`ed, never run
   `stn hooks install`, and always run against an isolated state dir and
   socket (`--state-dir`/`--socket` into a scratch path;
   `station/scripts/station-isolated.sh` and the container lane in
   [setup-testing](setup-testing.md) exist for this). The directory is not
   the isolation mechanism — the env is: the catastrophe mode is an
   experimental observer binding the shared default socket and draining
   real spool events.
2. No phase in this plan adds a sqlite migration or rewrites external
   provider hook configs. That is a constraint, not an observation — the
   PATH-name `stn-ingress` decision exists precisely so upgrades *and
   rollbacks* never touch files outside the repo and state dir. A phase
   that needs to violate this gets re-designed or split first.
3. Every phase is one PR (A2 is two) whose revert must not require
   reverting a later phase. Seams introduced early (`selfExecArgv`, the
   sqlite driver, the pty selector) default to legacy behavior, so
   reverting a consumer never strands a seam.

| Phase | Experiment where | Merge gate | Undo after merge | Abandon signal |
|-------|-----------------|------------|------------------|----------------|
| S1–S5 | Scratch clone, isolated state dir; binaries stay in `/tmp` | Nothing merges except findings in `## Spike results` | Delete the clone | Any hard fail → regroup at the doc level before writing code |
| A1 | Normal PR branch | Both CI lanes green + bun driver test; zero behavior change asserted by existing suites | `git revert` — no schema change, health `version` is additive | bun:sqlite drift the adapter can't normalize |
| B1 | Normal PR branch | Integration tests: missing-config launches, broken-config still exits 1 | `git revert` — no persisted state | — |
| B2 | Scratch clone for real-spawn testing (isolated state dir), then PR | Container first-run profile passes unmocked | `git revert`; in-field: `STATION_NO_OBSERVER_EVICT=1`, `--timeout-ms`; leftover `observer-boot.log` is inert | Eviction ever firing outside a schema mismatch |
| A2a | Daily-drive via `STATION_PTY_IMPL=bun` in your own shell | Adapter test cases green; S2 criteria met | Default untouched — stop setting the env var | Any pane corruption/orphan → stay on bridge, record in doc |
| A2b | — (one-line flip) | ≥1 week daily driving A2a with zero bridge fallbacks | One-line revert; in-field: `STATION_PTY_IMPL=bridge` without rebuild | — |
| A3 | Normal PR branch | Existing integration suites byte-identical (dev mode returns `undefined` from `selfExecArgv`); dispatch unit tests | `git revert` — compiled mode doesn't exist yet, so the code is dormant | — |
| B3 | Normal PR branch | Version-compare unit + renderer-86 loop tests | `git revert`; dormant on dev builds (`0.0.0-dev` never restarts) until A5 ships real versions | — |
| A4 | Scratch clone for compile iteration; PR adds entry + script + CI job | `binary-smoke` job green | `git revert` / delete the job — source installs untouched, binary is an artifact nobody installs | S1-class bundler failure resurfacing → back to spike |
| B4 | Normal PR branch | setup-profiles fixtures + container `binary-only` profile | `git revert` — tier constants and fixtures only | — |
| A5 | Tag on a scratch prerelease (`v0.x.y-rc.N`) | Install script round-trips on a clean machine/VM via gh auth | Delete release + tag; nothing auto-updates, formula/installer are opt-in | Gatekeeper or install ergonomics unresolvable → stay on source installs |
| A6 | — | **Point of no easy return** (deletes bridge, node-pty, repair scripts): require one full release cycle daily-driven on the `Bun.Terminal` path with zero `STATION_PTY_IMPL=bridge` fallbacks | Restoring the bridge means reverting a deletion PR — possible but demoted to code archaeology after upstream drift | — |

Until A6, abandoning the entire effort at any point leaves main in a state
that is strictly better than today (A1's real version, B1/B2's first-run
fixes stand alone) with no dead machinery beyond dormant seams.

## Risk register (ranked)

1. **Bundler vs `apps/cli` `.d.ts` `paths`** — silent empty modules in the
   compile graph. Spike S1; likely fix is deleting the legacy paths block.
2. **`Bun.Terminal` flow control / drain ordering** — unbounded memory on
   firehose panes; truncated output of short-lived commands. Spike S2; the
   bridge stays selectable for one release.
3. **macOS Gatekeeper** for downloaded binaries. Spike S3; ad-hoc sign in
   CI, notarization deferred.
4. **Private-repo distribution ergonomics** — gh-auth requirement for
   installs; tap needs a token-backed download strategy. Accepted by
   decision; artifacts are public-ready.
5. **bun:sqlite semantic drift** (null vs undefined, integer width) —
   covered by the bun-lane driver test.
6. **Cross-schema eviction on shared dev sockets** — mitigated: evict only
   provably-older-schema, never dev builds, `STATION_NO_OBSERVER_EVICT=1`,
   everything logged.
7. **10s health timeout on slow cold starts** — progressive message names
   the boot log; `--timeout-ms` still overrides; fail-fast means only
   genuinely slow (not dead) observers reach the timeout.
8. **Renderer exit-code 86 collision** — a crash exiting 86 triggers one
   spurious observer restart; bounded to a single retry.

## Verification strategy

- Per-phase vitest fake-seam integration tests
  (`apps/cli/test/integration/`, the `runCli(argv, { observerDeps, tuiDeps })`
  pattern) — dispatch, config-error hooks, fail-fast, eviction, version
  restart, renderer-86 loop.
- Bun-lane tests (`station/` + the A1 bun driver test) for sqlite driver and
  PTY adapter behavior.
- CI `binary-smoke` job (A4) exercising the compiled binary end to end
  minus TTY.
- Container-lane `binary-only` profile (B4) running the real first-run path
  unmocked.
- Manual fresh-machine smoke: `HOME=$(mktemp -d) stn` must reach the TUI
  with a connected observer and the first-run screen.
