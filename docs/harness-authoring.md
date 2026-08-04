# Adding or Upgrading a Harness

Checklist for integrating a coding-agent harness, or re-verifying one after it
ships new behavior. The contract you are implementing is
`docs/harness-signals.md`; the capture workflow is the Harness Event Census
section of `docs/debugging.md`.

## 1. Declare transports

Decide how events reach Station and what identity each transport carries:

| Transport | Mechanism | Identity strength |
| --- | --- | --- |
| hook | harness spawns `stn-ingress` with JSON on stdin | strong only when provider origin evidence corroborates inherited session env |
| stream | app-server / JSON-RPC subscription in the provider | strong (native ids) |
| file | native session/log tailing inside the observer | weak unless ids are parsed from content/filename |
| poll | process table / status endpoint | run-level only |

Prefer one transport per fact. If two transports can report the same fact,
they must derive the same `coalesceKey` from a harness-native id so they
coalesce instead of racing.

## 2. Run the census

Before writing mapping code, capture what the harness actually emits per
scenario. Minimum matrix: clarifying question during planning, plan approval,
standalone question, tool/permission approval, user answers, user aborts,
turn completes, session start/end, compaction.

Drive each scenario in the harness TUI while watching
`stn debug logs "Harness event report"` and the harness's own native session
log. Save raw payloads — they become fixtures.

## 3. Write the normalizer

In `integrations/harness/<name>/src`:

- Parse payloads with provider-local strict zod schemas (no shared
  hand-written validators, no `isRecord` helpers).
- Map to `HarnessEventReport`: `status` with `attention` kind for every
  user-blocking state, strongest available `correlation` ids, deterministic
  `reportId`/`coalesceKey` from native ids.
- Corroborate Station IDs inherited from the process environment with
  provider-origin evidence and any required Station launch context. When they
  contradict, retain native identity and origin diagnostics, withhold Station
  correlation, and set the typed `diagnostics.correlationIssue` rather than
  guessing from provider-specific paths.
- A tool call that *is* a user request must map to `needs_attention`, not tool
  activity.
- Never leak provider vocabulary past the boundary: core reads contract
  fields only.

## 4. Fixtures are the tests and the docs

Turn each census capture into a unit test: feed the captured payload sequence
through the normalizer and assert status/attention per event. The status
mappers are pure — no timing, no live processes. The fixture matrix is the
integration's documentation of record; prose goes stale, fixtures fail loudly.

## 5. Doctor and setup

- Hook transports: wire `stn hooks doctor <name>` so installation is
  verifiable, and remember doctor verifies *installation*, not build identity —
  check that `stn` and `stn-ingress` on PATH resolve to the same checkout.
- Add the harness to setup checks if it needs system dependencies.
- Setup tracking preparation must call the same typed provider installer in-process through the setup adapter. Return only installed/changed and backup-path commit evidence; provider plans, commands, before/after source, and other native result fields must not cross the setup port or print in guided output.

## 6. Support launch preflight

- Report `canLaunch: false` only when the adapter cannot construct or execute a launch.
- Make `health()` freshly prove CLI/runtime availability without conflating unknown authentication or trust with unavailability. Preserve actionable provider errors in `lastError`.
- Implement provider-local `hooksStatus()` when Station tracking artifacts are required for a managed launch. Report whether hooks were requested, whether they are installed, and the exact missing artifacts so shared policy can provide config-aware remediation.
- Omit `hooksStatus()` when the provider has no equivalent requirement. The shared launch policy intentionally permits such providers; do not invent a hook gate for them.
- Keep setup and doctor richer than launch policy. Launch preflight consumes capability, health, and hook facts transiently and must not introduce provider-specific readiness state into Observer/core.

## 7. Verify live

One end-to-end pass per attention scenario: trigger it in the real harness,
confirm the row flips and holds until resolved, and confirm the census log
line shows `projected: true` with the expected `attention` kind. Definition of
done: fixture matrix green + one live pass per attention scenario.
