# Adding or Upgrading a Harness

Checklist for integrating a coding-agent harness, or re-verifying one after it
ships new behavior. The contract you are implementing is
`docs/harness-signals.md`; the capture workflow is the Harness Event Census
section of `docs/debugging.md`.

## 1. Declare transports

Decide how events reach Station and what identity each transport carries:

| Transport | Mechanism | Identity strength |
|---|---|---|
| hook | harness spawns `stn-ingress` with JSON on stdin | strong (session env) |
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

## 6. Verify live

One end-to-end pass per attention scenario: trigger it in the real harness,
confirm the row flips and holds until resolved, and confirm the census log
line shows `projected: true` with the expected `attention` kind. Definition of
done: fixture matrix green + one live pass per attention scenario.
