# Homebrew Packaging

Status: draft path for an internal/team tap. Station is not ready for
`homebrew/core` yet: the `station` repo itself is private, it is still a
private workspace package internally, uses Node 24 plus a separate Bun
workspace, and requires explicit first-run setup.

Because `jeremy0dell/station` is a private GitHub repo, this tap is for
internal/team use, not public onboarding. Anyone running `brew install` needs
`HOMEBREW_GITHUB_API_TOKEN` set to a token with `repo` scope on
`jeremy0dell/station`, and the formula's `url`/`head` use
`GitHubPrivateRepositoryDownloadStrategy` to authenticate the tarball
download. Revisit this once `station` goes public.

## Target user flow

```bash
export HOMEBREW_GITHUB_API_TOKEN=<token with repo access to jeremy0dell/station>
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

Keep the initial formula in an upstream tap, for example
`jeremy0dell/homebrew-station`, and copy
[`packaging/homebrew/station.rb.template`](../packaging/homebrew/station.rb.template)
to the tap as `Formula/station.rb`.

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

1. Tag a Station release.
2. Replace the formula template `url` and `sha256` with the tagged tarball and
   checksum.
3. Test locally:

   ```bash
   brew install --build-from-source ./Formula/station.rb
   brew test station
   stn setup check --json
   stn doctor
   stn
   ```

4. Publish bottles from the tap once the formula is reviewed and the tap CI is
   green.

## Core-readiness blockers

- `station` itself must go public (private repos cannot be in `homebrew/core`).
- Public, stable tagged releases with real version numbers.
- A formula test that proves more than `--help`.
- A cleaner installed-mode TUI smoke for the Bun/native PTY path.
- License metadata acceptable to Homebrew core (FSL-1.1-ALv2 is a valid SPDX
  id but is not DFSG-compliant, which `homebrew/core` requires).
- Runtime compatibility with Homebrew-supported macOS and Linux targets.
