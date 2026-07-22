# Naming

Status: current living terminology for shared runtime, contract, protocol, and user-facing names.

Use this when changing names around providers, hooks, ingress, observer events, event hooks, status evidence, diagnostics, session/worktree/pane-tree lifecycle, or CLI/config surfaces.

## Naming Rule

Names should answer three questions:

- Source: who produced this data or action?
- Direction: is it entering the observer, leaving the observer, or being configured by the user?
- Shape: is it a raw provider payload, a normalized report, an observer event, a receipt, or a durable/spooled record?

Avoid bare `hook` and bare `event` when the source or direction matters.

## Canonical Terms

### Provider Hook

A provider hook is an external provider callback or generated provider hook command. Examples include Worktrunk lifecycle hooks, Claude Code hooks, Codex hooks, Cursor hooks, OpenCode plugin hooks, and Pi extension callbacks.

Use `provider hook` for provider-originated callback mechanics and generated hook setup.

### ProviderHookEvent

`ProviderHookEvent` is the raw shared envelope for provider-originated hook callbacks that enter STATION.

It is still provider-ingress data, not a `StationEvent`. Its `event` field means the provider/native event name.

Preferred related names:

```ts
ProviderHookEvent
ProviderHookReceipt
ProviderHookSpoolRecord
ProviderHookPayloadSummary
ProviderHookScopeDecision
```

`ProviderHookIngress` should name a service, module, queue, or process. It should not be the base schema name because ingress is the action/path, not the payload.

### HarnessEventReport

`HarnessEventReport` is a normalized report from a harness integration to the observer.

Use `Report` here because the harness is reporting evidence/status to the observer. It is not itself the public observer event. The observer may persist it, project status from it, publish `StationEvent`s because of it, or schedule reconcile from it.

Preferred related names:

```ts
HarnessEventReport
HarnessEventReportReceipt
HarnessEventReportSpoolRecord
```

Do not rename this to `HarnessEventObservation` unless the persisted observation contract is renamed too; that name is already occupied by provider-observation payloads.

### StationEvent

`StationEvent` is the observer-owned event bus/public protocol event union.

These are events clients subscribe to and the TUI consumes. Examples include `worktree.agentStateChanged`, `command.failed`, and `observer.reconciled`.

Provider hook ingress may cause a `StationEvent`, but it is not a `StationEvent` until the observer emits one.

Preferred related names:

```ts
StationEvent
StationEventType
StationEventFilter
```

### Observer Event Hook

An observer event hook is a user-configured command that runs when a `StationEvent` matches.

The existing TOML shape is:

```toml
[[hooks.event]]
id = "notify-agent-state"
events = ["worktree.agentStateChanged"]
command = "stn"
args = ["notify", "agent-state"]

[hooks.event.filter]
agent_state = "idle"
change_source = "harness_event_report"
```

The config shape can stay `hooks.event`, but code and docs should prefer `observer event hook` when precision matters.

Preferred related names:

```ts
ObserverEventHookConfig
ObserverEventHookInvocation
ObserverEventHookRuntime
```

`EventHook` is acceptable only in small local contexts where the observer/STATION source is already obvious.

## Directional Model

Use this mental model for ambiguous changes:

```text
provider hook callback
  -> provider hook ingress
  -> ProviderHookEvent or HarnessEventReport
  -> observer persistence/projection/reconcile
  -> StationEvent
  -> observer event hook command
```

Provider hooks are ingress. Observer event hooks are egress.

## Compatibility Names

Retired internal aliases are removed rather than preserved during the private
preview:

- Generated scripts call `observer.ingestProviderHookEvent`.
- `hook.ingested` and `hook.spoolDrained` are removed, not aliased. Use `providerHook.ingested` and `providerHook.spoolDrained`; the retired strings error as input rather than silently upgrading.
- `hookSpool` names are acceptable for filesystem compatibility, but new code should prefer `providerHookSpool` or a broader `providerIngressSpool` when the spool contains both provider hook events and harness event reports.

During the private preview, Station does not preserve compatibility for its own
retired internal names. Remove a retired name instead of aliasing it. Do not add
alias-only wrappers for names that are not part of a real external contract.
This does not permit silent shared-schema drift: breaking payload changes bump
the exact schema version and require generated provider hooks to be
reinstalled.

## Status Sources

Status source names should describe normalized evidence, not only the transport that carried it.

