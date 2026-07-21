# Public Release Checklist

Status: living gate for the first public stable Station release. The target is
`v0.7.1`, distributed through native GitHub binaries and the public
`jeremy0dell/station` Homebrew source tap.

This checklist complements, rather than replaces:

- [Development](development.md) for deterministic and native release gates;
- [Install](install.md) for the binary installer contract;
- [Homebrew packaging](homebrew.md) for source-formula ownership and CI;
- [Single binary](single-binary.md) for compiled artifact design; and
- `.github/workflows/release.yml` plus `promote-release.yml` for executable
  draft-acceptance and immutable-promotion policy.

Product behavior blockers are tracked separately. A packaging or publication
owner may advance the preparation sections while those fixes are in flight, but
must not cut the final candidate until both tracks are green.

## Release definition

- [ ] Native binaries support `darwin-arm64`, `darwin-x64`, `linux-arm64`, and
      `linux-x64` with their platform floors recorded in release notes.
- [ ] Published binary installation requires no GitHub account or credentials.
- [ ] Homebrew is a public third-party source tap, not a `homebrew/core` formula
      and not a wrapper around the native installer.
- [ ] The documented Homebrew command is
      `brew install jeremy0dell/station/station`.
- [ ] Both channels finish at the same `stn --version` and preserve the three
      `stn`, `stn-ingress`, and `stn-tmux-popup` launchers.
- [ ] Updates and rollback use immutable versions; published tags, assets, and
      formula revisions are never replaced.

## 1. Public-data review

Making a private GitHub repository public exposes more than the current tree.
Complete and record a human review before changing visibility.

- [ ] Scan the complete Git history for credentials, private endpoints, personal
      data, proprietary fixtures, and generated diagnostic bundles.
- [ ] Review every issue, pull request, review comment, attachment, release,
      release note, Actions artifact, and retained Actions log intended to
      become public.
- [ ] Review Git tags and branches; preserve immutable published releases and
      remove only unpublished material through an explicit audited decision.
- [ ] Confirm screenshots, transcripts, user names, home paths, repository names,
      and runtime traces are safe to publish.
- [ ] Run repository secret scanning and independently review its findings.
- [ ] Verify no public documentation tells users to paste, print, or export
      credentials.
- [ ] Record the approving reviewer and date outside this reusable checklist.

## 2. Public repository controls

- [ ] Add `.github/SECURITY.md` with a private vulnerability-reporting route,
      supported versions, and response expectations.
- [ ] Enable private vulnerability reporting, Dependabot alerts, dependency
      updates, secret scanning, and push protection where GitHub supports them.
- [ ] Add CodeQL or document the equivalent JavaScript/TypeScript security lane.
- [ ] Keep the `main` ready-PR ruleset active and confirm its required check is
      the full `standard-ci` pull-request job.
- [ ] Restrict workflow-token permissions by default and retain explicit job
      permissions for release mutation.
- [ ] Confirm the FSL license and source-available status are described
      accurately; do not imply OSI approval or `homebrew/core` eligibility.
- [ ] Add public update, rollback, uninstall, support, and diagnostic-bundle
      instructions.

## 3. Public binary transport

- [ ] Published installs use HTTPS without requiring authenticated `gh`.
- [ ] The canonical convenience command pipes the version-stamped latest release
      asset to `sh`; an adjacent inspect-first procedure downloads that same
      asset to a private temporary file, checks it with `sh -n`, and invokes it
      explicitly. Neither path fetches from `main`.
- [ ] Draft acceptance retains its authenticated release-ID path and exact
      candidate manifest.
- [ ] Deterministic installer smoke covers public latest, public exact-version,
      authenticated draft, redirects, partial downloads, HTTP failures,
      checksum rejection, locks, signals, rollback, and atomic activation.
- [ ] A post-promotion matrix verifies the actual public assets on all four
      native targets without repository credentials.
- [ ] `releases/latest` resolves to the intended stable release, not the old
      source-only `v0.1.0` release.

Expected implementation files:

- `scripts/install.sh`
- `scripts/test-runners/run-install-smoke.mjs`
- `scripts/release/render-release-installer.mjs`
- `.github/workflows/release.yml`
- `.github/workflows/promote-release.yml`
- `README.md`
- `docs/install.md`
- `docs/development.md`
- `docs/single-binary.md`
- `tests/diagnostics/release-readiness-docs.test.ts`

No backend or connector seam changes are expected, so this transport slice has
no planned architectural JSDoc updates.

## 4. Artifact signing and provenance

- [ ] Obtain and protect the Apple Developer ID Application certificate and
      App Store Connect notarization credentials through GitHub environments.
- [ ] Sign the final macOS `stn` executable before archive assembly on both
      architectures.
- [ ] Submit the exact signed artifacts for notarization, staple where the
      artifact shape supports it, and verify with `codesign` and `spctl` on a
      clean machine.
- [ ] Stop treating quarantine removal as the public trust mechanism; retain it
      only if the signed/notarized UX has a documented need.
- [ ] Bind release artifacts to GitHub Actions build provenance and document the
      optional verification command.
- [ ] Decide and document whether `SHA256SUMS` also receives a detached
      signature; an unsigned checksum beside the archives is integrity evidence,
      not an independent publisher identity.
- [ ] Confirm release jobs cannot expose signing credentials to pull requests,
      forks, or unsigned local builds.

