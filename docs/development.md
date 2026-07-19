# Development

Status: current living doc for development, test, and documentation workflow.

## Environment

- Use Node.js 24.2+ (and below 25) and pnpm 11. The root `package.json` requires `node: >=24.2 <25`, `pnpm: 11.0.0`, and `packageManager: pnpm@11.0.0`.
- Use the repo-local command during development: `pnpm stn ...`.
- Use `pnpm station:link` only when you intentionally want all three launchers globally bound to the current checkout.
- External tools are optional unless the lane needs them: Worktrunk for real worktree workflows, tmux for the reference terminal provider, and Claude Code, Codex, Cursor, Pi, or OpenCode for real harness workflows.

## Local TUI Workflow

| Need | Command | Boundary |
| --- | --- | --- |
| Normal run | `pnpm stn` / `pnpm stn tui` | Built CLI, configured observer |
| UI hot reload against the selected observer | `pnpm station:ui-dev` | Bun renderer only |
| CLI/package-output watcher | `pnpm dev` / `pnpm station:tui-dev` | Isolated by default, not Bun HMR |
| Isolated Station sandbox | `pnpm station:devbox` | Isolated observer, host, state, and supported hooks |
| Isolated Station sandbox with UI HMR | `pnpm station:devbox dev` | Same devbox isolation, Bun renderer hot reload |
| Isolated real tmux popup with UI HMR | `pnpm station:devbox tmux dev` | Private tmux server, Observer, config/state, and production popup CLI |

Do not use `station:dev` as a catch-all name until it truthfully owns the UI,
CLI/package, observer, provider, protocol, and host restart boundaries.

- `pnpm stn` opens the normal station popup from the current checkout's built CLI when run inside tmux.
- `pnpm stn tui` opens the normal station TUI fullscreen from the current checkout's built CLI.
- Source popup registrations are scoped to the canonical checkout root that
  created them. Compiled registrations are scoped to the canonical installed
  binary directory instead; neither path may register filesystem root `/`.
- With default popup geometry, the optional binding installed by a compiled
  `stn setup` uses the generated direct tmux fast path. Custom geometry uses the
  config-aware exact sibling `stn-tmux-popup` alias instead, as does setup run
  with an explicit `--config` path. The fast path's
  first use can enter that alias, while a valid warm use attaches, toggles, or
  transfers the existing `_station-ui` session without Bun, config loading, or
  Observer startup. Build the binary with
  `pnpm build:binary -- --version <version>` when validating this path; a source
  `pnpm build` does not create the installed artifact ownership used by the
  binding.
- `pnpm station:ui-dev` starts the Bun renderer with hot reload for `station/src/**` UI changes from the current checkout.
- `pnpm station:tui-dev` starts the CLI-side dev TUI for the checkout where it is run. It watches the built Node CLI/package outputs, not the Bun renderer source. Its watcher restarts the TUI only after the identity-aware whole-graph build publishes a stable `station-build-id` sentinel. By default it uses a generated worktree-local config at `.dev-state/tui-dev/config.toml`, with observer `state_dir` and supported harness hook homes under `.dev-state` and a short checkout-keyed socket path under the OS temp dir so Unix socket names do not overflow on long worktree roots. It preconfigures isolated Codex, Claude, Cursor, and OpenCode hooks for that observer. Pass `--config <path>` or set `STATION_CONFIG_PATH` when you intentionally want a specific observer/config. While that process is alive, popup routing can reuse that dev UI only from the same checkout root. If another checkout already owns the dev popup, the command shows that root/session and asks whether to stop it before starting here.
- `pnpm station:devbox dev` starts the isolated Station sandbox with Bun hot reload for `station/src/**`; use it when UI iteration should not connect to the real observer.
- `pnpm station:devbox tmux dev` starts a checkout-keyed private tmux server and isolated live Observer, then keeps the foreground command as the signal-cleanup owner. Attach with `pnpm station:devbox tmux attach`; inside that client, `Ctrl-b Space` invokes the built production `popup` command while its Bun dashboard child hot-reloads `station/src/**`.
- `pnpm station:reset` clears station tmux popup registrations for the current checkout and opens station normally from built code. Inside tmux that means a fresh popup; outside tmux that means the fullscreen TUI.
- `pnpm station:reset:tmux-tui` is the heavier tmux TUI refresh for this checkout. It requires clean `main`, pulls `origin/main`, clears only station TUI/popup tmux state, rebuilds, restarts the observer, then opens station from the rebuilt checkout. It does not kill worktree sessions or harness agents.

### Private tmux popup devbox

Install the root and Station dependencies, then build once before starting:

