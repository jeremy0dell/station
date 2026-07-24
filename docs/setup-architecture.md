# Setup Target Architecture

Status: approved target architecture; not yet implemented. Tracked by
[#276](https://github.com/jeremy0dell/station/issues/276).

This document defines the intended setup architecture. It does not describe the
current implementation and does not imply that the packages, session protocol,
Clack presenter, message catalog, persistence, or Station UI described below
exist today.

Until migration is complete, current setup code and tests remain authoritative
for runtime behavior. A migration slice must preserve existing setup semantics
unless its review explicitly changes them.

The governing documents are [Architecture](architecture.md),
[Observer Architecture](observer-architecture.md),
[Architecture Documentation](architecture-documentation.md),
[Configuration](configuration.md), [Development](development.md), and
[Harness Authoring](harness-authoring.md). Current focused tests, setup E2E
tests, provider contract tests, and runtime evidence remain additional sources
of truth.

## Target Summary

Setup will be a bootstrap-capable, UI-independent session application built as a
functional core with an imperative runtime shell.

```text
facts + intent
  -> pure policies
  -> semantic plan
  -> pure session transitions + requested effects
  -> imperative effect runner through narrow ports
  -> fresh evidence
  -> semantic result

semantic session state
  -> protocol view + typed message references
  -> Clack terminal presenter or Station React/OpenTUI presenter
```

The target has these defining properties:

- Session state is explicit immutable data, not hidden in mutable class
  instances.
- Planning and state transitions are deterministic functions.
- Filesystem, process, provider, persistence, and Observer behavior are behind
  function-valued ports.
- Clack and React/OpenTUI are driving adapters over the same session behavior.
- Decisions return semantic outcomes, never presentation copy.
- Setup copy lives in one typed message catalog.
- Shared wire values use strict schemas in `@station/contracts`.
- Generics enforce small infrastructure relationships; concrete discriminated
  unions explain setup behavior.
- Durable mutations expose preconditions, commit evidence, retry rules, and
  recovery behavior.
- Completion is derived from fresh inspection rather than command success.

## Current Implementation Baseline

The existing implementation already contains useful seams:

- `model.ts` defines strict setup fact and plan schemas.
- `harnessSelection.ts` contains deterministic selection and repair-target
  decisions.
- `planner.ts` derives checks and actions from collected evidence.
- `apply.ts` provides replaceable filesystem and command execution.
- `render.ts` is separate from fact collection.
- Recent cleanup named guided phases, tracking assessment variants, readiness
  predicates, repair-target selection, and completion-rendering steps.
- `@station/config` already owns config loading, validation, path semantics, and
  some source-preserving mutations.
- Tests protect ambiguity, consent, mutation ordering, activation, provider
  artifacts, hostile environments, and fresh final re-probing.

The remaining architectural pressure is that guided orchestration still owns
prompting, policy sequencing, mutation, recovery, and rendering; plans combine
semantic decisions with commands and prose; fact collection and dependencies
are broad; and guided and noninteractive paths coordinate similar phases
separately.

The migration should preserve the semantic concepts exposed by the cleanup
rather than replace them with a generic wizard framework.

## Non-Negotiable Behavior

1. **Setup is bootstrap-capable.** It must run before a valid config or healthy
   Observer exists.
2. **The Station UI is a client.** React/OpenTUI code does not import providers,
   edit TOML, inspect provider homes, run installers, or activate the Observer.
3. **Facts, intent, plan, effects, and evidence are distinct.** Successful
   execution is not proof of readiness.
4. **One policy serves every driving adapter.** Clack, noninteractive CLI,
   read-only checks, machine-readable output, and Station UI do not reimplement
   selection, readiness, or repair rules.
5. **Configured intent remains authoritative.** An unavailable configured
   default is not silently replaced, and ambiguous discovery does not select or
   mutate by catalog order.
6. **Consent and mutation ordering remain explicit.** Consent precedes config
   or provider mutation; config activation precedes provider tracking mutation;
   completion follows fresh probes.
7. **Read-only modes stay read-only.** Any bounded temporary probe exception is
   explicit, cleaned up, and documented.
8. **Provider behavior stays behind integration boundaries.** Setup consumes
   normalized capabilities and evidence.
9. **Setup owns desired config policy.** `@station/config` owns parsing,
   validation, representation-preserving edits, path semantics, and safe
   persistence mechanics.
10. **Durable effects expose commit semantics.** Preconditions, idempotency,
    cancellation, retry, and recovery are explicit. Navigation never replays a
    committed effect.
11. **Application results are structured.** Stable codes, typed details,
    semantic operation identities, and `SafeError` shapes cross boundaries;
    prose and raw commands do not become policy.
12. **Presentation copy has one explicit home.** Policy does not emit sentences
    or message requests. A presentation mapper selects typed message references,
    and the message catalog owns copy.
13. **Complexity has an explicit home.** Branch-heavy policy, workflow
    choreography, external quirks, and presentation mapping do not share one
    function or broad context.
14. **Untrusted input parses once.** CLI input, protocol commands, persisted
    sessions, TOML, and provider output are strictly parsed before entering
    typed behavior.
15. **Transport exists for a real actor.** The session protocol supports the
    production Station UI process boundary; it is not an in-process abstraction
    exercise.

## Functional TypeScript Standard

The setup subsystem uses ordinary TypeScript with a functional bias. It does
not adopt a heavy functional-programming framework.

Prefer:

- plain data and type aliases;
- discriminated unions;
- pure functions for policy, planning, and transitions;
- immutable return values;
- function-valued dependency objects;
- factory functions and closures at composition boundaries;
- `async`/`await` and straightforward loops for ordered effects;
- exhaustive `switch` statements;
- small `Result<Value, Error>` utilities where they clarify boundary failure;
- Zod schemas at untrusted and shared payload boundaries.

Avoid:

- mutable domain classes;
- inheritance and dependency-injection containers;
- a generic `Wizard<State, Step, Answer, Effect, ...>` framework;
- `unknown`-valued workflow records;
- point-free pipelines, higher-kinded abstractions, or monadic APIs;
- helper extraction that preserves the same broad facts, dependencies, and
  boolean flags under a new name.

A useful abstraction names a stable concept, narrows its inputs, returns an
exhaustive result, and reduces what its caller must understand. Some policy and
transition functions will remain branch-heavy; local reasoning is the goal, not
uniformly low line counts.

### Core transition shape

Session behavior is data plus functions:

```ts
type SetupTransition = {
  state: SetupSessionState;
  effect: SetupEffect | null;
};

function transitionSetupSession(
  state: SetupSessionState,
  event: SetupEvent,
): SetupTransition {
  switch (state.state) {
    case "inspecting":
      return transitionInspecting(state, event);
    case "editing":
      return transitionEditing(state, event);
    case "reviewing":
      return transitionReviewing(state, event);
    case "applying":
      return transitionApplying(state, event);
    case "verifying":
      return transitionVerifying(state, event);
    case "blocked":
      return transitionBlocked(state, event);
    case "completed":
    case "cancelled":
      return rejectTerminalTransition(state, event);
  }
}
```

Transitions do not access files, providers, subprocesses, clocks, or message
catalogs. They return the next state and, when needed, one requested effect.
State-specific reducers prevent one flat transition function from becoming the
next oversized planner.

### Imperative runtime shell

The runtime loads and saves state, performs effects, and feeds result events
back through the pure transition function:

```ts
function createSetupSessionApplication(
  ports: SetupPorts,
): SetupSessionApplication {
  async function dispatch(
    input: SetupDispatchInput,
  ): Promise<SetupSessionView> {
    const current = await requireCurrentSession(input, ports);
    let transition = transitionSetupSession(current, input.event);

    while (transition.effect !== null) {
      await ports.sessions.save(transition.state);
      const event = await performSetupEffect(transition.effect, ports);
      transition = transitionSetupSession(transition.state, event);
    }

    await ports.sessions.save(transition.state);
    return ports.presentation.project(transition.state);
  }

  return { dispatch };
}
```

The implementation will include per-session serialization and strict revision
checks; the example shows dependency direction rather than complete concurrency
mechanics.

## Type Ownership

Types are separated by authority and transport needs rather than collected into
one setup model file.

- **Shared wire schemas — `@station/contracts`:** session commands, session
  views, form fields, message references, public intent, and public result.
- **Internal domain data — `@station/setup-core`:** facts, normalized evidence,
  internal operations, checkpoints, session state, and effects.
- **Config representation — `@station/config`:** typed source mutations, TOML
  edit plans, and persistence results.
- **Presentation definitions — `@station/setup-messages`:** catalog
  definitions, terminal and graphical variants, and resolution.
- **Adapter-private values — owning CLI or integration adapter:** subprocess
  results, provider-private paths, and filesystem staging details.

A value belongs in `@station/contracts` only when it crosses the production
process boundary. Internal session state is not exposed merely because a client
needs a view of it. Boundary mappers translate internal state into strict wire
views.

Shared payload types are inferred from their Zod schemas. The implementation
must not maintain parallel hand-written validators for the same shape.

### Limited generic usage

Generics are appropriate for small infrastructure relationships:

```ts
type Result<Value, ErrorValue> =
  | { ok: true; value: Value }
  | { ok: false; error: ErrorValue };

type MessageArguments<Id extends SetupMessageId> = Extract<
  SetupMessageRef,
  { id: Id }
>["arguments"];

type SetupMessageCatalog = {
  [Id in SetupMessageId]: SetupMessageDefinition<MessageArguments<Id>>;
};
```

Setup states, events, effects, issues, operations, and forms remain concrete
discriminated unions. Generic infrastructure must not erase the relationship
between a specific setup state and its allowed events.

## Target Package and Module Boundaries

### `@station/setup-core`

`packages/setup-core` owns UI-independent setup behavior:

```text
src/
  index.ts
  model/
    facts.ts
    intent.ts
    issues.ts
    operations.ts
    plan.ts
    result.ts
    session.ts
  policy/
    assessHarnessTracking.ts
    deriveReadiness.ts
    resolveHarnessSelection.ts
    selectRepairTargets.ts
  planning/
    combinePlanSections.ts
    planConfig.ts
    planHarnessTracking.ts
    planSetup.ts
    planTools.ts
  session/
    checkpoints.ts
    transition.ts
    transitionApplying.ts
    transitionBlocked.ts
    transitionEditing.ts
    transitionInspecting.ts
    transitionReviewing.ts
    transitionVerifying.ts
  execution/
    performEffect.ts
  ports.ts
```

The package has no Clack, React, Node filesystem, provider integration, or TOML
representation dependency. It may depend on shared contract types and pure
runtime error helpers.

### `@station/contracts`

Setup contract modules own strict serialized values:

- session start, dispatch, status, cancel, and progress payloads;
- expected session revision and plan identity;
- semantic form, field, choice, review, progress, blocked, and completion views;
- public setup intent, issue, plan summary, and result values;
- typed message references and their argument schemas.

A small form vocabulary supports confirmation, single selection, multiple
selection, text, secret text, review, progress, and recovery. It is not a
universal UI toolkit.

### `@station/setup-messages`

`packages/setup-messages` owns setup copy and resolution:

```text
src/
  index.ts
  catalog.ts
  resolve.ts
  types.ts
```

The catalog is exhaustive over contract-owned message IDs and argument types.
Changing wording does not change policy. Terminal and graphical variants may
differ while sharing one stable message ID.

Dynamic harness names, paths, commands, diagnostic evidence, and errors remain
typed data. Machine-readable output consumes semantic values without resolving
presentation copy.

### `@station/config`

The config package gains typed setup mutation APIs. Setup policy determines the
desired harnesses, defaults, tracking intent, and optional integration intent;
the config package translates that intent into valid source-preserving TOML and
persists it safely.

Setup core must not render TOML blocks, choose newline style, append raw source,
or implement atomic config replacement.

### CLI setup composition

`apps/cli` remains the bootstrap composition owner. It provides concrete
adapters for machine inspection, packages, config persistence, Observer
activation, provider tracking, tmux, Worktrunk, session persistence, and
external commands.

The target replaces the broad `SetupCommandDeps` bag with narrow function-valued
ports selected at one composition root.

### Station UI

`station/` consumes only setup contracts, the setup message resolver, and a
session client source. Components render views and submit strict session
commands. Provider and mutation dependencies remain outside the UI.

## Session Lifecycle

### Coarse states

The session uses product states, not one state per prompt:

```ts
type SetupSessionState =
  | InspectingSetupState
  | EditingSetupState
  | ReviewingSetupState
  | ApplyingSetupState
  | VerifyingSetupState
  | BlockedSetupState
  | CompletedSetupState
  | CancelledSetupState;
```

- **Inspecting** collects current evidence.
- **Editing** holds a complete setup intent that clients may replace.
- **Reviewing** holds a plan derived from a snapshot and intent.
- **Applying** executes accepted typed operations and records commits.
- **Verifying** performs a coherent fresh evidence pass.
- **Blocked** exposes a semantic issue, checkpoint, and valid recovery actions.
- **Completed** contains the final semantic result.
- **Cancelled** records cancellation relative to the durable checkpoint.

Clack may collect editing fields sequentially, while React may edit them as one
form. Both submit the same strict intent. The session does not persist or replay
the order in which a presenter asked questions.

### Commands and revisions

Driving clients submit semantic commands such as:

- replace the current intent;
- request a plan;
- accept a specific plan;
- request a supported recovery action;
- cancel;
- fetch current status.

Every mutating command includes the expected session revision. Stale clients
receive a typed conflict view and must refresh rather than applying an answer to
newer state.

### Plans and freshness

A plan contains semantic issues, preconditions, and typed operations. It does
not contain UI copy, arbitrary command arrays, or generic string data. An
accepted plan references the evidence revision from which it was derived.

Apply revalidates mutable preconditions. Evidence drift returns the session to a
reviewable or blocked state rather than executing a stale plan.

### Durable checkpoints

A checkpoint records committed operation identities and typed commit evidence,
including whether config has been written and activated and which harness
tracking artifacts have been freshly observed.

The runtime persists state before the next durable effect and after its result
is incorporated. Recovery never infers completion from an attempted command and
never replays a committed effect.

Session persistence is rooted under the resolved setup state directory. Editing
may remain in memory while no durable mutation is possible; apply is blocked
unless the session can persist its checkpoint safely.

### Bootstrap-capable owner

The setup session application is composed by the CLI and does not require an
already-running Observer. The target production process boundary is:

- `stn setup` drives the session application in process for Clack,
  noninteractive, check, plan, and machine-readable modes;
- Station launches a bootstrap-capable setup session host over a strict local
  stdio protocol;
- reconnect creates a new client/host connection and resumes persisted session
  state by session ID;
- Observer activation is a driven effect inside setup, not the owner of setup.

The stdio host is an internal execution mode, not a second policy
implementation.

## Effect and Error Model

### Typed effects

Session transitions request semantic effects:

```ts
type SetupEffect =
  | { kind: "inspect"; context: SetupContext }
  | { kind: "execute-operation"; operation: SetupOperation }
  | { kind: "verify-final-evidence"; intent: SetupIntent };
```

Operations distinguish config mutation, Observer activation, package
installation, harness tracking preparation, Worktrunk integration, and tmux
configuration. Adapters translate operations into concrete commands and files.

### Expected conditions

Missing tools, unavailable harnesses, declined consent, ambiguous selection,
drifted artifacts, stale evidence, and unsupported capabilities are semantic
outcomes. They are not thrown exceptions.

### Unexpected failures

Adapters own `try`/`catch`, subprocess interpretation, filesystem races,
timeouts, provider quirks, and conversion of unknown failures through repository
`SafeError` helpers. Unknown failures do not cross into core as probed
JavaScript-shaped objects.

The runtime may retry only when an operation declares the necessary idempotency
and commit semantics. Cancellation cannot interrupt a commit boundary in a way
that leaves the checkpoint claiming an unproved state.

## Presentation and Messages

The presentation path is explicit:

```text
semantic state
  -> presentation mapper
  -> contract view with typed message references
  -> shared message resolver
  -> Clack or React/OpenTUI output
```

Policy never imports message IDs. A result such as ambiguous harness selection
contains candidate IDs and a stable issue code. The presentation mapper chooses
message references for title, explanation, choices, and recovery; the catalog
supplies the words.

Message argument schemas and catalog definitions are separate modules. Policy
tests assert codes and details. Catalog tests assert interpolation and variants.
Presenter tests assert control selection, layout, and formatting.

Machine-readable modes return semantic plans, issues, progress, and results.
They do not depend on catalog copy.

## Clack Terminal Presenter

The terminal presenter uses `@clack/prompts` only inside the CLI driving adapter.
Clack does not enter setup core, contracts, config, providers, or Station UI.

The adapter maps the setup form vocabulary to Clack controls:

- confirmation to `confirm`;
- single selection to `select`;
- multiple selection to `multiselect`;
- normal text to `text`;
- secret text to `password`;
- progress events to spinner or task output;
- cancellation to a semantic session cancel command.

The adapter resolves all prompt, label, help, progress, recovery, and completion
copy through `@station/setup-messages`. It does not construct policy sentences
inline.

Clack-local back navigation is permitted only while editing. It changes the
local draft or replaces session intent and requests a new plan. It never replays
application functions or crosses a durable mutation boundary.

The Clack runner is an ordinary async function with an exhaustive loop over
session view kinds. It is not a presenter class and does not own session state.
Prompt functions are injected as a plain object for deterministic tests.

## Station React/OpenTUI Presenter

The Station UI uses a functional session hook and view components:

```text
setup/
  useSetupSession.ts
  SetupScreen.tsx
  SetupForm.tsx
  SetupReview.tsx
  SetupProgress.tsx
  SetupRecovery.tsx
  SetupCompletion.tsx
```

The hook owns client-side loading, command dispatch, reconnect, and revision
refresh. Components remain presentation-only. A multiple-selection field may be
rendered as cards or checkboxes instead of a terminal list while preserving the
same values and constraints.

The Station source adapter owns the stdio child and parses strict setup contract
messages. UI components do not spawn the child directly.

## Complexity Containment

The target acknowledges four legitimate kinds of difficult code:

- **Domain policy:** selection precedence, readiness, required repairs, and
  consent.
- **Workflow policy:** phase ordering, re-probes, commit points, cancellation,
  retry, and recovery.
- **Boundary complexity:** operating systems, external commands, files,
  providers, timeouts, and unknown failures.
- **Presentation complexity:** mapping semantic outcomes to views and messages.

Duplicated branches, broad dependency bags, generic string records, and prose
inside decisions are accidental complexity to remove.

Pure decision kernels accept the smallest relevant facts and intent and return
exhaustive outcomes. Decision tables are appropriate when independent
dimensions combine; named linear guards remain appropriate when precedence and
short-circuit ordering are the product rule.

State-specific transition functions own workflow branches. Adapters own edge
failures. Presentation mappers own view selection. Extraction is not successful
when the new helper still requires all setup facts, all setup dependencies, and
several booleans.

## Testing Strategy

The migration separates tests by architectural responsibility:

- **Policy tests** use exhaustive tables for selection, tracking assessment,
  repair targeting, readiness, and consent.
- **Planner tests** prove semantic operations, preconditions, and no rendered
  copy or raw command leakage.
- **Transition tests** cover every state/event pair, revision conflict,
  cancellation point, and recovery path.
- **Effect tests** inject completion and failure events and verify checkpoint
  ordering.
- **Adapter contract tests** cover malformed provider output, subprocess
  failures, filesystem races, and `SafeError` conversion.
- **Contract tests** reject malformed commands, views, message arguments,
  persisted sessions, and stale revisions.
- **Message tests** prove catalog exhaustiveness, interpolation, and surface
  variants.
- **Clack tests** use injected prompt functions and assert semantic commands.
- **Station tests** use a fake session client and assert view rendering and
  reconnect behavior.
- **E2E tests** retain ambiguity, consent, activation-before-tracking, hostile
  environment isolation, real artifact installation, fresh final probing, and
  interruption after config activation followed by safe resume.

## Migration Plan

The target is delivered incrementally. Each slice must leave existing commands
usable and keep behavior protected by current tests.

### Phase 1: contracts and pure policy extraction

Introduce setup contracts and `@station/setup-core`. Move facts, selection,
tracking assessment, repair targeting, readiness, semantic issues, and planning
behind pure functions. Adapt current CLI flows to the new policy without
changing presentation or execution.

### Phase 2: config mechanics and typed operations

Move source-preserving setup config mechanics into `@station/config`. Replace
generic action payloads with semantic operations and adapters while preserving
current command behavior and ordering.

### Phase 3: message catalog and presentation projection

Introduce `@station/setup-messages`, message references, and presentation
mappers. Move setup copy out of policies, plans, and execution. Preserve the
existing renderer until catalog parity tests pass.

### Phase 4: functional session runtime

Introduce session states, events, transitions, checkpoints, revision checks,
and the imperative runtime shell. Drive current noninteractive, check, plan,
and guided behavior through the same application.

### Phase 5: Clack presenter

Add the Clack driving adapter and replace the current line-oriented guided
prompt implementation. Preserve noninteractive and machine-readable behavior.

### Phase 6: persisted host and Station UI

Add strict stdio transport, durable session recovery, the Station source
adapter, and React/OpenTUI setup views. Prove process interruption and reconnect
before exposing resume as supported UX.

### Phase 7: legacy removal

Remove obsolete planner, generic action, renderer, prompt-flow, and broad
dependency paths only after parity and end-to-end gates pass.

## Expected Change Inventory

This is the current expected full-target inventory. Each implementation PR must
narrow this list to its phase and update the plan if ownership changes.

### New setup core package

- `packages/setup-core/package.json`
- `packages/setup-core/tsconfig.json`
- `packages/setup-core/src/index.ts`
- `packages/setup-core/src/ports.ts`
- `packages/setup-core/src/model/facts.ts`
- `packages/setup-core/src/model/intent.ts`
- `packages/setup-core/src/model/issues.ts`
- `packages/setup-core/src/model/operations.ts`
- `packages/setup-core/src/model/plan.ts`
- `packages/setup-core/src/model/result.ts`
- `packages/setup-core/src/model/session.ts`
- `packages/setup-core/src/policy/assessHarnessTracking.ts`
- `packages/setup-core/src/policy/deriveReadiness.ts`
- `packages/setup-core/src/policy/resolveHarnessSelection.ts`
- `packages/setup-core/src/policy/selectRepairTargets.ts`
- `packages/setup-core/src/planning/combinePlanSections.ts`
- `packages/setup-core/src/planning/planConfig.ts`
- `packages/setup-core/src/planning/planHarnessTracking.ts`
- `packages/setup-core/src/planning/planSetup.ts`
- `packages/setup-core/src/planning/planTools.ts`
- `packages/setup-core/src/session/checkpoints.ts`
- `packages/setup-core/src/session/transition.ts`
- `packages/setup-core/src/session/transitionApplying.ts`
- `packages/setup-core/src/session/transitionBlocked.ts`
- `packages/setup-core/src/session/transitionEditing.ts`
- `packages/setup-core/src/session/transitionInspecting.ts`
- `packages/setup-core/src/session/transitionReviewing.ts`
- `packages/setup-core/src/session/transitionVerifying.ts`
- `packages/setup-core/src/execution/performEffect.ts`

### New setup core tests

- `packages/setup-core/test/unit/assess-harness-tracking.test.ts`
- `packages/setup-core/test/unit/derive-readiness.test.ts`
- `packages/setup-core/test/unit/resolve-harness-selection.test.ts`
- `packages/setup-core/test/unit/select-repair-targets.test.ts`
- `packages/setup-core/test/unit/plan-setup.test.ts`
- `packages/setup-core/test/unit/session-transition.test.ts`
- `packages/setup-core/test/unit/session-checkpoints.test.ts`
- `packages/setup-core/test/unit/perform-effect.test.ts`

### Contracts

- `packages/contracts/src/index.ts`
- `packages/contracts/src/setupMessages.ts`
- `packages/contracts/src/setupSession.ts`
- `packages/contracts/src/setupTypes.ts`
- `packages/contracts/test/schema/setup-messages-schema.test.ts`
- `packages/contracts/test/schema/setup-session-schema.test.ts`
- `packages/contracts/test/schema/setup-types-schema.test.ts`

### New message package

- `packages/setup-messages/package.json`
- `packages/setup-messages/tsconfig.json`
- `packages/setup-messages/src/index.ts`
- `packages/setup-messages/src/catalog.ts`
- `packages/setup-messages/src/resolve.ts`
- `packages/setup-messages/src/types.ts`
- `packages/setup-messages/test/unit/catalog.test.ts`
- `packages/setup-messages/test/unit/resolve.test.ts`

### Config package

- `packages/config/src/index.ts`
- `packages/config/src/setup/index.ts`
- `packages/config/src/setup/mutations.ts`
- `packages/config/src/setup/persistence.ts`
- `packages/config/test/unit/setup-mutations.test.ts`
- `packages/config/test/unit/setup-persistence.test.ts`
- `packages/config/test/unit/harness-install-hooks-toml.test.ts`

### CLI setup production files

New target modules:

- `apps/cli/src/commands/setup/composition.ts`
- `apps/cli/src/commands/setup/adapters/config.ts`
- `apps/cli/src/commands/setup/adapters/harnessTracking.ts`
- `apps/cli/src/commands/setup/adapters/inspection.ts`
- `apps/cli/src/commands/setup/adapters/observerActivation.ts`
- `apps/cli/src/commands/setup/adapters/operations.ts`
- `apps/cli/src/commands/setup/adapters/sessionStore.ts`
- `apps/cli/src/commands/setup/presentation/projectSessionView.ts`
- `apps/cli/src/commands/setup/presenters/clack.ts`
- `apps/cli/src/commands/setup/presenters/json.ts`
- `apps/cli/src/commands/setup/session/createCliSetupSession.ts`
- `apps/cli/src/commands/setup/transport/stdioClient.ts`
- `apps/cli/src/commands/setup/transport/stdioServer.ts`

Existing modules expected to migrate, reduce, or be removed:

- `apps/cli/src/commands/setup/apply.ts`
- `apps/cli/src/commands/setup/args.ts`
- `apps/cli/src/commands/setup/configWriter.ts`
- `apps/cli/src/commands/setup/flowUtils.ts`
- `apps/cli/src/commands/setup/flows/guided.ts`
- `apps/cli/src/commands/setup/flows/nonInteractive.ts`
- `apps/cli/src/commands/setup/flows/readOnly.ts`
- `apps/cli/src/commands/setup/harnessInstall.ts`
- `apps/cli/src/commands/setup/harnessSelection.ts`
- `apps/cli/src/commands/setup/index.ts`
- `apps/cli/src/commands/setup/io.ts`
- `apps/cli/src/commands/setup/model.ts`
- `apps/cli/src/commands/setup/planner.ts`
- `apps/cli/src/commands/setup/render.ts`
- `apps/cli/src/commands/setup/systemCommand.ts`
- `apps/cli/src/commands/setup/theme.ts`
- `apps/cli/src/commands/setup/types.ts`
- `apps/cli/src/commands/setup/checks/brew.ts`
- `apps/cli/src/commands/setup/checks/bun.ts`
- `apps/cli/src/commands/setup/checks/config.ts`
- `apps/cli/src/commands/setup/checks/constants.ts`
- `apps/cli/src/commands/setup/checks/diffnav.ts`
- `apps/cli/src/commands/setup/checks/env.ts`
- `apps/cli/src/commands/setup/checks/git.ts`
- `apps/cli/src/commands/setup/checks/gitDelta.ts`
- `apps/cli/src/commands/setup/checks/harnesses.ts`
- `apps/cli/src/commands/setup/checks/launchers.ts`
- `apps/cli/src/commands/setup/checks/stateDir.ts`
- `apps/cli/src/commands/setup/checks/system.ts`
- `apps/cli/src/commands/setup/checks/tmux.ts`
- `apps/cli/src/commands/setup/checks/tmuxBinding.ts`
- `apps/cli/src/commands/setup/checks/toolchain.ts`
- `apps/cli/src/commands/setup/checks/worktrunk.ts`
- `apps/cli/src/commands/setup/checks/xcode.ts`
- `apps/cli/src/commands/registry/setup.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/observerProviders.ts`
- `apps/cli/package.json`
- `apps/cli/tsconfig.json`

### CLI setup tests

Existing tests expected to migrate:

- `apps/cli/test/fixtures/setupTrackingSupport.ts`
- `apps/cli/test/integration/setup-command.test.ts`
- `apps/cli/test/integration/setup-profiles.test.ts`
- `apps/cli/test/unit/observerProviders.test.ts`
- `apps/cli/test/unit/setup-apply.test.ts`
- `apps/cli/test/unit/setup-args.test.ts`
- `apps/cli/test/unit/setup-checks.test.ts`
- `apps/cli/test/unit/setup-config-writer.test.ts`
- `apps/cli/test/unit/setup-guided.test.ts`
- `apps/cli/test/unit/setup-io.test.ts`
- `apps/cli/test/unit/setup-model.test.ts`
- `apps/cli/test/unit/setup-planner.test.ts`
- `apps/cli/test/unit/setup-profile-runners.test.ts`
- `apps/cli/test/unit/setup-render.test.ts`
- `apps/cli/test/unit/setup-toolchain.test.ts`

New adapter and presenter tests:

- `apps/cli/test/unit/setup-clack-presenter.test.ts`
- `apps/cli/test/unit/setup-composition.test.ts`
- `apps/cli/test/unit/setup-inspection-adapter.test.ts`
- `apps/cli/test/unit/setup-operation-adapter.test.ts`
- `apps/cli/test/unit/setup-session-store.test.ts`
- `apps/cli/test/integration/setup-session-stdio.test.ts`
- `apps/cli/test/integration/setup-session-resume.test.ts`

### Station UI files

- `station/scripts/link-station-packages.sh`
- `station/src/app/StationApp.tsx`
- `station/src/app/StationApp.test.tsx`
- `station/src/sources/createSetupSessionClient.ts`
- `station/src/sources/createSetupSessionClient.test.ts`
- `station/src/setup/useSetupSession.ts`
- `station/src/setup/useSetupSession.test.ts`
- `station/src/setup/SetupScreen.tsx`
- `station/src/setup/SetupScreen.test.tsx`
- `station/src/setup/SetupForm.tsx`
- `station/src/setup/SetupForm.test.tsx`
- `station/src/setup/SetupReview.tsx`
- `station/src/setup/SetupReview.test.tsx`
- `station/src/setup/SetupProgress.tsx`
- `station/src/setup/SetupProgress.test.tsx`
- `station/src/setup/SetupRecovery.tsx`
- `station/src/setup/SetupRecovery.test.tsx`
- `station/src/setup/SetupCompletion.tsx`
- `station/src/setup/SetupCompletion.test.tsx`

### Shared testing and E2E

- `packages/testing/src/setupProfiles.ts`
- `tests/e2e/setup-core-flow.test.ts`
- `tests/e2e/setup-guided-feedback.test.ts`
- `tests/e2e/setup-session-resume.test.ts`

### Workspace and documentation

- `pnpm-lock.yaml`
- `AGENTS.md`
- `docs/architecture.md`
- `docs/architecture-documentation.md`
- `docs/configuration.md`
- `docs/development.md`
- `docs/harness-authoring.md`
- `docs/install.md`
- `docs/setup-architecture.md`
- `docs/setup-testing.md`

## Architectural JSDoc Plan

This target explicitly adopts the controlled roles from
[Architecture Documentation](architecture-documentation.md) for consequential
setup seams. No production JSDoc is added by this document because the target
declarations do not yet exist.

Implementation must add or update JSDoc for:

- `SetupSessionApplication` — `DRIVING PORT`;
- setup inspection, operation execution, session persistence, config mutation,
  Observer activation, provider tracking, tmux, and Worktrunk capability shapes
  — `DRIVEN PORT`;
- `createSetupSessionApplication` — `USE CASE`;
- harness selection, tracking assessment, repair targeting, readiness,
  planning, result derivation, and session transition entrypoints — `POLICY`;
- CLI machine inspection, config, Observer, provider tracking, operation,
  session-store, Clack, JSON, stdio server, and stdio client factories or
  entrypoints — `ADAPTER`;
- the CLI setup wiring entrypoint — `COMPOSITION ROOT`;
- the Station setup session client source — `ADAPTER`.

Schemas, DTOs, data-only unions, message catalogs, resolvers, presentation
mappers, ordinary helpers, tests, and React components do not receive controlled
role markers.

## Evidence Behind the Target

The target borrows specific proven patterns without copying another system
wholesale:

- OpenClaw demonstrates a semantic prompt vocabulary, Clack adaptation, and a
  serializable wizard boundary. Station avoids its replayed imperative setup
  procedure and instead persists explicit semantic state and checkpoints.
- Home Assistant demonstrates backend-owned flow state, discriminated forms,
  progress, completion, and generic clients. Station keeps its session owner
  bootstrap-capable rather than requiring an already-healthy server.
- Create Astro demonstrates that ordered setup actions and deferred effects can
  remain understandable. Station avoids a broad mutable context by using typed
  operations and narrow ports.
- Terraform demonstrates inspect, plan, review, apply, and evidence freshness.
  Station adds explicit session transitions and partial-completion recovery.

Sources:

- [OpenClaw prompt contract][openclaw-prompts]
- [OpenClaw Gateway wizard schema][openclaw-schema]
- [OpenClaw prompt replay navigation][openclaw-navigation]
- [Home Assistant flow result types][ha-flow-results]
- [Home Assistant flow manager][ha-flow-manager]
- [Home Assistant flow continuation][ha-flow-continuation]
- [Home Assistant frontend flow union][ha-frontend-types]
- [Home Assistant generic flow rendering][ha-frontend-render]
- [Create Astro action pipeline][astro-pipeline]
- [Create Astro shared context][astro-context]
- [Create Astro prompt-to-task action][astro-template]
- [Terraform core workflow][terraform-workflow]
- [Terraform plan behavior][terraform-plan]

[openclaw-prompts]: https://github.com/openclaw/openclaw/blob/3bfc23c6760bf94f691805f2b2f950b11035cd9f/src/wizard/prompts.ts#L1-L72
[openclaw-schema]: https://github.com/openclaw/openclaw/blob/3bfc23c6760bf94f691805f2b2f950b11035cd9f/packages/gateway-protocol/src/schema/wizard.ts#L15-L84
[openclaw-navigation]: https://github.com/openclaw/openclaw/blob/3bfc23c6760bf94f691805f2b2f950b11035cd9f/src/wizard/navigation-prompter.ts#L249-L327
[ha-flow-results]: https://github.com/home-assistant/core/blob/42f9a4f5aac3ee9de6ee0210d6581a8b7e4b3b15/homeassistant/data_entry_flow.py#L27-L50
[ha-flow-manager]: https://github.com/home-assistant/core/blob/42f9a4f5aac3ee9de6ee0210d6581a8b7e4b3b15/homeassistant/data_entry_flow.py#L174-L230
[ha-flow-continuation]: https://github.com/home-assistant/core/blob/42f9a4f5aac3ee9de6ee0210d6581a8b7e4b3b15/homeassistant/data_entry_flow.py#L294-L379
[ha-frontend-types]: https://github.com/home-assistant/frontend/blob/43b4e247afda1553636d80dec65fecbbe7d59b2e/src/data/data_entry_flow.ts#L36-L110
[ha-frontend-render]: https://github.com/home-assistant/frontend/blob/43b4e247afda1553636d80dec65fecbbe7d59b2e/src/dialogs/config-flow/dialog-data-entry-flow.ts#L398-L472
[astro-pipeline]: https://github.com/withastro/astro/blob/b01a6921cd8be574db2d82a6d2bbde7c7d319295/packages/create-astro/src/index.ts#L23-L64
[astro-context]: https://github.com/withastro/astro/blob/b01a6921cd8be574db2d82a6d2bbde7c7d319295/packages/create-astro/src/actions/context.ts#L9-L35
[astro-template]: https://github.com/withastro/astro/blob/b01a6921cd8be574db2d82a6d2bbde7c7d319295/packages/create-astro/src/actions/template.ts#L47-L88
[terraform-workflow]: https://developer.hashicorp.com/terraform/intro/core-workflow
[terraform-plan]: https://developer.hashicorp.com/terraform/cli/commands/plan
