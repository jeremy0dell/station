# Homebrew Packaging

Status: live private-preview **source formula** in
[`jeremy0dell/homebrew-station`](https://github.com/jeremy0dell/homebrew-station),
with a public third-party tap as the stable-release target. This is not a
`homebrew/core` formula.

The compiled binary remains the primary install channel. Homebrew is a separate
source-build option: it clones an immutable Git tag and revision, installs the
Node and Bun workspaces, and retains the repository-relative runtime layout.
It does not consume Station's native binary release archives.

## User flow

While both repositories are private, authenticate Git once before installing:

```bash
gh auth login --hostname github.com
gh auth setup-git
brew install jeremy0dell/station/station
stn setup
stn doctor
stn
```

The fully qualified `brew install` command taps `jeremy0dell/homebrew-station`
and trusts only its `station` formula. After both repositories become public,
the GitHub authentication steps are unnecessary and the remaining command is
the public Homebrew install path.

Setup is independent of the current directory. Homebrew must not write
`~/.config/station/config.toml`, install provider hooks, install the tmux popup
binding, start the Observer, or run `stn doctor` during formula installation.
Those runtime-aware actions belong to `stn setup`; the user chooses the first
Git project explicitly from Station afterward.

## Formula source of truth

The live formula is `Formula/station.rb` in the tap. Its maintained shape is
[`packaging/homebrew/station.rb.template`](../packaging/homebrew/station.rb.template)
in this repository.

The formula intentionally uses a Git URL with both `tag:` and `revision:`.
`scripts/build-identity.mjs` computes the production identity from the full Git
HEAD plus tracked and untracked-nonignored production inputs, so a
GitHub-generated source archive without `.git` is not an equivalent build
input. The public source tap should retain the Git strategy rather than adding
an archive-only fallback to the build-identity contract.

The source build requires Node.js 24.2+ (and below 25), pnpm 11, and the Bun
version pinned by the release workflow. It runs:

```bash
pnpm install --frozen-lockfile
pnpm build
cd station
bun install --frozen-lockfile
bun run link:station
bun run repair:node-pty
```

The formula preserves the source-tree layout under `libexec`, wraps all three
launchers, and prepends Homebrew's keg-only `node@24` plus Bun paths. It declares
all direct build/runtime dependencies, including `git-delta`; it must not rely
on another formula to provide a transitive runtime tool.

## Tap CI and review

The tap uses Homebrew's generated `brew test-bot` workflow shape on Intel macOS,
Apple silicon macOS, and Linux. Pull requests run formula installation, the
formula test, audits, and bottle construction. Bottle artifacts are CI evidence
only for the initial public source channel; do not run the bottle-publishing
workflow until binary Homebrew distribution is an explicit supported channel.

The formula test must prove the installed wrapper reports the formula version
and that installed `stn setup check --json` completes through its packaged
runtime and reports the launcher and config facts. A missing agent or
zero-project config keeps `requiredOk` false in the isolated test home by
design.

Required tap checks before merging a formula update:

```bash
brew style jeremy0dell/station/station
brew audit --strict jeremy0dell/station/station
brew install --build-from-source jeremy0dell/station/station
brew test jeremy0dell/station/station
stn --version
stn setup check --json
```

The tap's default branch should be `main`, require pull requests, and require the
complete `brew test-bot` matrix. Dependabot maintains pinned GitHub Actions.
While the upstream Station repository remains private, same-repository tap CI
needs a temporary fine-grained `STATION_REPOSITORY_TOKEN` secret with read-only
Station contents access; remove the credential step and secret after Station is
public. GitHub does not expose that secret to fork pull requests.

## Stable formula update

Binary publication does not mutate the tap. After a stable Station release is
public and immutable, manually dispatch:

```bash
gh workflow run homebrew-bump.yml -f tag=vX.Y.Z
```

`.github/workflows/homebrew-bump.yml` accepts stable SemVer tags only and
revalidates all of these facts before touching the tap:

- the checked-out package version exactly matches the tag;
- the tag commit is on `main` and still resolves to the validated commit;
- the Station repository and tap are public;
- the GitHub release is published, stable, and immutable.

The workflow renders the tagged revision into the maintained formula template,
pushes `automation/station-X.Y.Z` in the tap, and opens or reuses a formula pull
request. It never commits directly to the tap's default branch. Merge only after
the tap CI matrix and a clean-machine source install pass.

`COMMITTER_TOKEN` must be configured in the Station repository before the first
public stable dispatch. Use a fine-grained token scoped only to
`jeremy0dell/homebrew-station` with contents write and pull-request write
permissions. The ordinary Station workflow token remains read-only.

## Public-release transition

Before publishing the first public formula:

1. Complete the repository-history, issue, release, and Actions-log review in
   [Public release checklist](public-release-checklist.md).
2. Make `jeremy0dell/station` public and validate the final public release
   candidate through the unauthenticated binary path.
3. Make `jeremy0dell/homebrew-station` public, rename its default branch to
   `main`, and enable the required tap ruleset and security settings.
4. Test the stable formula update in a pull request on all three Homebrew CI
   platforms.
5. Merge the formula only after the corresponding stable Station release is
   published and immutable.
6. From a clean unauthenticated machine, run
   `brew install jeremy0dell/station/station`, then manually verify setup,
   doctor, the TUI, and popup reopen.

## Known source-formula issue

On macOS, `brew install` can print a non-fatal warning while attempting to
rewrite the dylib ID of a vendored `@opentui/core` binary. The upstream binary
lacks enough Mach-O header padding for Homebrew's relinking pass. The installed
runtime currently loads it by direct path, but the warning remains a public UX
issue until upstream publishes a compatible binary or Station owns a verified
packaging workaround. Record the warning in release notes while it remains
reproducible.

## `homebrew/core` remains out of scope

A public third-party tap does not imply core readiness. Core still requires a
compatible license/policy posture, sustained stable releases, broader platform
compatibility, and an upstream-quality formula test and maintenance history.
Keep the source tap supported independently rather than making core acceptance
a `v0.7.1` gate.