```bash
pnpm install
pnpm build
cd station && bun install && cd ..

pnpm station:devbox tmux dev
# another terminal:
pnpm station:devbox tmux attach
```

The lane creates `/tmp/stn-dbx-<checkout-hash>` at mode `0700`, one private
`tmux -L stn-dbx-<checkout-hash> -f /dev/null` server, an isolated live
Observer, empty provider homes, a committed disposable Git project, and a
strict minimal config. It never seeds real auth, Git, SSH, hooks, config, or
default tmux state. `status` inspects only the recorded private manifest,
server, sockets, and matching processes.

Use `Ctrl-b Space` in the attached base session. The binding enters the built
CLI's production `popup` command; `_station-ui` owns the long-lived CLI parent,
which retains the renderer-control IPC channel while the Bun renderer reloads
in place. `dev` remains in the foreground so Ctrl-C, SIGHUP, or SIGTERM performs
the same scoped cleanup as `stop`. Use `start` instead when automation needs the
lane to return immediately.

| Changed surface | Required action |
| --- | --- |
| Dashboard-imported `station/src/**` | Bun HMR only |
| Linked `packages/*` output, CLI, Observer, providers, protocol, or tmux integration | `tmux stop` → `pnpm build` → `tmux dev` |
| Station Host or PTY runtime | Full `tmux stop` / `tmux dev` |
| Dependencies or Station package links | Stop, install/relink, then start |
| Generated root/config/wrapper ownership | `tmux reset --yes` → `tmux dev` |

There is intentionally no `tmux restart`: a rebuild boundary must replace the
CLI, Observer, popup signature, and any optional Host coherently. Diagnostics
and cleanup commands are:

```bash
pnpm station:devbox tmux status
pnpm station:devbox tmux logs --follow
pnpm station:devbox tmux stop
pnpm station:devbox tmux reset --yes
```

The explicit real-lane smoke is excluded from `test:all` because it requires
tmux, Bun, Python 3, PTY interaction, and a temporary source edit:

```bash
pnpm station:devbox:tmux:smoke
```

That smoke owns public grammar, generated-environment isolation, wrapper
auditing, attach UX, live repaint, signal exits, and cleanup.
`STATION_REAL_TMUX=1 pnpm test:tmux-popup:real` is the exact production-popup
acceptance lane: it owns popup claims, keyboard input through an attached outer PTY,
terminal-driven resize propagation, rendered focus outcomes, warm reuse,
compiled binding behavior, and its own private fixture cleanup. The canonical
99×25 capture is checked against
`integrations/terminal/tmux/test/fixtures/real-dashboard-99x25.frame.json`.
Full-frame captures use the private wrapper and preserve trailing cells;
assertions wait for two identical captures rather than accepting an
intermediate repaint.

## Deterministic Gates

Git-backed fixtures and child processes must clear Git's repository-local environment variables;
`cwd` and `git -C` do not isolate a command when variables such as `GIT_DIR` or `GIT_WORK_TREE`
are inherited. Remove linked worktrees and other Git-created resources through Git before deleting
their directories.

`pnpm build` computes one immutable Observer build identity from the current
Git `HEAD`, the sorted production inputs from tracked plus untracked-nonignored
working-tree contents, and the resulting production package `dist` contents.
Test trees and TypeScript test/spec files are excluded to match Turbo's
production build inputs. It rebuilds, verifies the inputs did not move, then
atomically publishes `packages/runtime/dist/station-build-id`. Source
CLI/Observer output and a binary compiled from that output therefore share an
identity; rebuilding unchanged inputs and outputs reuses it. A source process
verifies both halves before first adopting the sidecar, then reuses that
verified identity without further Git or hash I/O for its lifetime. That first
verification prevents a scoped compile, cache restore, source edit, or failed
build from silently claiming an older identity. Run `pnpm build` again; do not
copy or retain this sidecar across a failed or different build.

The deterministic local gate is:

```bash
pnpm test:all
```

It runs build, typecheck, lint, unit tests, contract tests, integration tests,
diagnostics tests, the scripted-agent lane, setup and Observer lifecycle E2E
coverage, and a production Observer SQLite restart smoke. It intentionally
excludes real provider lanes.

After root `pnpm install`, Lefthook runs the broader local gate before pushes:

```bash
pnpm test:pre-push
```

In addition to `test:all`, it checks cross-runtime SQLite compatibility, the
Station renderer, the native PTY implementation, and the compiled binary on
the developer's current platform. Install both the root pnpm dependencies and
the `station/` Bun dependencies before pushing.

