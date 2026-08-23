# Releasing Station

This is the maintainer runbook for publishing a native Station release. The
release workflows own artifact construction and verification; this guide owns
the human decisions between draft creation and publication.

Public releases are exact-tag and immutable. Never replace a published tag or
asset. If a published release is faulty, roll forward with a new version.

## Prepare the release

1. Confirm GitHub immutable releases are enabled.
2. Choose a version whose `v<version>` tag does not exist.
3. Confirm `package.json`, runtime build information, and intended release notes
   agree on the version.
4. Confirm the release commit is on `main` and all intended changes are present.
5. Create and push the exact `v<version>` tag.

The tag starts `.github/workflows/release.yml`. That workflow runs standard CI,
builds the four native targets, creates a six-asset draft, exercises the stamped
draft installer, binds the exact numeric asset IDs and shared target build
identity, and records an immutable `accepted-release-candidate-*` artifact. The
macOS candidate lane runs four current-contract transitions from a composed
synthetic-version incumbent. The no-Host lane proves artifact application and
successor-owned verified convergence. The Host lanes prove real old-idle-Host replacement and
old bridge-backed live handoff, including exact PIDs, immutable build identities,
session-bound PTY identity, output continuity, typed receipt audit, and a fresh final no-op
plan. A separate real successor hook-failure lane seeds distinct token, private
worktree path, PID, provider payload, process-group, and terminal-control
canaries and requires both strict JSON and default text to retain only sanitized
error envelopes and stable codes. Its distinct non-bridge lane must stop before
mutation with `pre-mutation-reap-required`
while preserving the incumbent artifact and runtime.
Post-promotion checks verify the exact-tag installer independently; update
convergence is accepted only through the current strict report boundary.
The tag workflow never publishes the draft automatically.

Do not begin manual acceptance until the workflow succeeds. Treat the workflow,
not this prose, as the source of truth for artifact names, checksums, and target
composition.

## Install the accepted draft

Use the successful release run ID and tag. Download its accepted-candidate
artifact, read the draft release and installer asset IDs from that artifact,
then run the stamped installer against the draft:

```sh
tag=vX.Y.Z
run_id=123456789
attempt="$(gh run view "$run_id" --json attempt --jq .attempt)"
candidate_dir="$(mktemp -d)"
installer="$(mktemp)"

gh run download "$run_id" \
  --name "accepted-release-candidate-${tag#v}-attempt-$attempt" \
  --dir "$candidate_dir"
release_id="$(jq -er .releaseId "$candidate_dir/manifest.json")"
installer_id="$(awk -F= '$1 == "install.sh" { print $2 }' \
  "$candidate_dir/asset-ids.txt")"
gh api -H 'Accept: application/octet-stream' \
  "repos/jeremy0dell/station/releases/assets/$installer_id" >"$installer"
STATION_INSTALL_RELEASE_ID="$release_id" sh "$installer"
```

Remove the temporary files after acceptance. Normal public installs never use
`STATION_INSTALL_RELEASE_ID`; they use the exact-tag URL in
[Install Station](install.md).

## Manual acceptance

Run the native install smoke supplied by the workflow on every supported target.
Perform the complete user-flow pass on at least one clean macOS machine and one
clean Linux machine. Preserve the first failing command and output.

- **Install and PATH:** A clean home installs all three launchers without editing
  shell startup files; a new shell resolves each launcher to the install directory.
- **Standalone launch:** With Node and Bun absent from runtime PATH, bare `stn`
  opens the native TUI and connects to a healthy Observer.
- **Setup:** Running `stn setup` outside a project creates a zero-project config,
  prepares selected harnesses, and never starts an agent or sign-in flow.
- **First project:** The TUI adds a Git project, creates a session, shows
  transcript and diff output, and restores the session after reopening.
- **Terminal:** A shell pane survives `Ctrl-Z`, `fg`, and `Ctrl-C`; quitting
  Station leaves no pane payload behind.
- **Popup and ingress:** The optional tmux binding cold-opens and warm-reopens
  the popup, and `stn-ingress` delivers a provider event.
- **Upgrade safety:** A supported `full-handoff` preserves PTY identity and
  output through Host replacement, with an exact session-bound receipt and final inventory
  match. The staged transport refuses post-apply latest discovery so successor
  convergence proves the pinned installed target without a new network
  dependency. If the incumbent cannot hand off, the
  `pre-mutation-reap-required` path leaves its incumbent artifact, Observer,
  Host, and PTYs usable without applying or crossing over. Its digest is
  revalidation evidence for #641, not signal authority. Concurrent probes
  observe a complete old or new binary.
- **Recovery:** An interrupted install leaves the previous TUI usable, releases
  owned locks and stages, and succeeds on retry. Never remove a lock whose owner
  may be alive.

When installer, setup, Host handoff, or terminal ownership changed, repeat the
corresponding focused scenarios in [Install](install.md),
[Setup testing](setup-testing.md), [TUI development](tui.md), and
[Observer singleton lifecycle](observer-singleton.md).

## Promote the accepted draft

After manual acceptance passes, dispatch `.github/workflows/promote-release.yml`
with the successful release run ID, exact tag, and manual-acceptance confirmation.

Promotion must select the accepted-candidate artifact, revalidate its commit,
tag, release ID, target build identity, asset IDs, and hashes, and acquire the
repository-wide publication lock. It then reselects the newest complete immutable
predecessor, publishes that exact draft without replacing assets, and passes the
public exact-tag installer checks for all native targets.

After promotion:

1. Confirm the release is public with the expected prerelease status.
2. Confirm all six asset identities are unchanged from the accepted draft.
3. Run the public exact-tag installer in a clean environment without GitHub
   credentials or `gh`.
4. Confirm `stn --version`, `stn setup check --json`, and `stn doctor` succeed.

## Failure recovery

- If a transient workflow failure leaves an unpublished draft, delete only that
  draft and rerun the unchanged tag workflow.
- If source must change after a tag was pushed, leave the tag and draft alone;
  fix the source and use the next version.
- If promotion fails before publication, preserve the draft and accepted
  candidate while diagnosing the failed invariant.
- If a published release is faulty, publish a superseding release. Never delete,
  retag, or overwrite the published release.

Release-specific checklists, evidence, and exceptions belong in the release
issue or pull request, not in this runbook.

## Sources of truth

- `.github/workflows/release.yml` builds and accepts the draft.
- `.github/workflows/promote-release.yml` verifies and publishes it.
- `scripts/install.sh` owns installation, locking, activation, and recovery.
- [Single-binary Station](single-binary.md) owns the artifact and runtime
  boundary contract.
