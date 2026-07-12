# Setup Testing (varied machine states)

`stn setup` must work on a brand-new device — from the nightmare machine (no Xcode
Command Line Tools, no git, no Homebrew) to a fully provisioned happy path. This
doc describes the three-tier test environment that lets agents and maintainers run
the setup flow against machines in those varied states.

The setup engine is dependency-injected end to end (`runner`, `access`, `fs`,
`env`, `platform`, `now`, `noBrew`, `prompt`), so most coverage is free and
in-process. The few states that need a real OS (real `brew install`, a truly
CLT-absent Mac) run in a VM.

## The profile contract

A **machine profile** is one declarative record of machine state + expected
outcome, defined once in `packages/testing/src/setupProfiles.ts` and asserted at
three fidelities. `stn setup check --json` is the surface every tier drives; it
exits `0` when `summary.requiredOk`, else `1` (the `2` exit code is reserved for
bad args). Output is deterministic via `--json` + an injected clock, so
comparisons are structural diffs, not log scraping.

```
profile { name, state: { platform, xcodeClt, git, insideRepo, brew, worktrunk,
                         tmux, bun, diffnav, gitDelta, harnesses[], configToml? },
          expect: { exitCode, requiredOk, checks: { <id>: <status> } } }
```

## Tier 1 — in-process synthetic profiles (every PR, ~zero cost)

`apps/cli/test/integration/setup-profiles.test.ts` compiles each profile into the
real `SetupCommandDeps` seam and runs `runCli([... "setup","check","--json"])`,
asserting exit code + `requiredOk` + per-check status. Runs in the existing
`pnpm test:integration` lane (so it is already in `pnpm test:all`, the
pre-push gate, and hosted CI). This is the backbone and the canonical contract; it covers every
profile, including the darwin `no-xcode-clt` case via an injected `platform`.

```bash
pnpm test:integration   # includes setup-profiles
```

## Tier 2 — Linux containers (medium fidelity, nightly/manual)

`tests/env/docker/Dockerfile` is one multi-stage build whose per-profile
`--target`s add/withhold real binaries; `scripts/test-runners/run-setup-container.mjs`
builds each and asserts the same outcome contract against a genuine Linux process
tree. Homebrew and the CLT are macOS-only, so brew/CLT profiles are **not** here —
every Linux image already exercises the "brew absent → manual hint" path.

```bash
node scripts/test-runners/run-setup-container.mjs            # all Linux profiles
node scripts/test-runners/run-setup-container.mjs no-git     # one profile
pnpm test:env:docker                                         # same, via script
```

Requires Docker. Covers: `happy-linux`, `no-git`, `no-tmux`, `no-worktrunk`,
`no-bun`, `no-diffnav`, `no-harness`.

## Tier 3 — macOS Tart VM snapshots (full fidelity, on-demand)

Only a real Mac can exercise real `brew install`, `/opt/homebrew`, `node@24`
keg-only PATH behaviour, and a truly CLT-absent host. We use **Tart**
(`cirruslabs/tart`) on Apple Silicon: native `Virtualization.framework`, APFS
copy-on-write `tart clone` (near-instant fresh state), OCI image distribution.

- `tests/env/macos/station-happy.pkr.hcl` — a Packer template that builds the
  "STATION happy-path" image (brew + node@24 + bun + wt + tmux + diffnav + delta)
  from a base image. Use `cirruslabs/macos-image-templates` `*-vanilla` (no brew,
  no Xcode) for the `no-brew` / `no-xcode-clt` profiles.
- `tests/env/macos/run-setup-macos.mjs` — clones the right base per profile, runs
  `bootstrap.sh` before `stn setup check --json` only for the happy `ready` profile
  (`setup: "full"`); deprivation profiles run `stn setup check --json` against the
  image as-is. It asserts the shared contract over SSH, then deletes the clone.

```bash
node tests/env/macos/run-setup-macos.mjs ready        # happy image
node tests/env/macos/run-setup-macos.mjs no-xcode-clt # vanilla image
```

**Constraint — Apple's 2-VM-per-host limit.** macOS permits at most two macOS VMs
per host and this is kernel-enforced on Apple Silicon, regardless of VM tool. So
brew/CLT profiles run **sequentially** on the maintainer's Mac (CoW clones boot
fast; each `setup check` is seconds-to-minutes). For parallelism, add Macs or a
hosted fleet (MacStadium/Orka).

**Do not build on Cirrus CI / Cirrus Runners** (shutting down June 2026). Use
GitHub-hosted macOS runners only for an occasional full happy-path smoke — their
images are fully provisioned and bill at a 10× multiplier, so they cannot model
deprivation states.

## The agent-driven loop

For each profile an agent: (1) provisions/selects an environment — nothing for
tier 1, `docker build --target` for tier 2, `tart clone` for tier 3; (2) runs the
read-only, machine-readable surfaces (`stn setup check --json`, `stn setup plan
--json`, `stn setup apply --dry-run`); (3) captures stdout + exit code; (4)
structurally diffs the JSON plan + exit code against the profile's `expect`; (5)
iterates on setup code and re-runs. Tier 1 reruns in milliseconds, tier 2 in
seconds, tier 3 in low minutes. Every artifact (profile, captured JSON, diff) is
plain text and committable, so a failing run is reproducible without the original
machine.

## Adding a profile

Add it to `packages/testing/src/setupProfiles.ts` (it is picked up by tier 1
automatically). If it is Linux-coverable, add a `--target` stage in the Dockerfile
and an entry in `run-setup-container.mjs`. If it needs real brew/CLT, add it to
`run-setup-macos.mjs` with the appropriate base image.