Ready, non-draft pull requests run `pnpm test:pre-push` once on
`ubuntu-24.04`; release tags call that same full gate before adding the four
native build and draft-install targets. Both that gate and `smoke:release` must
pass before any native release build starts.
Draft pull request activity allocates no
runner, including synchronization before `ready_for_review`.
Pushes to `main` run only build, typecheck, and lint as a cheap post-merge
smoke. The repository ruleset must require the pull-request `standard-ci` check
and block direct `main` pushes; the cheap smoke is a post-merge backstop, not a
substitute for the full required gate.

Useful focused commands:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:contracts
pnpm test:integration
pnpm test:e2e:observer
pnpm test:observer-claim:cross-runtime
pnpm test:sqlite:bun
pnpm test:diagnostics
pnpm test:agent:scripted
pnpm smoke:release
pnpm smoke:install
```

`pnpm test:all` includes `pnpm smoke:install`. The installer smoke uses fake
authenticated GitHub responses and temporary homes, including startup-file
non-interaction, safely evaluated minimal-PATH guidance, physical launcher
resolution, and normalized-colon preflight coverage. It is deterministic, does
not download a real release, and does not read or modify real shell startup
files. The single Ubuntu CI gate runs it once. On a heavily contended local host, run
`STATION_INSTALL_SMOKE_TIMEOUT_SCALE=4 pnpm smoke:install` to scale only the
harness deadlines; the default and hosted gate remain strict.
The release workflow builds and smokes the compiled binary on all four native
targets, then installs each actual draft asset with real platform utilities.

Run `pnpm test:sqlite:bun` after `pnpm build` with Bun 1.3.14 available. It
creates observer databases under Node and Bun, then reopens each database under
the other runtime to verify the shared SQLite contract and migrations. It also
runs the permanent boot-claim race: 50 alternating Node/Bun two-process rounds,
three-contender rounds, and killed-owner recovery with stable inode and
`integrity_check=ok`; this gate makes no fairness claim. Both the local pre-push
gate and the hosted `standard-ci` job run these checks.

`pnpm test:e2e:observer` drives the built production Observer through cold and
real stale-socket races, XDG/state divergence, explicit paths with spaces,
claim-held no-side-effect behavior, pidfile publication, compatible-build reuse,
same-version build-identity handoff and refusal, cross-version graceful handoff,
and clean restart while the persistent claim remains. The compiled binary smoke
also builds a second artifact from one production-source change in an isolated
detached worktree, queries both exact selectors, proves lower-to-higher
same-version replacement and post-handoff mutation refusal, then proves
source/compiled ordering and Station Host PTY continuity across both Observer
replacements. Run both after `pnpm build` when changing startup, socket
ownership, pidfiles, or claim lifecycle behavior.

For focused Station PTY work, run both implementations explicitly:

```bash
cd station
bun run test:pty                 # existing Node/node-pty bridge smoke
bun run build:ctty-helper
bun run test:pty:bun             # Bun.Terminal + controlling-terminal helper
```

Both PTY lanes include deterministic child-environment probes for local and
Station Host-backed spawns, so capability-policy changes must keep the two
implementations equivalent.

To daily-drive the Bun implementation in the isolated devbox, return to the
repo root and start a fresh host with the selector in its environment:

```bash
pnpm station:devbox stop
STATION_PTY_IMPL=bun pnpm station:devbox start
pnpm station:devbox logs --follow
```

The `host.start` record in `.dev-state/observer/logs/station-host.jsonl` should
report `ptyImplementation` as `bun`. `station:devbox restart` deliberately
preserves the existing host, so changing PTY implementations requires `stop`
followed by `start`. Open a shell pane, run `sleep 30`, press Ctrl-Z, run `fg`,
then press Ctrl-C. Finally stop the devbox and confirm no pane payload remains.

For standalone-binary work, Bun 1.3.14 is required. From `station/`, install the
native UI dependencies, return to the repository root, then build and run the
binary smoke:

```bash
bun install
cd ..
pnpm build:binary -- --version 0.0.0-local
pnpm smoke:binary -- --expected-version 0.0.0-local
```

The staged artifact is `station/dist/bin/stn`, with `stn-ingress` and
`stn-tmux-popup` symlinks beside it. The build is native-only: it compiles the
portable C controlling-terminal helper with the host `cc`, bundles the Pi
extension, and selects the matching Bun target. Intel/x64 builds use Bun's
baseline target for older CPU compatibility. The smoke runs the binary with a
child `PATH` that contains neither Node nor Bun and covers Observer self-spawn,
ingress and popup argv0 dispatch, packaged assets, hostile working-directory
configuration, and a real host-backed Bun PTY.
The `0.0.0-local` display version exercises cross-version Observer handoff. The
smoke first builds two independently stamped binaries at that display version,
runs the lower identity as incumbent, replaces it with the higher identity, and
verifies that a later mutating command from the loser is refused without
changing the Observer, Station Host, or live PTY. It requires a committed clean
checkout so the detached-worktree artifact has one controlled source delta.

To inspect the UX manually after the smoke:

```bash
./station/dist/bin/stn
```

Open a shell pane, run `sleep 30`, press Ctrl-Z, run `fg`, then press Ctrl-C.
The isolated or configured `logs/station-host.jsonl` should record
`ptyImplementation` as `bun`.

To verify binary host upgrades, build two copies with distinct prerelease
versions (for example `0.7.0-host-a` and `0.7.0-host-b`) and use an isolated
config with `station_persistent_agents = true`. Start A, open a hosted terminal,
print a recognizable marker, leave a long command running, and exit the UI so
the host survives. Because Observer version eviction is separate B3 work,
explicitly stop the A observer and start B's observer before launching B.

B must report `HOST_UPGRADE_BLOCKED` with both versions and the live-terminal
count without opening or rewriting the saved layout. Reopen A and confirm the
command and marker scrollback survived. Close every hosted agent and auxiliary
terminal, retry B, then open a hosted terminal so the stopped idle host is
replaced on demand. The next `host.start` record in `logs/station-host.jsonl`
must show B's build and protocol versions. Legacy or different-protocol hosts
refuse automatic replacement and must be stopped explicitly only after their
sessions are accounted for.

## Private Binary Release

Before tagging, an administrator must enable GitHub immutable releases; the
workflow token cannot read that administration setting. The workflow validates
that release tags use supported release SemVer without `+` build metadata,
exactly equal `v${package.json.version}`, come from a commit on `origin/main`,
and have no existing GitHub release. Pushing a `v*` tag runs the callable
standard CI workflow, `pnpm smoke:release`, native binary build and smoke jobs
for all four supported targets, archive/checksum assembly, and an authenticated
installer smoke against the resulting GitHub release draft. The four native
release builds use one archive-packaging helper, and the draft-install jobs
consume those exact uploaded archives. Draft acceptance revalidates the tag but
fetches `scripts/install.sh` by the validated commit SHA, then passes the tag
with `--version`; a moved tag cannot substitute different installer code. After
all four native installs pass, the workflow re-downloads the five draft assets,
verifies them against the build checksum, and uploads an immutable
`accepted-release-candidate-*` Actions artifact containing the commit, release
ID, asset IDs, and checksums. Draft install and candidate-recording jobs use
contents write permission because GitHub exposes draft releases only to
identities with push access, but their steps only read release metadata and
assets. Only draft creation and manual promotion mutate releases. The tag
workflow never publishes the draft automatically.

The current immutable binary candidate is `v0.7.1-rc.3`. `v0.7.1-rc.2` is the
prior published binary; the earlier `v0.7.0` and `v0.7.1-rc.1` candidates
remained unpublished:

1. Enable GitHub immutable releases, confirm the release commit is on `main`
   with `package.json` and runtime reporting at `0.7.1-rc.3`, then create and
   push `v0.7.1-rc.3`.
2. Confirm every release job passed and the successful run contains exactly one
   `accepted-release-candidate-0.7.1-rc.3-attempt-*` artifact.
3. Install the draft on clean native machines for `darwin-arm64`, `darwin-x64`,
   `linux-arm64`, and `linux-x64`, then complete the manual UX gate below.
4. As the second binary release, install `v0.7.1-rc.2`, upgrade to the accepted
   candidate, explicitly reinstall `v0.7.1-rc.2`, then reinstall the candidate.
   Confirm the complete version and all three launchers after every transition.
5. Dispatch `promote-release.yml` with the successful release run ID, tag
   `v0.7.1-rc.3`, and the manual-acceptance confirmation. It rechecks the
   successful run SHA, immutable candidate manifest, tag commit, release ID,
   asset IDs, and all archive hashes immediately before publishing that exact
   draft.

Published tags and assets are immutable. Once two binary releases exist,
recovery may explicitly reinstall the prior version, but the release line moves
forward with a superseding patch; it never deletes, retags, or overwrites a
published release. The source Homebrew formula is a separate manually
dispatched workflow and is not part of this binary release gate.

If a transient workflow failure leaves an unpublished draft, delete only that
draft and rerun the unchanged tag workflow. If the source needs a fix, leave
the pushed tag alone and use the next prerelease tag. Never delete or mutate a
published release.

Installer acceptance uses both `<install-dir>/.station-install.lock` and
`<data-home>/station/.station-install.lock`. Their sole corresponding
`<install-dir>/.station-install.lock/owner-*` and
`<data-home>/station/.station-install.lock/owner-*` files record the PID,
requested tag or `latest`, and the token embedded in each filename. The command
lock is acquired first and the license lock second, with the duplicate path
skipped, and they are released in reverse order. Cleanup removes only its
token-specific owner file and revalidates the directory inode so it cannot
remove a replacement owner's lock. Either refusal must name the lock and
readable owner PID, state that the existing
Station installation was unchanged, and tell the user to wait and retry; a
license-lock refusal also releases the command lock without making a release
API request. The installer never auto-removes an uncertain lock. Only after
confirming that no installer with the recorded PID is alive may an operator
remove the affected lock directory manually and retry.

The staged binary's `--version` probe must finish within 10 seconds. Its
watchdog returns 124 for timeout and 125 for timer failure, bounds output at the
filesystem level, TERM/KILLs and reaps the probe, removes common GitHub and
Actions token variables from the child environment, and shows at most 4096
sanitized bytes of compatibility stderr. Every potentially blocking `gh`
operation is a tracked file-backed child; HUP, INT, and TERM forward to that
child, use the same TERM/KILL/reap cleanup, and exit 129, 130, and 143.

The verified `stn` rename is the sole runtime commit point. Immediately before
it, both aliases must still be exact symlinks to `stn` and binary/license
destinations must retain accepted types. A failure with the staged `stn` still
present restores the old license and removes only aliases this attempt created.
If the staged `stn` disappeared, activation is ambiguous: preserve the new
license and aliases, exit nonzero, and print the absolute `stn --version`
inspection command without claiming the previous installation was unchanged.

SIGKILL cannot clean up and may leave either lock or a stage behind. Atomic
rename makes process-level readers observe a coherent complete old or new
binary. Power loss is different: because the installer does not fsync the file
or containing directories, it makes no post-power-loss durability guarantee;
old/new cross-filesystem `LICENSE` metadata may also remain.

### VirtualBuddy clean-mac preparation

Use a fresh VirtualBuddy guest for the primary macOS first-run lane. The guest
covers only the native target reported by `uname -m`; it does not replace the
other release targets. Install macOS updates, Xcode Command Line Tools,
Homebrew, GitHub CLI, Node.js 24, and Codex or another supported agent CLI, then
verify the development-ready baseline:

```sh
sw_vers
uname -m
xcode-select -p
git --version
brew --version
gh --version
node --version
codex --version
```

Take a `dev-ready-before-station` snapshot before authenticating. Do not
preinstall Station, Worktrunk, tmux, diffnav, or git-delta; this lane must prove
that guided setup identifies and installs the missing Station dependencies.
Authenticate GitHub and confirm private-repository access:

```sh
gh auth login --hostname github.com
gh auth status --hostname github.com
gh repo view jeremy0dell/station
```

Start the selected agent CLI once and complete its normal sign-in. Then create
a disposable Git project for the acceptance run:

```sh
mkdir -p "$HOME/Developer/station-smoke"
cd "$HOME/Developer/station-smoke"
git init -b main
printf '# Station installation smoke test\n' > README.md
git add README.md
git -c user.name='Station Smoke' \
  -c user.email='station-smoke@example.invalid' \
  commit -m 'Initial commit'
