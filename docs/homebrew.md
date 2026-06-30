# Homebrew Packaging

Status: live, internal/team tap at
[`jeremy0dell/homebrew-station`](https://github.com/jeremy0dell/homebrew-station).
Station is not ready for `homebrew/core` yet: the `station` repo itself is
private, uses Node 24 plus a separate Bun workspace, and requires explicit
first-run setup. v0.1.0 is the first tagged release.

Because `jeremy0dell/station` is a private GitHub repo, this tap is for
internal/team use, not public onboarding. There is no built-in Homebrew
download strategy for private-repo archive tarballs (verified against
Homebrew 6.x source -- no such strategy exists), so the formula clones via
git+https instead (`url "...git", tag:, revision:`). This authenticates
transparently using whatever git credentials the installing user already has
for github.com (SSH key, or `gh auth login`'s git credential helper) -- no
extra token/env var needed at install time. Revisit this once `station` goes
public.

## Target user flow

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
- `bin/stn-ingress` resolves `packages/provider-hooks/dist/main.js`.
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

1. Bump `version` in root `package.json`, commit, tag (`git tag vX.Y.Z`), push
   the commit and tag.
2. `gh release create vX.Y.Z --generate-notes`.
3. `.github/workflows/homebrew-bump.yml` runs on `release: published` and
   updates `Formula/station.rb`'s `tag`/`revision` in the tap automatically,
   committing directly to the tap's default branch (no PR, single maintainer).
   It needs a `COMMITTER_TOKEN` repo secret on `jeremy0dell/station`: a PAT
   (fine-grained, `contents: write` on `jeremy0dell/homebrew-station`, or
   classic with `repo` scope) -- create one and run
   `gh secret set COMMITTER_TOKEN -R jeremy0dell/station`. Without it the
   workflow fails to push to the tap (cross-repo push needs an explicit
   token; the default `GITHUB_TOKEN` only has access to the repo the
   workflow runs in).
4. If the bump workflow isn't set up yet, update `Formula/station.rb`'s `tag`
   and `revision` by hand (`git rev-parse vX.Y.Z` for the revision).
5. Test locally:

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

6. Publish bottles from the tap once the formula is reviewed and the tap CI is
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
