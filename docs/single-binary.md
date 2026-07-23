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
  [observer-singleton](observer-singleton.md). This plan uses shipped
  3c/3d-a/3d-b/3e; it does not add a second,
  uncoordinated eviction path (v1 did — removed, see F3).
- **Replacing the dev workflow.** Dev mode (tsc dist under Node +
  `bun --hot` TUI from source) stays byte-identical; compiled mode is new
  dispatch layered on build-time defines.

## Supported platforms, versions, and artifact policy

Pinned so the release job, install script, and acceptance suite agree.

| Axis | Policy |
| ------ | -------- |
| Targets | `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. No Windows. |
| Build runners | Native per target (no cross-compile — only the host-matching `@opentui/core-*` optional dep installs). Use *currently available* GitHub-hosted labels resolved at implementation time; do **not** hard-code `macos-13` (F9 — Intel macOS labels are being retired). Pin exact labels in the workflow with a comment naming the check date. |
| macOS floor | Match the oldest OS the chosen Intel/arm runners image supports; state it in release notes. |
| Linux floor | glibc only for v1.1 (bun's default). Declare the built-against glibc version (the runner's) as the floor; musl is a later target, not silently implied. |
| CPU | x64 uses Bun's explicit `-baseline` targets for older SSE4.2-era CPUs; arm64 = Apple/ARMv8. |
| Artifact | `stn-v{ver}-{platform}-{arch}.tar.gz`, using the target values above. **Manifest below is exhaustive.** |

**Artifact manifest** (every file the binary needs on disk that
`bun build --compile` does *not* embed — F8):

- `stn` — the compiled binary.
- `stn-ingress` — symlink → `stn` (argv0 dispatch).
- `stn-tmux-popup` — symlink → `stn`. Its argv0 identity (and the reserved
  `__tmux-popup` token) remains the complete CLI fallback. The optional binding
  written by compiled `stn setup` owns the warm direct-attach path for default
  popup geometry; custom geometry and explicit `--config` setup use this exact
  config-aware sibling alias. First use or invalid fast state also invokes the
  alias. The source POSIX launcher remains unchanged for development installs.
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
├── __tmux-popup            → full popup CLI fallback for the stn-tmux-popup alias
├── default setup binding   → direct warm tmux attach/toggle, then the alias fallback
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
- **Installed popup ownership** is the canonical directory containing the
  running compiled executable. The composition root resolves it once and wires
  it into both popup registration and setup binding generation. Source launches
  instead derive a canonical checkout root from the real CLI module path; a
  virtual compiled module path and filesystem root `/` are never accepted as
  popup ownership.
- **Runtime-mode seam** `packages/runtime/src/buildInfo.ts`: build-time
  defines `STATION_BUILD_VERSION` / `STATION_BUILD_COMPILED` /
  `STATION_BUILD_IDENTITY` behind `typeof` guards. Source output reads the
  atomically published `station-build-id` sidecar and reverifies its repository
  inputs plus production package outputs; compiled and source output from the
  same whole-repository build therefore produce the same Observer selector while
  retaining `{ version: "0.7.1-rc.6", compiled: false }` display semantics.
  Self-spawns route through `selfExecArgv(target, developmentArgv)`: compiled →
  `[process.execPath]` for CLI or `[process.execPath, internalToken]` for an
  internal target; dev → today's command. All
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
- **Hooks** persist the resolved absolute `stn-ingress` sibling supplied by
  compiled composition; every channel ships that symlink, and standalone/full
  doctor validate the same generated command expectation.

## `launchReady` vs `workflowReady` (F11 — don't weaken setup truth)

Rather than move required checks to `recommended` (v1's B4, which erodes
what "required" means), split the setup summary into two truths:

- `launchReady` — the binary can start the TUI + observer. Needs: the
  binary itself and a writable state dir; compiled mode also proves that
  extracted executable assets can run there. Nothing else. Bare `stn` gates
  on this.
- `workflowReady` — core worktree workflow prerequisites: Git, worktrunk,
  tmux, diffnav, git-delta, the effective default/selected agent CLI, valid core
  config, and current Station-owned tracking artifacts for required Claude,
  Codex, Cursor, or OpenCode harnesses. Artifact preparation does not prove
  provider trust or runtime event delivery. It is independent of the current
  directory and remains true with zero projects;
  choosing a project is the next TUI onboarding state. `stn setup` reports
  missing prerequisites as unmet *capabilities*, not as "broken."

Setup represents artifact preparation with per-harness checks and never labels
that state runtime Ready. Pi remains exempt from an invented external artifact
requirement because its extension is composed in process.

Each check keeps its real status; `stn setup check --json` gains both
booleans and retains `requiredOk` as an alias of `workflowReady`. The compiled
launch path enforces the same writable/executable-state prerequisite without
running the full setup suite before first paint. Bun, station-UI, Xcode
build-tool, and `rendererRuntimeCheck` checks are skipped when
`isCompiledBinary()`. Surfacing dynamic `workflowReady` details inside the TUI
is deferred until those facts have a proper runtime data boundary; setup JSON
remains their authority.

## Phases

### A1 — foundation: buildInfo + SQLite driver + real observer version

**Status: implemented.** The mandatory `pnpm test:sqlite:bun` gate covers the
SQLite driver contract and Node-to-Bun and Bun-to-Node database compatibility.

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

Feed `stationBuildInfo().version` into snapshot and `stn --version` display.
Source processes verify that build info at most once, while Observer health and
pidfile ownership publish `stationObserverBuildVersion()` so handoff also proves
immutable build identity.

**Tests:** vitest driver-mapping units (node); a bun-lane test (`bun test`)
for the bun driver asserting `run().changes`, `get()`-no-row `undefined`,
integer round-trip, and WAL; and a **cross-runtime test**: a DB *created*
by the node driver, then *opened and read* by the bun driver (and vice
versa), proving migration/schema compatibility across the two engines.

### A2 — `Bun.Terminal` PTY adapter + controlling-terminal helper (two PRs)

**A2a status: implemented.** `station/src/terminal/pty/bunTerminalProcess.ts`
implements `StationTerminalProcess`, and the bridge and Bun adapters share one
emitter that retains early output and exit state. The payload command is spawned
through a **ctty helper** (S2, F6): `setsid()`,
`ioctl(STDIN_FILENO, TIOCSCTTY)`, `execvp(payload)`.

A2a checks in one portable POSIX C source. `bun run build:ctty-helper` uses the
target's native `cc` to write the ignored development executable at
`station/dist/ctty-helper`; no built helper is committed. Platform headers
supply `TIOCSCTTY`, so TypeScript contains no platform ioctl constants. The
pre-push gate compiles and tests that source natively on the developer's current
platform, while hosted CI covers Linux and macOS across x64 and arm64.
The helper stays C because it is a small direct wrapper over POSIX `setsid`,
`ioctl`, and `execvp`; Zig or Rust would add a build toolchain without improving
that boundary.

`createLocalPtyTerminal` is now a selector: unset, empty, or `bridge` preserves
the Node/node-pty default; `bun` uses `Bun.Terminal` through the helper; and
`bun-nocctty` explicitly launches without it. A missing, non-executable, or
`noexec`-blocked helper is an actionable error, never an automatic fallback to
`bun-nocctty`. The degraded mode does not carry shell job-control or
orphan-cleanup guarantees.

The per-platform gate uses a real PTY to verify Ctrl-Z suspends and `fg`
resumes, a `SIGKILL` of the Station owner leaves no orphaned pane child, and
`terminal.close()` is paired with an explicit `child.kill()` (S2: close alone
does not kill). These checks remain release-blocking after the default flip.

**A2b status: implemented for compiled binaries by A4.** An unset selector in a
compiled TUI or station-host resolves to the packaged `bun` implementation;
source development deliberately continues to default to `bridge`. In-field
undo for binary users is the explicit degraded `STATION_PTY_IMPL=bun-nocctty`
mode plus reverting the compiled activation — **not** the source-only bridge.
Bridge removal remains A6 work after a full release cycle.

### A3 — self-exec seam + raw-argv dispatch

**Status: implemented.** `apps/cli/src/selfExec.ts` exports `SelfExecTarget`,
`ExecutableArgv`, `SelfExecRuntime`, `selfExecArgv`, `SelfExecRunners`, and
`dispatchSelfExec`. Source mode preserves each supplied executable tuple;
compiled mode maps it to the binary plus an exact internal token. The raw
dispatcher gives `stn-ingress` argv0 precedence, consumes exactly one known
internal token, and sends unknown `__*` values to the normal CLI unchanged.
A3 exports and tests this dispatcher; A4 owns the compiled entry that composes
its runners.

The callable process entries are `runCliMain`, `runCliObserverMain`,
`runCliIngressMain`, `runStationMain`, `runDashboardMain`, and
`runStationHostMain`. Their modules and the Observer runtime now use
`import.meta.main`, supported by the source-development Node.js floor of 24.2.
Station-local environment reads use `process.env`.

Migrated launch sites are Observer lifecycle spawn; provider-ingress
auto-start; Station/dashboard launch; CLI-composed Station Host launch through
the terminal adapter; notification focus actions; and nested popup TUI
commands. The host and ingress boundaries receive finalized executable tuples
and append only their operation-specific flags. The scripted harness remains
an on-disk development/test runner: there is no `__scripted` mode.

`__tmux-popup` was reserved with an injected runner. A4 now binds it, and the
`stn-tmux-popup` argv0 alias, to the existing CLI popup command while leaving the
source POSIX launcher unchanged.

### A4 — compile entry + build script + asset extraction + CI smoke

**Status: implemented.** `station/src/bin/stnMain.ts` composes
`dispatchSelfExec` with lazy route imports; `scripts/build-binary.mjs` and
`build:binary` build one native artifact with Bun 1.3.14. The compile command
carries **both** ambient-config disable flags (F1), version/compiled/build-
identity defines, and the native target mapping; x64 selects Bun's `-baseline` targets.
`link-station-packages.sh` links the CLI and Observer applications.

A4 owns the packaged helper lifecycle that A2a deliberately leaves out:

- compile the one portable helper source natively for each target and embed the
  resulting executable alongside the Pi extension asset;
- extract the helper under `<stateDir>/run/assets/ctty/` and Pi extension under
  `<stateDir>/run/assets/pi/`, set private permissions, and verify size plus full
  SHA-256 before reuse;
- make extraction atomic and lock-guarded so racing panes cannot observe a
  partial helper;
- probe the extracted helper and surface a clear configured-state-directory
  diagnostic on `noexec`, without a temporary or no-ctty fallback;
- lease helper versions to live TUI/host processes and prune only unleased stale
  helper directories; and
- retain immutable content-addressed Pi bundles because an external Pi process
  may reload its extension path. Pi pruning waits for provider-process lifetime
  ownership rather than risking a live session.

Local pre-push and hosted `standard-ci` binary smoke checks: `--version`,
`--help`, exact popup alias symlinks, popup argv0 fallback routing, compiled
setup binding generation, and `setup check --json`
(asserting the `launchReady`/`workflowReady` split), an **observer round
trip through the binary** in an isolated state dir, an ingress receipt via
the `stn-ingress` symlink, the **hostile-directory RCE test** (F1), and the
**detached self-spawn** check (folds in S5). A stateful fake tmux proves that a
warm binding bypasses malformed config while keeping renderer and Observer PIDs
stable and that a failed fallback is silent and returns zero. From a committed
clean checkout, the smoke also builds an isolated detached-worktree binary with
one production-source delta at the same display version, queries both immutable
selectors, runs the lower identity as incumbent, proves higher-identity handoff,
then refuses a losing artifact's mutating command without recording it or
touching the replacement Observer, Station Host, or live PTY. The native PTY
test also proves the unset compiled selector launches a payload through the
extracted helper on the current platform. The physical Observer socket is also
made mode `000`: status/start/restart/doctor and `stn-ingress` must preserve its
PID, inode, pidfile, and holder set, spool exactly one hook, then reconnect to the
same process and drain it after mode `0600` is restored. `observerReap.ts` and the same-TTY UI
reaper recognize the exact compiled process shapes.

### A5 — release pipeline (private, deterministic, verifiable)

**Status: implemented.** `.github/workflows/release.yml` runs on `v*` tags.
It requires release SemVer without `+` build metadata, exact agreement between
the tag and root package version, ancestry from `origin/main`, and a tag with no
existing GitHub release. An administrator must enable GitHub immutable releases
before tagging; `GITHUB_TOKEN` cannot read that administration setting, so the
workflow cannot enforce the precondition itself. It then reuses the callable
`standard-ci` gate, runs
`pnpm smoke:release`, and builds natively on the four dated runner labels
checked on 2026-07-11: `ubuntu-24.04`, `ubuntu-24.04-arm`,
`macos-15-intel`, and `macos-15`.

Each native job runs the full binary smoke and uploads one archive:

- `stn-v{version}-linux-x64.tar.gz`
- `stn-v{version}-linux-arm64.tar.gz`
- `stn-v{version}-darwin-x64.tar.gz`
- `stn-v{version}-darwin-arm64.tar.gz`

Here `{version}` is the package version without the tag's leading `v`, for
example `stn-v0.7.1-rc.6-darwin-arm64.tar.gz`.

Every archive contains exactly `stn`, the `stn-ingress` and
`stn-tmux-popup` symlinks, and `LICENSE`. The aggregate job rejects missing or
duplicate targets, emits a stably sorted `SHA256SUMS`, and creates a GitHub
release **draft** without clobbering an existing release. A second native
matrix revalidates the tag, fetches the installer by the validated commit SHA
through the authenticated Contents API, invokes it with the explicit tag against
that real draft, and verifies the binary version, both argv0 aliases, license,
and launch without Node or Bun on the runtime PATH. The four native builds use
one archive-packaging helper, and the draft-install matrix consumes those exact
uploaded archives. Publication remains a manual decision after the real-TTY
acceptance below. GitHub's tag endpoint
exposes published releases only, so the workflow captures the new draft's
numeric release ID from the authenticated release list and passes it only to
these acceptance jobs; normal installs keep using the latest/published-tag
endpoints.

After all native acceptance jobs pass, the release workflow re-downloads the
five draft assets, checks them against the build-generated `SHA256SUMS`, and
uploads an immutable `accepted-release-candidate-*` Actions artifact containing
the validated commit, workflow run/attempt, release ID, asset IDs, and checksums.
The manually dispatched `promote-release.yml` downloads that exact artifact,
rechecks the successful run, tag commit, draft identity, asset IDs, and hashes,
then publishes the unchanged draft. Draft assets cannot drift between acceptance
and promotion without failing that workflow.

`SHA256SUMS` is unsigned in A5 because no signing-key infrastructure exists;
the trust chain is authenticated GitHub access plus immutable release assets.
The pipeline pins inputs, gates, targets, names, and manifest, but does not
claim bit-for-bit reproducible Bun executables or archives.

`scripts/install.sh` supports latest stable, explicit `--version`, and
`--install-dir` (default `~/.local/bin`). The supported binary-install baseline
starts at `v0.7.1-rc.2`; the earlier `v0.7.0` and `v0.7.1-rc.1` candidates
remained unpublished.
Explicit installs set a tag, fetch
`scripts/install.sh` from that tag through the authenticated Contents API, and
invoke it with `--version` set to the same tag. Latest install first resolves
the latest stable tag, then performs the same tagged fetch and explicit invoke.
There is no silent `main` fallback, so installer code and release artifacts are
always paired. `v0.7.1-rc.2` is the first published binary,
`v0.7.1-rc.5` is the latest published binary, and publishing `v0.7.1-rc.6`
makes immutable rollback to `v0.7.1-rc.5` available.

The installer uses authenticated `gh api` release endpoints, accepts only the
four supported targets, verifies the one matching `SHA256SUMS` entry and exact
archive manifest before touching an existing install, and stages replacement
on each destination filesystem. Every potentially blocking `gh` operation is a
tracked file-backed child rather than a command substitution.

The staged binary's `--version` probe has a 10-second supervised deadline and
a POSIX file-size limit on stdout/stderr. Watchdog exit 124 reports timeout;
125 reports timer machinery failure. Cleanup sends TERM, waits one second,
sends KILL if needed, and reaps the probe without depending on a marker file.
Compatibility failures show at most 4096 sanitized bytes of stderr. Common
GitHub and Actions token variables are removed from the probe environment, and
the existing Station installation was unchanged before activation.

The command lock is `<install-dir>/.station-install.lock`; the license lock is
`<data-home>/station/.station-install.lock`. Their sole owner files—
`<install-dir>/.station-install.lock/owner-*` and
`<data-home>/station/.station-install.lock/owner-*`—record the PID, requested
tag or `latest`, and the token embedded in each filename. Cleanup removes only
its token-specific owner file and revalidates the lock-directory inode so it
cannot remove a replacement owner's lock. The installer acquires the
command lock first and the license lock second, skips a duplicate path, and
releases in reverse order. An existing
lock causes a fail-fast refusal before release requests; a license-lock refusal
releases the command lock and performs no release API request. The message
names the lock and readable owner PID, states that the existing Station
installation was unchanged, and tells the user to wait before retrying. The
installer never auto-reclaims a possibly active lock. An operator may remove
either abandoned lock manually only after reading its sole owner file and
confirming that no installer process with the recorded PID is alive, then
retry. A legacy lock with one `owner` file remains readable for refusal.

Existing exact `stn-ingress` and `stn-tmux-popup` symlinks remain stable; a
missing alias is considered created only after `ln` succeeds and cleanup
removes it only while it still exactly matches this attempt. Immediately before
commit, both aliases are revalidated as symlinks to `stn` and binary/license
destinations are revalidated against their accepted types. The previous license
is backed up, the new `LICENSE` is installed, and the verified staged `stn` is
atomically renamed last as the sole runtime commit point.

A caught HUP, INT, or TERM forwards to the active child, runs bounded
TERM/KILL/reap cleanup, and exits 129, 130, or 143. If a failed final rename
leaves staged `stn`, pre-commit rollback restores the license and matching new
aliases and reports the install unchanged. If staged `stn` disappeared,
activation may be committed: preserve the new license and aliases, exit
nonzero, print an absolute `stn --version` inspection command, and do not claim
the previous installation was unchanged. After commit, cleanup failures are
warnings.

SIGKILL cannot run cleanup and may leave either lock or a stage. Atomic rename
still gives coherent process-level visibility to continuous readers. Power loss
is not equivalent: the installer does not fsync files or containing directories
and therefore makes no post-power-loss durability guarantee; old/new
cross-filesystem `LICENSE` metadata may also remain. The deterministic
`smoke:install` suite exercises this boundary with fake authenticated release
assets and is part of `test:all`.

After success, all three bare launchers are resolved physically. If every one
points into the new install directory, the installer prints only
`Next: run stn setup`. Otherwise it names every missing or shadowed launcher,
prints one safely shell-quoted future-shell export for the user's chosen shell
configuration, prints a current-shell block that prepends the directory, runs
`hash -r`, and invokes `stn setup`, plus the absolute installed `stn` fallback.
The future-shell export appears only when physical current-process resolution
is incomplete. The installer never reads, selects, creates, or edits shell
startup files.

Candidate `v0.7.1-rc.6` promotes only after all four native targets pass
automated and manual acceptance, including upgrade and rollback against
published `v0.7.1-rc.5`. Published tags and assets are never deleted, moved, or
overwritten; a bad release rolls back explicitly and rolls forward to a higher
version containing the revert or fix.

Drafts are still mutable. Release notes record the workflow commit, while the
accepted-candidate artifact immutably records that commit plus the draft release
and asset identities. The manual promotion workflow re-fetches every asset,
compares its ID and digest to the accepted artifact, and publishes only that
unchanged draft; GitHub release immutability begins at publication.
An unpublished draft left by a transient workflow failure may be deleted and
the unchanged tag workflow rerun; a source fix uses a new prerelease tag, while
published releases are never deleted or mutated.

The source-based Homebrew formula remains separate and manually dispatched.
The default release `GITHUB_TOKEN` cannot trigger another workflow, and the tap
`COMMITTER_TOKEN` is intentionally not configured for A5; no binary Homebrew
formula is claimed until private asset authentication is proven there.

Implementation sources: the target and manifest policy above; the existing
[`build:binary` staging](../scripts/build-binary.mjs),
[`standard-ci` gates](../.github/workflows/standard-ci.yml), and
[`smoke:release`](../scripts/test-runners/run-release-smoke.mjs); the
redistribution requirement in [`LICENSE`](../LICENSE); B-host's shipped live
PTY refusal policy; and GitHub's official documentation for
[hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-private-repositories),
[reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[`GITHUB_TOKEN` permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token),
[release API draft visibility](https://docs.github.com/en/rest/releases/releases#list-releases),
and [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

### A6 — cleanup (after one release on the ctty PTY path)

Delete the bridge, node-pty, `repair-node-pty`, `STATION_NODE`, and their
tests, once the per-platform acceptance has been green for a full release
cycle. Keep `STATION_DASHBOARD_COMMAND` / `STATION_HOST_ENTRY` /
`STATION_BUN` as dev escape hatches.

## Track B — first-run guarantee

### B1 — config-tolerant launch

**Status: implemented.** Native and tmux launch routes both ensure the singleton
observer before presenting their first-run UI.

In-memory defaults, write-on-configure (no auto-written stub — it poisons
`stn setup`'s clean create path). Lift `emptyConfig` to
`packages/config/src/firstRun.ts`; add `handleConfigError` hooks on
`registry/tui.ts` + `registry/popup.ts` that degrade **only**
`CONFIG_FILE_NOT_FOUND` without an explicit `--config`; broken config and
explicit `--config` keep the hard error. The renderer's empty-state is the
first-run screen.

### B2 — observer boot guarantee (no eviction — F3)

**Status: implemented.** Observer launch atomically rewrites the private boot log at
`<stateDir>/logs/observer-boot.log`, captures a JSON-encoded command header plus
child stdout/stderr, and races health readiness against child exit. It reports
`OBSERVER_EXITED_ON_START` after a short convergence grace with that child's
redacted log tail unless a concurrent observer became healthy. The default
health wait is 10 seconds; only TUI and popup launches show delayed progress.

**Removed from v1:** client-side unhealthy-incumbent eviction. Singleton 3d-a
([#135](https://github.com/jeremy0dell/station/issues/135)) serializes child-side
ownership under `dirname(resolvedSocket)/observer.claim.sqlite`; 3d-b
([#137](https://github.com/jeremy0dell/station/issues/137)) now performs the
version-aware half of B3 inside that claim. CLI and provider-hook clients only
attach or spawn. They never signal an incumbent or mutate socket ownership
out-of-band.

### B-config — config activation (F4 — v1 was wrong)

**Status: implemented.** Guided `stn setup` and non-interactive
`stn setup apply --yes` activate every successfully written config, including
harness-only changes. Setup loads the completed file with its normalized path
and setup home, resolves its observer paths, and starts or restarts the observer
through the stable lifecycle facade. Completion is reported only after the
observer is running with the written config. Activation stays outside the apply
engine, so a lifecycle failure retains the successful write, exits nonzero,
preserves the lifecycle error, and points to `stn observer restart`.

New setup configs omit `observer.socket_path` while retaining
`observer.state_dir`. Config-less and configured startup therefore resolve the
same default or XDG socket, so an open TUI reconnects to the configured observer
without manual intervention. Existing configs and explicit socket overrides are
untouched.

### B3 — version + schema UX (scoped down)

**Status: implemented.** Same-version config activation uses B-config. Renderer exit code 86 =
"restart observer" on a `halted` + `PROTOCOL_SCHEMA_MISMATCH` state → the
CLI parent restarts once and respawns the renderer. Singleton 3d-b supplies
Observer ordering: exact immutable builds reuse; different builds at one
display version elect one verified replacement winner and refuse the loser;
same-version reuse refuses any missing legacy identity; and higher valid
SemVer replaces lower only after verified graceful handoff while lower-version
callers reuse the higher incumbent.

### B-host — station-host upgrade behavior (F7 — was undefined)

**Status: implemented.** Host health carries the Station build version as well
as the host protocol version. Build versions are opaque: a host is reused only
when both values exactly match the client. This deliberately does not infer a
SemVer compatibility range for a process that owns live terminals.

A current-protocol host from a different build supports one guarded lifecycle
operation: stop only if its complete PTY table is empty. The host checks all
agent and auxiliary PTYs and enters draining state atomically, so a concurrent
spawn cannot land between the empty check and shutdown. Once the response is
sent, the host closes. Observer-backed launch replaces it immediately; a plain
TUI boot starts the current host on demand when the next hosted terminal opens.
A host with a different protocol, or legacy health without a build version, is
never sent an unknown lifecycle request and is left running for explicit
operator recovery.

Live hosts are never replaced. `HOST_UPGRADE_BLOCKED` names the running and
requested builds and reports the live-terminal count; Station leaves the host,
PTYs, in-memory scrollback, socket, and saved layout untouched.
Reopen with the running build, finish or explicitly close those terminals, then
retry the upgrade. The host owns the PTY master handles and scrollback rings in
process, while attach transports only replay bytes and live frames, so seamless
handoff would require fd/state transfer or a persistent broker and remains a
larger protocol project.

Implementation basis: `packages/station-host/src/protocol.ts` defines the wire
surface; `station/src/host/ptyTable.ts` and `scrollbackRing.ts` prove PTY and
replay ownership is process-local; `station/src/terminal/pty/hostAttachedTerminal.ts`
shows reattachment targets the same socket and PTY id; `station/src/state/layout/layoutSnapshot.ts`
persists lookup identity but no process handle or scrollback; and
`integrations/terminal/station/src/host/ensureHostRunning.ts` owns daemon reuse,
replacement, and spawn decisions. Those current boundaries, rather than the older roadmap
assumption, determine the shipped refusal policy.

## Dependency graph

One graph replaces v1's two prose landing-orders.

```
A1 ─────────────┬─► A2a ─► A3 ─► A4 + compiled A2b ─► A5 ─► A6
 (buildInfo,     │
  sqlite,        │
  real version)  │
                 └─► B3 (schema/version UX) ◄── observer-singleton 3d-b