```

Before installing, `command -v stn` must print nothing and
`~/.local/bin/stn` must not exist. Do not use the published-install recipe for
an unpublished candidate; wait for a successful `release` workflow run and use
its numeric run ID in the accepted-candidate recipe below.

Install the accepted candidate from a successful release workflow run on each
clean test machine. Set `release_run_id` to that run's numeric ID; the recipe
downloads its candidate manifest and uses the exact draft ID and commit that
promotion will verify:

```sh
(
  set -eu
  umask 077
  export GH_HOST=github.com
  tag=v0.7.1-rc.3
  version=${tag#v}
  release_run_id=123456789
  case "$release_run_id" in
    ''|*[!0-9]*) echo "release_run_id must be numeric" >&2; exit 1 ;;
  esac
  test "$(
    gh run view "$release_run_id" --repo jeremy0dell/station \
      --json conclusion --jq '.conclusion'
  )" = success
  test "$(
    gh run view "$release_run_id" --repo jeremy0dell/station \
      --json workflowName --jq '.workflowName'
  )" = release
  run_attempt="$(
    gh run view "$release_run_id" --repo jeremy0dell/station \
      --json attempt --jq '.attempt'
  )"
  case "$run_attempt" in
    ''|*[!0-9]*) echo "release run attempt must be numeric" >&2; exit 1 ;;
  esac
  candidate_dir="$(mktemp -d)"
  installer="$(mktemp)"
  trap 'rm -rf "$candidate_dir"; rm -f "$installer"' EXIT
  gh run download "$release_run_id" \
    --repo jeremy0dell/station \
    --name "accepted-release-candidate-$version-attempt-$run_attempt" \
    --dir "$candidate_dir"
  manifest="$candidate_dir/manifest.json"
  test -f "$manifest"
  manifest_field() {
    node -e '
      const { readFileSync } = require("node:fs");
      const value = JSON.parse(readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      if (typeof value !== "string" && typeof value !== "number") process.exit(1);
      process.stdout.write(String(value));
    ' "$manifest" "$1"
  }
  manifest_tag="$(manifest_field tag)"
  manifest_repository="$(manifest_field repository)"
  manifest_run_id="$(manifest_field workflowRunId)"
  manifest_run_attempt="$(manifest_field workflowRunAttempt)"
  commit="$(manifest_field commit)"
  release_id="$(manifest_field releaseId)"
  test "$manifest_tag" = "$tag"
  test "$manifest_repository" = jeremy0dell/station
  test "$manifest_run_id" = "$release_run_id"
  test "$manifest_run_attempt" = "$run_attempt"
  printf '%s\n' "$commit" | grep -Eq '^[0-9a-f]{40}$'
  case "$release_id" in
    ''|*[!0-9]*) echo "candidate release ID must be numeric" >&2; exit 1 ;;
  esac
  test "$(gh api "repos/jeremy0dell/station/commits/$tag" --jq '.sha')" = "$commit"
  gh api --method GET \
    -H 'Accept: application/vnd.github.raw+json' \
    -f ref="$commit" \
    repos/jeremy0dell/station/contents/scripts/install.sh > "$installer"
  test -s "$installer"
  sh -n "$installer"
  STATION_INSTALL_RELEASE_ID="$release_id" sh "$installer" --version "$tag"
)
```

This draft-only environment variable is for release acceptance; normal installs
use the published-release recipe in [Install](install.md).

For the primary VirtualBuddy user-flow pass, start with `XDG_DATA_HOME` unset
and `~/.local/bin` absent from `PATH`, and retain the complete installer output.
Follow the installer's printed current-shell block exactly; on this clean lane
it must name all three missing launchers and end by running `stn setup`. Allow
guided setup to install Worktrunk, tmux, diffnav, and git-delta, select the
authenticated agent, and enable the desired provider hooks and tmux binding.
Confirm setup writes a zero-project config without adopting the disposable
repository, then run:

```sh
stn --version
stn setup check --json
stn doctor
stn tui
```

On the welcome screen, press `Enter` or `Space`. On the empty dashboard, press
`Enter` or `A` on **Add your first project** and select the disposable Git
repository. Then press `N`, create a session with the authenticated agent, and
ask it to edit the disposable README. Confirm the transcript and diff appear,
then quit and reopen `stn tui` and confirm the session remains.

If the compiled tmux binding was enabled, use `tmux prefix + Space` for the cold
open, close the popup with the same chord, and use it again for a warm reopen.
Confirm both opens are silent in the calling pane and the warm open reuses the
existing `_station-ui` session. Finally confirm the installer did not read or
edit shell startup files. Copy the one future-shell export it printed into a
shell configuration you choose,
open a new login shell, and verify all three physical launcher resolutions and
`stn --version`. The installer, not the user-facing PATH text alone, must have
verified those launchers after installation.
Preserve the exact command and output at the first failure; for a runtime
failure with no known trace ID, start with `stn debug trace --latest-failure`.

For each target, install through the authenticated script into a clean home and
manually verify the actual user experience, not a dashboard override:

1. Install into a clean default `HOME` with `XDG_DATA_HOME` unset and an install
   directory absent from `PATH`. Confirm all three missing launchers are named,
   every shell startup file remains absent, the one future-shell export is
   safely quoted for a user-chosen shell configuration, the current-shell block
   runs `hash -r` plus `stn setup`, and the absolute `stn` fallback works.
2. Repeat with existing zsh and bash startup files containing distinct sentinel
   bytes and modes, startup-file symlinks, an older launcher shadowing the
   install, and custom install directories containing spaces and apostrophes.
   Confirm two installs leave every startup file, inode, mode, symlink, and
   target unchanged. Copy the printed export manually into the file you choose,
   open a new login shell, and physically verify all three launchers. Also
   confirm a normalized install path containing `:` fails before any GitHub
   request or installer-created path. With all three launchers already resolving
   physically to the install directory, confirm the short `Next: run stn setup`
   success message.
3. With the installed binary's runtime `PATH` containing neither Node nor Bun,
   run bare `stn` outside tmux. Confirm the real OpenTUI first-run screen draws
   and connects to a healthy Observer.
4. Open a shell pane, run `sleep 30`, press Ctrl-Z, run `fg`, then press Ctrl-C.
5. Run `stn setup` from `HOME` or Desktop. Confirm it creates a zero-project
   config without adopting that directory. In the open TUI, press `Enter` on
   **Add your first project**, choose a Git repository, and confirm the TUI
   reconnects and shows it after activation on the same Observer socket.
6. Accept the compiled install's optional popup binding and confirm
   `~/.tmux.conf` contains the marked generated command and exact sibling
   `stn-tmux-popup` fallback. Start a fresh tmux server with
   `PATH=/usr/bin:/bin`; `tmux prefix + Space` must open the popup without a
   restart or tmux PATH mutation. Change the marked key, source the file, rerun
   setup, and confirm the custom key is preserved. Also confirm `stn popup`
   remains the direct diagnostic path.
7. Deliver a provider event through `stn-ingress` and confirm it appears in
   Station.
8. Complete the local `0.7.0-host-a` → `0.7.0-host-b` procedure above with a
   live hosted PTY and confirm `HOST_UPGRADE_BLOCKED` preserves its terminal and
   scrollback before the idle host is replaced.
9. In terminal A, continuously run the installed `stn --version`. In terminal
   B, repeatedly reinstall the draft. Terminal A may print only `0.7.1-rc.3`:
   never command-not-found or malformed output. After each transition, confirm
   `stn-ingress` and `stn-tmux-popup` still link to `stn`, so the runtime never
   has mixed entrypoints. Repeat the same checks while alternating the draft
   with published `v0.7.1-rc.2` in both directions.
10. In an isolated home, test abandoned locks separately at
    `<install-dir>/.station-install.lock` and
    `<data-home>/station/.station-install.lock` with representative owner
    metadata. Follow each printed inspection, dead-PID confirmation, manual
    removal, and retry instruction exactly; never remove a lock while its owner
    may be alive.
11. Interrupt a real authenticated upgrade with Ctrl-C. Confirm the prior TUI
   still opens, the installer exits with status 130 and leaves no owned lock or
   stage, then retry successfully.
12. Run `promote-release.yml` only after steps 1-11 pass. Confirm it selects the
    successful release run's `accepted-release-candidate-*` artifact, verifies
    the exact draft asset IDs and hashes, and publishes that draft without
    replacing any asset.

Record the oldest supported macOS version or built-against glibc version in the
release notes. Signing and notarization are not part of the initial private
binary release; integrity is the authenticated GitHub asset plus `SHA256SUMS`
verification and immutable publication.

For CI install parity, use:

```bash
CI=true pnpm install --frozen-lockfile --ignore-scripts
pnpm test:all
```

## Real And E2E Lanes

Real provider and broader e2e lanes are opt-in:

```bash
pnpm test:e2e
pnpm test:e2e:real
pnpm test:e2e:worktrunk:real
STATION_REAL_TMUX=1 pnpm test:tmux-popup:real
pnpm station:devbox:tmux:smoke
pnpm test:e2e:claude:real
pnpm test:e2e:codex:real
pnpm test:e2e:cursor:real
pnpm test:e2e:pi:real
pnpm test:e2e:opencode:real
pnpm test:e2e:real:local
pnpm test:e2e:real:local tests/e2e/real/real-native-tui-mouse.test.ts
pnpm test:e2e:real:codex-hooks
```

The real tmux popup lane requires the root pnpm dependencies and the `station/`
Bun dependencies, Bun 1.3.14, Python 3, tmux, and these prerequisite builds:

```bash
pnpm build
pnpm build:binary -- --version "$(node -p 'require("./package.json").version')"
```

The compiled acceptance artifact must use the checkout's package display
version so its managed-binding signature matches the source-side fast-path
builder. `pnpm station:devbox:tmux:smoke` requires only the source build
(`pnpm build`); the compiled popup lane additionally requires
`pnpm build:binary`.

Set `STATION_TMUX_BIN` when the tmux executable is not available as `tmux`. The lane
creates a disposable Git project and isolates `HOME`, the XDG directories,
config, Observer and Host sockets, state, layout, and the Codex, Claude, Cursor,
and OpenCode homes. It addresses tmux only through a private
`tmux -L <unique-label> -f /dev/null` server. It aggregates cleanup failures,
verifies that its recorded processes and temporary root are gone, and remains
excluded from ordinary PR and `main` CI.

The lane also exercises the compiled generated binding. Its deterministic
dashboard source connects through the normal Observer protocol socket and uses
a strictly parsed snapshot; it is never injected into the renderer store. Warm
reopen must retain the hidden session, renderer, and Observer PIDs even with an
invalid config. Fast-path and fallback failures must produce no pane output, leave
`#{pane_in_mode}` at `0`, and return control without an Escape dismissal. Use
direct `stn popup` when detailed failure output is needed.

