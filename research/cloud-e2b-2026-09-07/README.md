# E2B offline research checks

These checks exercise published SDK behavior, upstream output delivery, and candidate Git result
return using synthetic fixtures. They create no E2B resources, use no credentials, and upload no
repository. Research conclusions and acceptance evidence belong in
[#481](https://github.com/jeremy0dell/station/issues/481). These files do not implement a Station
provider or select a production contract.

## SDK behavior

Prepare a temporary directory outside the checkout with these exact packages. Package installation
downloads public dependencies; the check itself replaces the RPC and Git command implementations
with in-memory fakes. Run it with an empty environment so ambient E2B configuration is absent.

```sh
npm install --prefix /tmp/station-e2b-sdk-check --ignore-scripts --no-audit --no-fund --save-exact \
  e2b@2.46.1 e2b-old@npm:e2b@2.46.0
env -i PATH="$PATH" HOME=/tmp node research/cloud-e2b-2026-09-07/sdk-check.mjs /tmp/station-e2b-sdk-check
env -i PATH="$PATH" HOME=/tmp bun research/cloud-e2b-2026-09-07/sdk-check.mjs /tmp/station-e2b-sdk-check
```

The check invokes the installed JavaScript implementation and checks command shape, stream
deadlines, callback shutdown, binary output, exit evidence, PID-only reconnect, missing controller
fencing, caller cancellation, and Git credential handling. `networkAttempts` counts calls to the
replaced global fetch; the exercised provider operations use the injected fakes. This does not test
HTTP transport, E2B deployment behavior, PTY replay, or real cleanup.

The separate HTTP check runs the same SDK versions against a fake server bound to a random loopback
port. It restricts requests to that origin, uses synthetic account and sandbox tokens, checks both
REST and Connect RPC serialization, and closes every connection on exit.

```sh
env -i PATH="$PATH" HOME=/tmp node research/cloud-e2b-2026-09-07/sdk-http-check.mjs /tmp/station-e2b-sdk-check
env -i PATH="$PATH" HOME=/tmp bun research/cloud-e2b-2026-09-07/sdk-http-check.mjs /tmp/station-e2b-sdk-check
```

The HTTP check covers lifecycle TTL rounding, the mutating reconnect request, credential separation,
null inventory, contradictory error status/body, dropped create responses, process deadlines,
binary framing, and idle-stream cancellation. Injected malformed responses establish SDK boundary
behavior; they do not establish that E2B returns those responses. A successful fake kill does not
prove cloud cleanup.

The npm registry integrity values for the inspected packages are:

| Package | SHA-512 integrity |
| --- | --- |
| `e2b@2.46.0` | `sha512-Q4hVAhrtjvJwoN0BHnVD90B7bQy5KKUf4Ibp08UqdwZyeo14AAyuFmJ8ZIp98FZB67CbupuL4rt3Ein/mGoesw==` |
| `e2b@2.46.1` | `sha512-OqYovS2oFrt4mk737CgfW/RoMadBYK84l5qjKpvbEoOB9KKxaZIXm7YUwOKSRTlijrrwDRX7oZlyPoVXiCpyTw==` |

## Upstream output delivery

Download the pinned public source file before running the offline check. Use a Go toolchain that
supports `slices.Concat`; the experiment was developed against Go 1.26.6. The runner verifies the
source SHA-256, changes only its package declaration in a temporary copy, disables module and
toolchain downloads, and removes its own temporary files on exit.

```sh
curl --fail --location \
  https://raw.githubusercontent.com/e2b-dev/infra/cc7c574233ad98665a7c72a3d37b0af89ae79a71/packages/envd/internal/services/process/handler/multiplex.go \
  --output /tmp/station-e2b-multiplex.go
python3 research/cloud-e2b-2026-09-07/run-multiplex-check.py /tmp/station-e2b-multiplex.go /absolute/path/to/go
```

The check proves that a late subscriber does not receive drained output and that an unread
subscriber blocks a later subscriber until canceled. This is an upstream source experiment,
not evidence that any particular E2B sandbox runs that commit.

## Candidate Git result return

```sh
python3 research/cloud-e2b-2026-09-07/git-return-check.py
```

The check permits only local file transport and uses temporary HOME/config/repositories with hooks
disabled. It compares a commit bundle and a binary full-index patch, verifies the exact result tree,
checks dirty and missing-base receivers, and rejects a truncated artifact with an independent
digest. It also demonstrates that Git fetch can skip pack validation when all advertised objects
already exist. It transfers no real repository and defines no production synchronization policy.
For source preparation, the check demonstrates that `git archive` can omit files through
`export-ignore` and change bytes through `export-subst`. A disposable repository's `info/attributes`
override preserves both fixture files exactly. A full HEAD bundle includes deleted history outside
the selected tree. Source selection and history disclosure therefore require an explicit policy.

## Existing Station behavior to compare

After the repository's frozen install and build, these existing checks exercise Host identity,
controller authority, replay and detach in isolation:

```sh
bun test station/src/host/test/ptyTable.test.ts station/src/host/test/reattach.integration.test.ts
bun run test:unit -- packages/station-host/test/unit/server.test.ts packages/station-host/test/unit/client.test.ts
```

These checks use local scripted terminals. They establish reuse candidates for #447's complete
remote runtime. They do not certify a Linux image, authenticated remote gateway, network failure,
real native or tmux presentation, or E2B pause/resume.

Two additional existing lanes use real local terminals and clean up their owned fixtures. The PTY
lane needs the local controlling-terminal helper; the placement lane requires tmux and Python and
uses a private tmux socket. Run with a disposable HOME and empty environment.

```sh
bun run --cwd station build:ctty-helper
env -i PATH="$PATH" HOME=/tmp STATION_PTY_SMOKE=1 STATION_PTY_IMPL=bun \
  bun test station/src/host/test/ptyTable.smoke.test.ts
env -i PATH="$PATH" HOME=/tmp SHELL=/bin/sh TERM=xterm-256color LANG=en_US.UTF-8 STATION_REAL_TMUX=1 \
  bun run test:tmux-popup:real integrations/terminal/tmux/test/integration/placement-real.test.ts
```

These establish local PTY survival without an attached client and preservation of a real tmux
client's exact target during placement. They do not test E2B or a cloud agent pane.
Without a UTF-8 locale, the placement test failed on tmux 3.7 and next-3.8. The next-3.8 diagnostic
showed underscores replacing the tab delimiters in its client record. Both versions passed with
`LANG=en_US.UTF-8`. Use a UTF-8 locale installed on the target; the example uses the research Mac's
locale.