Expected implementation files are `.github/workflows/release.yml`, the focused
sign/notarize helper under `scripts/release/`, `scripts/release/package-archive.sh`,
`scripts/test-runners/run-binary-smoke.mjs`, `docs/development.md`, and
`docs/single-binary.md`. No backend or connector JSDoc updates are expected.

## 5. Homebrew source tap

- [ ] `packaging/homebrew/station.rb.template` and the live
      `Formula/station.rb` have the same formula shape.
- [ ] The formula pins both stable tag and full revision and declares every
      direct dependency.
- [ ] The installed wrapper reports the formula version and setup check loads
      the packaged runtime from an isolated home.
- [ ] The tap has pinned Dependabot-managed Actions and Homebrew `test-bot` on
      Intel macOS, Apple silicon macOS, and Linux.
- [ ] Bottle artifacts remain unpublished while this channel is source-only.
- [ ] The tap default branch is `main` and requires pull requests plus the full
      platform matrix.
- [ ] Station's Homebrew dispatch validates a public, stable, immutable release
      and opens a tap pull request instead of pushing the default branch.
- [ ] `COMMITTER_TOKEN` is fine-grained to the tap with contents and pull-request
      write permissions only.
- [ ] Remove the temporary read-only `STATION_REPOSITORY_TOKEN` from tap CI after
      Station becomes public.
- [ ] Formula release notes disclose the vendored OpenTUI dylib warning until it
      is resolved and reverified.

Expected Station files are `.github/workflows/homebrew-bump.yml`,
`packaging/homebrew/station.rb.template`,
`scripts/release/render-homebrew-formula.mjs`, `docs/homebrew.md`,
`docs/install.md`, `README.md`, and Homebrew diagnostics tests. Expected tap
files are `Formula/station.rb`, `README.md`, `.github/dependabot.yml`, and
`.github/workflows/tests.yml`. No backend or connector JSDoc updates are
expected.

## 6. Final public release candidate

- [ ] Product release blockers are closed and the exact candidate commit is on
      `main` with full ready-PR CI green.
- [ ] The repositories pass the public-data review before visibility changes.
- [ ] Make Station public, then make the tap public and apply their rulesets and
      security settings.
- [ ] Cut `v0.7.1-rc.5` from a version-consistent commit.
- [ ] Confirm standard CI, release smoke, all native builds, all binary smokes,
      all four draft installs, and candidate recording pass.
- [ ] Perform the complete manual acceptance gate in [Development](development.md)
      before promotion.
- [ ] Promote the candidate and test an unauthenticated install on four clean
      native systems.
- [ ] Test the Homebrew formula against the candidate in a pull request or
      non-default test branch; do not publish a prerelease formula as stable.
- [ ] Exercise the candidate in daily real terminal, popup, setup, provider-hook,
      and worktree use for the agreed soak period.
- [ ] Restart the candidate gate after any production-code change.

Stop-ship findings include data loss or repository mutation, install/upgrade or
rollback failure, mixed launcher versions, unhealthy clean setup/doctor,
Observer replacement or socket-ownership failure, terminal loss across upgrade,
macOS trust failure, and a failing supported-platform packaging lane.

## 7. Stable `v0.7.1`

The version-only release change is expected to update:

- `package.json`
- `packages/runtime/src/buildInfo.ts`
- `README.md`
- `docs/install.md`
- `docs/development.md`
- `docs/single-binary.md`
- `apps/cli/test/integration/manual-smoke-commands.test.ts`
- `packages/runtime/test/unit/buildInfo.test.ts`
- `scripts/test-runners/run-binary-smoke.mjs`
- `tests/diagnostics/release-readiness-docs.test.ts`

No backend or connector JSDoc updates are expected for the version-only change.

- [ ] Keep production behavior identical to the accepted final candidate except
      for release version and truthful stable-channel documentation.
- [ ] Run `pnpm test:pre-push` on the exact version commit.
- [ ] Tag `v0.7.1`; never move or reuse the tag.
- [ ] Require the complete draft and candidate-recording workflow to pass.
- [ ] Repeat manual acceptance against the stable draft.
- [ ] Promote only the accepted immutable draft.
- [ ] Verify an unauthenticated latest install reports `0.7.1` on four targets.
- [ ] Verify candidate-to-stable upgrade, stable reinstall, and explicit rollback
      while continuously resolving all three launchers.
- [ ] Dispatch the Homebrew update, review its exact tag/revision, wait for the
      full tap matrix, and merge the formula pull request.
- [ ] Verify the one-command Homebrew install from a clean, unauthenticated
      machine and confirm `brew upgrade station` remains coherent.
- [ ] Publish release notes with platform floors, signing/provenance instructions,
      known limitations, rollback, uninstall, and support links.

## Manual UX sign-off

For both channels, record the exact first failure and do not substitute a source
checkout for the installed artifact.

1. Start from a clean home and shell with Station absent.
2. Install without GitHub authentication.
3. Physically resolve all three launchers and confirm `stn --version`.
4. Run guided `stn setup`, `stn setup check --json`, and `stn doctor`.
5. Add the first Git project explicitly, create a real agent session, and verify
   transcript and diff projection.
6. Quit and reopen the TUI; confirm session and terminal continuity.
7. Verify cold and warm tmux popup behavior and provider ingress.
8. Open a new login shell and confirm the documented PATH behavior.
9. Upgrade, reinstall, and roll back without a command-not-found interval or
   mixed aliases.
10. Follow the public uninstall instructions and confirm only Station-owned
    files and integrations are removed.