Use `pnpm setup:system:check` before real lanes. Real lanes may require `STATION_REAL_*` flags, installed provider CLIs, credentials, tmux, model access, and isolated temporary projects. They must not become required for ordinary PR or `main` CI.

## Implementation Discipline

- For meaningful behavior changes, work red-first: write or update focused tests, observe the expected failure or characterize current behavior, implement, and keep the relevant gate green.
- Keep slices narrow. Prefer one contract, provider, observer, TUI, or diagnostics change at a time unless the behavior requires a vertical path.
- Current code, tests, runtime traces, and deterministic fixtures are stronger evidence than historical plans.
- Do not introduce production behavior through docs-only changes.

## Architecture Documentation

- Read [Observer Architecture](observer-architecture.md) before changing Observer boundaries,
  composition, state authority, lifecycle, concurrency, or persistence responsibilities.
- New or materially changed Observer ports, adapter entrypoints, use cases, shared policies,
  and composition roots must follow
  [Architecture Documentation](architecture-documentation.md).
- Update the Observer architecture in the same change when a boundary, dependency rule,
  runtime flow, state lifetime, or registered deviation changes. Ordinary helper refactors do
  not require architecture-document churn.
- Apply role markers to touched seams. Do not classify every exported helper or perform an
  unrelated repository-wide marker backfill.

