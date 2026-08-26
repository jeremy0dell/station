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

## 3. Return current run status from discovery

`discoverRuns()` returns complete `HarnessRunObservation` values, including a
provider-normalized present-tense `status`. Do not retain a second per-run
classification callback or ask Observer/core to reinterpret provider data.
Terminal-bound providers that lack stronger status evidence return typed
`unknown` status; event reports may overlay newer working, attention, idle, or
exited evidence during live projection and reconcile.

## 4. Write the normalizer

In `integrations/harness/<name>/src`:

- Parse payloads with provider-local strict zod schemas (no shared
  hand-written validators, no `isRecord` helpers).
- Map to `HarnessEventReport`: `status` with `attention` kind for every
  user-blocking state, strongest available `correlation` ids, deterministic
  `reportId`/`coalesceKey` from native ids.
- When a provider's hook types split native session ids for one user-visible
  turn, emit a pane-stable `nativeSessionId` equal to `harnessRunId` whenever
  Station terminal identity is present. Keep the unstable provider ids in
  `providerData`.
- Corroborate Station IDs inherited from the process environment with
  provider-origin evidence and any required Station launch context. When they
  contradict, retain native identity and origin diagnostics, withhold Station
  correlation, and set the typed `diagnostics.correlationIssue` rather than
  guessing from provider-specific paths.
- A tool call that *is* a user request must map to `needs_attention`, not tool
  activity.
- Never leak provider vocabulary past the boundary: core reads contract
  fields only.

## 5. Fixtures are the tests and the docs

Turn each census capture into a unit test: feed the captured payload sequence
through the normalizer and assert status/attention per event. The status
mappers are pure — no timing, no live processes. The fixture matrix is the
integration's documentation of record; prose goes stale, fixtures fail loudly.

## 6. Doctor and setup

- Hook transports: wire `stn hooks doctor <name>` so installation is
  verifiable, and remember doctor verifies *installation*, not build identity —
  check that `stn` and `stn-ingress` on PATH resolve to the same checkout.
- If hooks are declarative, implement `hookHealth()` as a read-only mapping to
  the strict provider-neutral contract and `reconcileHooks()` as the only
  orchestration mutation capability. Resolve plan, install, and doctor from the
  same provider profile and paths; reuse the provider's existing writer;
  preserve backups; serialize overlapping entry points; and make the second
  reconciliation a doctor-verified no-op.
- Keep provider paths, file parsing, native diagnostics, raw commands, config
  fragments, and payloads inside the integration. Neutral results expose only
  bounded statuses, `changed`/`verified`, `SafeError`, and an enumerated follow-up
  action. Build optional fields explicitly for `exactOptionalPropertyTypes`.
- Automatic reconciliation must fail closed on foreign or unknown ownership and
  never accept takeover authority. The manual confirmed install surface remains
  the only ownership-transfer path. Admission covers every generated artifact
  reference the writer can replace or remove, including references outside the
  currently requested state directory; a valid marker for the same canonical
  launcher permits routine migration, while missing, relative, unmarked, or
  differently owned references require that explicit takeover.
- Convert the caller timeout to one monotonic deadline before provider
  inspection, then shrink and check it through lock acquisition and the
  under-lock replan. Honor cancellation only before the first durable mutation;
  once mutation begins, finish the provider writes and doctor verification.
  Artifact locks must serialize every resolved write target, release on process
  death, reject unsafe lock-file types, and never reclaim concurrency by age.
- Add the harness to setup checks if it needs system dependencies.
- Setup tracking preparation must call the same typed provider installer in-process through the setup adapter. Return only installed/changed and backup-path commit evidence; provider plans, commands, before/after source, and other native result fields must not cross the setup port or print in guided output.

## 7. Support launch preflight

- Report `canLaunch: false` only when the adapter cannot construct or execute a launch.
- Make `health()` freshly prove CLI/runtime availability without conflating unknown authentication or trust with unavailability. Preserve actionable provider errors in `lastError`.
- Implement provider-local `hooksStatus()` when Station tracking artifacts are required for a managed launch. Report whether hooks were requested, whether they are installed, and the exact missing artifacts so shared policy can provide config-aware remediation.
- When `reconcileHooks()` is implemented, launch and resume preflight request it
  before the delivery gate and before terminal or provider mutation. An enabled
  repair is successful only after doctor verifies the same resolved artifacts.
- Omit `hooksStatus()` when the provider has no equivalent requirement. The shared launch policy intentionally permits such providers; do not invent a hook gate for them.
- Keep setup and doctor richer than launch policy. Launch preflight consumes capability, health, and hook facts transiently and must not introduce provider-specific readiness state into Observer/core.

## 8. Verify live

One end-to-end pass per attention scenario: trigger it in the real harness,
confirm the row flips and holds until resolved, and confirm the census log
line shows `projected: true` with the expected `attention` kind. Definition of
done: fixture matrix green + one live pass per attention scenario.
