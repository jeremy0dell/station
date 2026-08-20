# Single-binary Station

This document defines the current compiled Station artifact and its runtime
boundaries. For installation steps, see [Install Station](install.md). For the
release procedure, see [Releasing Station](releasing.md).
Observer process ownership remains defined by
[Observer singleton lifecycle](observer-singleton.md).

## Responsibility

The compiled `stn` executable contains the CLI, Observer, provider-hook ingress,
native TUI, popup dashboard, and Station Host. It can start the native UI and a
healthy Observer without Node.js, a source checkout, or `node_modules`.

External workflow tools remain separate. Git, Worktrunk, tmux, Hunk, and agent
CLIs enable their corresponding workflows but are not part of the executable.
Source development also remains separate and continues to use the Node.js and
Bun workflows routed through [Development](development.md) and detailed in
[Local development](local-development.md).

## Supported artifacts

Station builds native artifacts for these targets:

| Release target | Bun compile target |
| --- | --- |
| `darwin-arm64` | `bun-darwin-arm64` |
| `darwin-x64` | `bun-darwin-x64-baseline` |
| `linux-arm64` | `bun-linux-arm64` |
| `linux-x64` | `bun-linux-x64-baseline` |

macOS requires version 13 or newer. Linux requires glibc 2.39 or newer; musl
and Windows are not supported. Artifacts are built natively because OpenTUI and
the controlling-terminal helper are platform-specific.

Each release archive is named
`stn-v{version}-{platform}-{architecture}.tar.gz` and contains exactly:

- `stn`, the compiled executable;
- `stn-ingress`, a symlink to `stn`;
- `stn-tmux-popup`, a symlink to `stn`; and
- `LICENSE`.

The release workflow creates a release **draft** with six assets: four native
archives, `install.sh`, and `SHA256SUMS`. It records the exact numeric asset IDs
and the target build identity shared by all native artifacts. Promotion serializes
publication repository-wide, reselects the newest complete immutable predecessor,
and publishes only the accepted draft whose commit, release, asset identities,
build identity, and checksums still match.

## Build and dispatch

Build a local native artifact from a stable checkout:

```sh
pnpm build:binary -- --version 0.0.0-local
```

`scripts/build-binary.mjs` first performs the whole-repository source build and
verifies its published build identity. It then links the Station workspace,
builds the native controlling-terminal helper and provider assets, and writes
the executable and aliases under `station/dist/bin/`.

The compiled entrypoint dispatches raw arguments before CLI option parsing or
stdin reads:

```text
stn
├── argv0 stn-ingress  -> provider-hook ingress
├── argv0 stn-tmux-popup -> popup command
├── __observer         -> Observer process
├── __ingress          -> provider-hook ingress
├── __tui              -> native TUI renderer
├── __dashboard        -> popup dashboard renderer
├── __station-host     -> persistent PTY host
├── __tmux-popup       -> popup command
└── all other argv     -> normal CLI
```

Internal tokens are process boundaries, not public CLI commands. Compiled
self-spawns reuse `process.execPath` with the appropriate token. Source mode
keeps its supplied development command unchanged.

The installed executable directory is the ownership root for popup registration,
setup-generated launchers, and the absolute `stn-ingress` path stored in provider
hooks. A virtual compiled module path and filesystem root `/` are never accepted
as ownership roots.

## Runtime boundaries

- The TUI runs as a child process so the CLI parent retains exit handling and
  terminal restoration.
- The Observer selects `bun:sqlite` in compiled mode and `node:sqlite` in source
  mode. Both implement the same Station database contract and preserve database
  compatibility across runtimes.
- Observer attach, handoff, stale-socket recovery, and replacement follow the
  [singleton lifecycle](observer-singleton.md). A higher-build explicit restart
  cooperatively stops an identity-pinned older Observer before spawning its
  successor; lower-build callers still refuse.
- Station Host reuse requires compatible protocol and exact Station build
  version. Source-mode bridge PTYs support negotiated handoff. Compiled PTYs are
  in-process Bun and cannot cross Host replacement; a failed handoff preserves
  the old Host and PTYs, and target launches refuse it visibly.
- `stn update` composes installer-binary ownership with dev-checkout, Homebrew,
  npm-global, and mise adapters. Manager-owned channels defer unless the user
  explicitly asks Station to drive their native update command. After apply,
  the successor launcher restarts Observer before attempting Host handoff; a
  later crossover failure never rolls back a verified installation.

## Packaged runtime assets

The build embeds three assets that cannot be represented only by bundled
TypeScript:

- the native controlling-terminal helper used by `Bun.Terminal`;
- the Pi extension bundle, which the external Pi process loads from a file; and
- the OpenCode plugin body used by compiled hook installation.

Compiled Station materializes the controlling-terminal helper and Pi extension
under `<state-dir>/run/assets/`. Asset paths are private, content-addressed, and
verified by size and SHA-256. Extraction is atomic and lock-guarded so concurrent
processes cannot observe partial files.

The helper is executable and leased for the lifetime of each TUI or Host process.
Only unleased stale helper versions are pruned. Pi bundles remain immutable
because a live external process may reload its extension path.

Compiled PTYs default to `Bun.Terminal` through the helper, which establishes a
controlling terminal for job control and child cleanup. `STATION_PTY_IMPL=bridge`
is source-only because it requires Node.js and `node-pty` assets. The explicit
`bun-nocctty` mode is available for diagnosis but does not provide the normal job
control or orphan-cleanup guarantees. Station never falls back to it silently.

## Compiled-mode trust boundary

A compiled artifact must not load `.env` or `bunfig.toml` from its working
directory. A repository can control those files, while Station environment
variables can select executable paths and other runtime behavior. Loading them
would turn an untrusted checkout into a code-execution boundary.

Every compile therefore sets Bun's `autoloadDotenv` and `autoloadBunfig` options
to `false`, equivalent to:

```sh
bun build --compile --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig
```

Binary smoke tests launch from a hostile directory containing both files and
fail if either affects the process. This is a release-blocking security check.

## First-run readiness

Setup exposes two separate readiness results:

- `launchReady` means Station can start the TUI and Observer. A compiled install
  requires a writable state directory and usable packaged runtime assets.
- `workflowReady` means required workflow tools, configuration, the selected
  agent CLI, and Station-owned tracking artifacts are ready.

`requiredOk` remains an alias of `workflowReady` in setup JSON. Missing workflow
dependencies do not make the compiled executable itself unlaunchable. Guided
setup writes a zero-project configuration and activates it through the normal
Observer lifecycle; projects are added deliberately in Station afterward.

## Installation and update ownership

The exact-tag installer verifies the selected archive against `SHA256SUMS` and
checks the archive manifest before replacing an installation. The ownership
receipt contains exactly `station-installer-binary-v1`; installations without
that receipt continue to run but require a later exact-tag install before the
installer-binary update adapter can own them.

Installer locking, interrupted-upgrade recovery, PATH guidance, and manual
operator steps are documented in [Install Station](install.md). Those behaviors
belong to the installer contract rather than the compiled executable.

## Verification

Run the focused local binary proof with a development version:

```sh
pnpm smoke:binary -- --expected-version 0.0.0-local
```

The smoke builds the binary and exercises version/help output, raw dispatch,
both aliases, setup readiness, packaged assets, provider-hook ingress, Observer
startup and handoff, hostile-directory isolation, popup reuse, inaccessible
socket preservation, and the compiled PTY helper.

The remaining release boundaries have focused commands:

```sh
pnpm smoke:install
pnpm smoke:release
```

The composed update smoke has two explicit busy-Host outcomes. `full-handoff`
requires PTY continuity through replacement; `preserved-refusal` requires a
completed install and Observer crossover while the old Host and PTYs remain
usable and the target native UI refuses that Host. The pane-free tmux dashboard
may still render against the matching target Observer; Host-producing work stays
guarded by the terminal provider boundary. Release staging requires full
scenario coverage: compiled predecessor busy Hosts must take the
`preserved-refusal` path, and the no-Host scenario must complete discovery,
download, installation, and crossover. Post-promotion public checks repeat the
no-Host path.

Native release CI builds and tests `darwin-arm64`, `darwin-x64`, `linux-arm64`,
and `linux-x64`. The manual release gate covers real TTY rendering, shell job
control, first-run setup, popup behavior, Host preservation, and installation on
clean machines without Node.js or Bun on the runtime `PATH`.

## Sources of truth

- `scripts/build-binary.mjs`: native target selection and compiled output.
- `scripts/release/package-archive.sh`: archive names and manifest.
- `scripts/test-runners/run-update-smoke.mjs`: composed update acceptance.
- `station/src/bin/stnMain.ts`: compiled composition.
- `apps/cli/src/selfExec.ts`: raw dispatch and self-exec mapping.
- `station/src/bin/packagedAssets.ts`: runtime asset extraction and leases.
- `apps/observer/src/sqlite/driver.ts`: Node/Bun SQLite compatibility.
- `scripts/install.sh`: installer ownership and activation.
- `.github/workflows/release.yml` and `promote-release.yml`: release acceptance
  and publication.
