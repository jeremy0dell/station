# Homebrew Packaging

Status: live, internal/team **source formula** at
[`jeremy0dell/homebrew-station`](https://github.com/jeremy0dell/homebrew-station).
Station is not ready for `homebrew/core` yet: the `station` repo itself is
private, uses Node.js 24.2+ (and below 25) plus a separate Bun workspace, and requires explicit
first-run setup. v0.1.0 is the first source-formula baseline.

The authenticated compiled binary is the primary private user channel. The tap
remains a separate source-build option for development and internal packaging
validation; it does not consume A5 binary archives and is not updated when a
binary release is published. A binary Homebrew formula remains deferred until
private release-asset downloads have a tested Homebrew authentication strategy.

Because `jeremy0dell/station` is a private GitHub repo, this tap is for
internal/team use, not public onboarding. There is no built-in Homebrew
download strategy for private-repo archive tarballs (verified against
Homebrew 6.x source -- no such strategy exists), so the formula clones via
git+https instead (`url "...git", tag:, revision:`). This authenticates
transparently using whatever git credentials the installing user already has
for github.com (SSH key, or `gh auth login`'s git credential helper) -- no
extra token/env var needed at install time. Revisit this once `station` goes
public.

## Source-formula user flow

```bash
brew tap jeremy0dell/station
brew trust jeremy0dell/station
brew install station
cd /path/to/first/git/project
stn setup
stn doctor
stn
```

Homebrew should install Station and its machine-level dependencies. It should not
write `~/.config/station/config.toml`, install provider hooks, install the tmux
popup binding, start the observer, or run `stn doctor` during formula install.
Those steps are user/project aware and belong to `stn setup`.

## Formula shape

The formula lives in the
[`jeremy0dell/homebrew-station`](https://github.com/jeremy0dell/homebrew-station)
tap as `Formula/station.rb`, kept in sync with
[`packaging/homebrew/station.rb.template`](../packaging/homebrew/station.rb.template)
in this repo.

The current install is source-tree based, not a single binary. The formula must
preserve the repository-relative layout because:

- `bin/stn` resolves `apps/cli/dist/main.js` relative to the launcher.
- `bin/stn-ingress` resolves `apps/cli/dist/ingressMain.js`.
- The CLI resolves the Bun TUI workspace at `station/`.
- `station/` needs its own Bun `node_modules` and linked built `@station/*`
  packages.

The formula template builds with:

```bash
pnpm install --frozen-lockfile
pnpm build
cd station
bun install --frozen-lockfile
bun run link:station
bun run repair:node-pty
```

Runtime launchers should wrap the installed tree and prepend Homebrew's
`node@24` path because `node@24` is keg-only.

## Release checklist

Binary publication never updates the source formula. When a published Station
source tag should be packaged separately:

1. Confirm the tag contains the source checkout version intended for the
   formula and that its normal CI is green.
2. Manually dispatch the source-formula workflow with the exact published tag:

   ```bash
   gh workflow run homebrew-bump.yml -f tag=vX.Y.Z
   ```

   `.github/workflows/homebrew-bump.yml` is `workflow_dispatch` only; it does
   not listen to `release: published`. The workflow updates
   `Formula/station.rb`'s `tag` and revision in the tap and commits directly to
   the tap's default branch.
3. `COMMITTER_TOKEN` remains intentionally unconfigured for A5. A future
   source-formula dispatch needs a PAT with cross-repository contents write
   access on `jeremy0dell/homebrew-station`; the default `GITHUB_TOKEN` cannot
   push to that repository. Until then, update the tap formula manually.
4. Test locally:

   ```bash
   brew untap jeremy0dell/station; brew tap jeremy0dell/station
   brew trust jeremy0dell/station
   brew install --build-from-source station
   brew audit --strict station
   brew test station
   stn setup check --json
   stn doctor
   stn
   ```

5. Publish bottles from the tap once the formula is reviewed and the tap CI is
   green.

## Known issues

- `brew install` prints a non-fatal warning: `Failed changing dylib ID of
  .../node_modules/@opentui/core-darwin-arm64/libopentui.dylib`. Homebrew's
  automatic post-install relinking pass scans every Mach-O file in the keg,
  including vendored prebuilt native node_modules binaries, and this
  particular upstream binary doesn't have enough Mach-O header padding to be
  rewritten. The CLI still works (`stn`, `stn setup check --json`, `brew
  test` all pass) -- Node loads the addon by direct path, not via dyld
  rpath resolution -- but expect the warning on every install/upgrade until
  `@opentui/core` ships a binary built with `-headerpad_max_install_names`.

## Core-readiness blockers

- `station` itself must go public (private repos cannot be in `homebrew/core`).
- Public, stable tagged releases with real version numbers.
- A formula test that proves more than `--help`.
- A cleaner installed-mode TUI smoke for the Bun/native PTY path.
- License metadata acceptable to Homebrew core (FSL-1.1-ALv2 is a valid SPDX
  id but is not DFSG-compliant, which `homebrew/core` requires).
- Runtime compatibility with Homebrew-supported macOS and Linux targets.