B1 ─► B2 ─► B-config ─► B3
              (config activation — headline UX)
B-host  (independent; needed before upgrade is advertised safe)

A2a: opt-in PTY + native helper gate    A3: raw dispatch
A4: packaged assets + compiled default   A2b: folded into A4
A5: release                              A6: cleanup

Satisfied dependency: observer-singleton 3d-a
  → required for serialized concurrent stale-socket startup.
Satisfied dependency: observer-singleton 3d-b
  → supplies verified older-version observer handoff.
```

Suggested merge order: A1 → B1 → B2 → B-config → A2a → A3 → A4/A2b →
B-host → A5 → A6. B3's version half is supplied by the singleton roadmap.

## Verification (F11 — prove the headline UX, not a proxy)

CI (every PR and `main`): the full pre-push gate on `ubuntu-24.04`, including
vitest, the Bun renderer, cross-runtime SQLite, real PTY, installer, and compiled
binary smoke coverage.

Native release CI: build, smoke, and draft-install the compiled binary on
`ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15-intel`, and `macos-15`.

CI smoke (A4): the binary end-to-end minus TTY, **including** the
hostile-directory RCE gate, detached self-spawn, and inaccessible-socket
preservation through the physical `stn` and `stn-ingress` entrypoints.

**Release acceptance (every target, on a clean box with no Node/Bun/
node_modules on PATH):** this is the gate v1 lacked. `STATION_DASHBOARD_
COMMAND=true` and `HOME=$(mktemp -d)` do **not** count — and note
`mktemp` HOME can still inherit an `XDG_RUNTIME_DIR` socket, so the harness
must scrub `XDG_RUNTIME_DIR`/`XDG_STATE_HOME` too. The manual/automated
flow:

1. Install in a clean default home with the directory missing from `PATH`,
   then with an older `stn` and one sibling launcher shadowing it → every
   mismatch is named, the one future-shell export and current-shell recovery
   block both evaluate safely, and the absolute fallback works. Repeat with
   startup files containing sentinel bytes, modes, and symlinks, plus custom
   install directories containing spaces and apostrophes; two installs must
   leave every startup path unchanged. Copy the export manually into a shell
   configuration chosen by the user, then verify a fresh shell physically
   resolves all three launchers. A normalized install path containing `:` must
   fail before GitHub access or local mutation. With all three physical
   resolutions correct, only the short setup next step is printed.
2. Launch bare `stn` outside tmux in a sanitized, isolated env → real
   OpenTUI renderer draws, observer connects, first-run screen shows.
3. Open a shell pane → **Ctrl-Z suspends, `fg` resumes** (real job control).
4. From `HOME` or `Desktop`, run `stn setup` → zero-project config is written
   and the observer restarts on the **same socket**. Open the TUI, explicitly
   add an existing Git repository, and verify the observer reflects it
   immediately (B-config); an open TUI reconnects without a manual restart.
5. Build and install the compiled artifact with default popup geometry, then
   accept setup's optional popup binding. The marked block contains the
   installed-root fast command and exact sibling `stn-tmux-popup` fallback, and
   `tmux prefix + Space` works in a fresh server started with
   `PATH=/usr/bin:/bin`. After one cold open, warm close and reopen reuse the
   same hidden session, renderer, and Observer PIDs without loading config.
   Editing the marked key is preserved by later setup runs.
6. `stn-ingress` symlink delivers a provider hook event end to end.
7. Use local `0.7.0-host-a` and `0.7.0-host-b` builds while **live host PTYs**
   exist → the new build reports
   `HOST_UPGRADE_BLOCKED`; the old host and sessions remain reattachable with
   the old build. After every hosted terminal closes, retry → the idle host is
   stopped; open a hosted terminal → the replacement health reports the new
   build (B-host).
8. Manual promotion selects the successful run's immutable
   `accepted-release-candidate-*` artifact, rechecks the exact tag, release,
   asset IDs, and hashes, then publishes only that draft.
9. With terminal A continuously running installed `stn --version`, terminal B
   repeatedly installs the draft → only complete `0.7.1-rc.6` output appears,
   never command-not-found or malformed output; both aliases remain links to
   `stn`, so entrypoints never mix. Alternate the draft with published
   `v0.7.1-rc.5` in both directions to prove upgrade and rollback.
10. Abandoned command and license `.station-install.lock` directories each
    refuse the install until their recorded PID is confirmed dead, the lock is
    manually removed, and the same install is retried successfully.
11. Ctrl-C during a real authenticated upgrade exits 130, preserves the prior
    launchable TUI, cleans its owned stages and both locks, and permits a
    successful retry.

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
7. **station-host upgrades undefined** — fixed by B-host's exact-build health,
   guarded idle replacement, and visible live-terminal refusal.
8. **Artifact inventory incomplete** — `stn-tmux-popup`, Pi extension file,
   LICENSE. New manifest + extraction policy.
9. **Release not shippable** — runner label, OS/CPU/glibc floors, gate
   bypass, checksums, license, and recovery policy. Fixed in A5 + platform table;
   immutable rollback starts with the second binary release.
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