## TUI Work

TUI work has additional OpenTUI/React and terminal-layout expectations. The terminal UI is the OpenTUI renderer in `station/` (package `@station/workspace`, built on `@opentui/core` + `@opentui/react` + `react`). Use [TUI development](tui.md) before changing `station/` components, hooks, sources, keymaps, selectors, popup behavior, or renderer tests.

## TypeScript And Data Rules

- `exactOptionalPropertyTypes` is intentional. Preserve the difference between an absent optional field and a field set to `undefined`.
- For complex mappers, persistence row conversion, diagnostics construction, error shaping, and provider payload parsing, prefer typed local builders with explicit `if` assignments.
- Small conditional spreads are acceptable when local and obvious.
- Do not use `...(await somePromise)` in production array or object construction. Await into a named local first.
- Use strict schemas for untrusted input and shared payload formats. Avoid parallel hand-written validators for the same shape.
- Treat `unknown` as a boundary-only type. Parse JSON, TOML, CLI output, hooks, and provider payloads once with a strict Zod schema or contract parser, then pass typed values inward.
- Use idiomatic TypeScript and `SafeError` shapes. At error boundaries, convert unknown failures through the repo's SafeError helpers instead of probing Error-like objects by hand.
- If code is `===`-checking JavaScript primitive type strings (`"string"`, `"number"`, `"boolean"`, `"object"`), it is usually the wrong shape even in small helpers: use a schema, discriminated union, inferred type, or typed builder instead.
- Keep primitive `typeof` checks only for truly generic JavaScript interop, recursion, or error-normalization boundaries where no typed contract can exist, and keep them local.
- Do not write little JavaScript-style type helper clusters such as `isRecord`, `asRecord`, `stringField`, `numberField`, or repeated `"key" in value` / `typeof value.foo === ...` checks when a shape already has, or should have, a schema or discriminated TypeScript type.
- If a payload shape is shared, define it in `packages/contracts` and infer the TypeScript type from the schema. If it is provider-private, keep the schema local to the provider adapter/parser.
- Inside already-typed code, use discriminated unions, exhaustive `switch` statements, typed builders, and inferred schema types instead of runtime property probing.
- Runtime shape probing is acceptable for generic recursion, redaction, error normalization, or the first step before schema parsing; keep it small, local, and avoid duplicating a schema.
- Provider-specific diagnostics and behavior must stay behind provider or integration boundaries.
- Do not move raw provider payloads into contracts, normal TUI rendering, protocol-facing shapes, or observer core logic.
- Do not make observer/core scrape provider-specific keys from generic `providerData`. Normalize those values at the provider boundary into contract fields, correlation fields, or provider-owned schema data.

## Agent Guidance Maintenance

- Keep always-loaded guidance concise. `AGENTS.md` should route agents and preserve hard repo quirks, not duplicate long plans.
- Use just-in-time references. Put detailed architecture, development, and debugging guidance in living docs that agents open only for relevant tasks.
- Scope guidance by task and path when possible. A terminal-boundary rule, docs workflow, or runtime-debug procedure should not force every agent to read an old rebuild plan.
- Review instructions periodically. Remove stale mandates, classify historical docs clearly, and update living docs when current code/tests prove a different truth.
- Avoid conflicting instructions. If an old plan, current doc, current test, and runtime evidence disagree, resolve the conflict explicitly instead of adding another overlapping rule.