- Use `harness_event` for normalized harness event evidence.
- Reserve `harness_hook` for raw provider-native hook evidence that has not yet been normalized into a harness event report.
- Use `harness_process` for live process/discovery truth.

Observer snapshots remain reconciled truth. Provider hooks and harness event reports are evidence or hints unless reconcile/status projection promotes them through observer-owned logic.

## User-Facing UX Rule

Provider hook setup and observer event hook setup should read as different features.

Avoid CLI/API output that treats event hooks as a provider. Prefer labels such as `observer-event-hook`, `event-hook`, or `category: "observer-event-hook"` over `provider: "event"`.

Manual verification after naming work:

- Provider setup output still clearly refers to Worktrunk/Claude/Codex/Cursor/OpenCode/Pi hooks.
- Notify setup output clearly refers to observer event hooks, not a provider named `event`.
- Event subscription output clearly uses STATION event names.
- Debug evidence separates provider hook delivery/spool from observer event hook command execution.

## Session, Worktree, and Pane Tree

Three lifecycle units are easy to conflate. Keep them distinct in names, commands, and UX: a session runs inside a worktree, and a pane tree is how one worktree row is drawn in the TUI.

### Session

A session is one agent/harness lifecycle inside a worktree, not the worktree
itself. `StationSnapshot.sessions` is canonical membership. `origin: "station"`
identifies Observer-owned lifecycle state: the Observer mints its id as
`ses_<uuid>` (`apps/observer/src/commands/session/shared.ts`), and the newest
explicitly open durable record can remain a member without a currently observed
run or terminal. `origin: "external"` identifies current external run evidence: the
view reuses the normalized harness run id and is removed when that evidence is
expired, `none`, `unknown`, or `exited`. Ending a session leaves the checkout
and panes intact.

There is no deletable "session" unit and no `session.remove` command. The durable, deletable unit is the worktree.

### Worktree

A worktree is the durable, deletable unit: the git worktree, its branch, and its checkout. Worktree ids are **provider-supplied** (e.g. Worktrunk), not minted by the observer, so code must not parse or validate the `wt_` prefix. Removing a worktree also tears down its session and panes.

### Pane Tree

A pane tree is the TUI work area for a worktree row — the panes the user sees for that row. It is a station-only UI concept; the observer has no pane tree. Store state uses `paneTreeIds` and the teardown action is `closePaneTree` (triggered by the session reaper when the underlying worktree/session disappears).

Avoid the older `sessionPaneIds` / `closeSession` names: the panes belong to the worktree's UI, not to the agent session, and the old name implied the agent owned them.

### Cleanup Command Model

| Intent | Command | Tears down |
| --- | --- | --- |
| Stop only the harness run | `session.close({ mode: "harness" })` | harness run only |
| Close the terminal target | `terminal.close` | terminal target (and its session) |
| Delete the worktree | `worktree.remove` | harness, terminal, worktree, branch, panes |

`session.close` takes a `mode` of `harness | terminal | all` (`CloseSessionPayloadSchema`). Use it for non-destructive stops; use `worktree.remove` for destructive deletes.

### Delete Session UX

The current row action is destructive:

- **Delete Session** (`X`) is destructive. It runs `worktree.remove` and removes the agent, worktree, and panes. Copy must say so: "Removes agent, worktree, and panes."

There is no `E` binding and no **End Agent** row action. A non-destructive End Agent
action backed by `session.close({ mode: "harness" })` was considered and cut during
review because it reintroduced a second user-facing lifecycle action. Keep it out of
menus and user-facing docs unless the product explicitly re-adds it.

### Id Model

`StationId<TKind>` (`packages/contracts/src/ids.ts`) is a compile-time-only brand: `string & { readonly [stationIdKind]?: TKind }`. The `?` keeps it **intentionally leaky** — a raw string assigns to a branded type with no parse step.

Prefixes (`ses_`, `wt_`, `cmd_`, `evt_`, `err_`) are human-readability conventions only. Nothing parses them; do not treat a prefix as a validated discriminator. Worktree ids in particular are provider-controlled, so their format is not STATION's to assert.

Tightening the brand to non-leaky (`[stationIdKind]: TKind`, dropping the `?`) was spiked and rejected: it forces an explicit parse/cast at every "construct an id from a raw string" site — observability error and evidence shaping, the testing fixtures, and everything downstream of them — for marginal safety, since no code parses prefixes and worktree ids are provider-supplied. Keep the brand leaky and rely on schema parsing at real input boundaries instead.
