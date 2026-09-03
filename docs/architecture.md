# Architecture

Status: current living repository-wide ownership and boundary map.

Station is a terminal-native control plane for AI-agent worktree sessions. It
correlates configured projects, provider observations, durable Observer state,
terminal resources, and client interaction state without making any one layer
authoritative for all of them.

This document answers two questions: which repository area owns a concern, and
which dependency directions are allowed. It deliberately does not duplicate
subsystem flows or operating procedures.

## Owning Guides

- [Philosophy](philosophy.md) owns product principles, and
  [Naming](naming.md) owns shared terminology.
- [Observer Architecture](observer-architecture.md) owns the Observer application
  model, ports, adapters, use cases, persistence, and concurrency rules.
  [Observer singleton lifecycle](observer-singleton.md) owns process and socket
  ownership. [Architecture Documentation](architecture-documentation.md) owns
  the controlled JSDoc role language for Observer seams.
- [Dashboard Architecture](dashboard-architecture.md) owns renderer-independent
  dashboard state and layout boundaries. [TUI Development](tui.md) owns the
  OpenTUI renderer, Station Host and PTY integration, native workspace behavior,
  and terminal interaction contracts.
- [Configuration](configuration.md) owns TOML and environment-variable contracts.
  [Install Station](install.md) owns install, update, and first-run behavior.
- [Development](development.md), [Local Development](local-development.md), and
  [Testing](../tests/README.md) own contributor procedures and verification.
  [Debugging](debugging.md) owns runtime diagnosis and recovery procedures.

## System Shape

At runtime, config selects managed projects and concrete integrations. External
providers report facts and perform operations through adapters. The Observer
correlates those facts into a normalized graph and executes typed application
operations. Protocol and client packages expose that application to the CLI and
Station UI. The dashboard projects canonical client state, while Station owns
terminal rendering and local pane hosting.

Dependencies point toward shared contracts and application semantics. Concrete
tools and representations remain at adapters and composition roots:

```text
CLI / Station / provider hooks
            |
            v
protocol and client adapters
            |
            v
Observer application -> provider-neutral ports -> integrations -> external tools
            |
            v
     durable Observer state

Station -> dashboard-core semantics
Station -> Station Host / PTYs
```

The arrows show runtime conversations, not ownership of another subsystem's
state. Composition layers may select concrete adapters; application logic may
not reach outward around its ports.

## Repository Ownership

| Area | Owns | Does not own |
| --- | --- | --- |
| `apps/observer` | Long-lived correlation, reconciliation, commands, provider health, ingress, persistence ports, diagnostics, and snapshot publication | Concrete provider behavior, UI policy, or transport-native representations in application logic |
| `apps/cli` | The `stn` command surface and outer composition for Observer lifecycle, setup, diagnostics, integrations, and UI launch | Long-lived runtime truth or provider policy duplicated from adapters |
| `station/` (`@station/workspace`) | OpenTUI rendering, renderer geometry, native workspace and pane state, and Station Host/PTY presentation integration | Provider truth, Observer persistence, or renderer-independent dashboard semantics |
| `packages/dashboard-core` | Renderer-independent dashboard state, semantic hierarchy, focus, screens, actions, and operation flows | OpenTUI geometry, Node filesystem policy, terminal providers, or canonical Observer state |
| `packages/client` | Canonical in-process snapshot and connection state, subscription recovery, and typed command completion for rich clients | UI policy, provider logic, or a second durable graph |
| `packages/contracts` | Shared application schemas, values, errors, commands, events, snapshots, and provider-neutral ports | Transport mechanics or concrete adapters |
| `packages/protocol` | NDJSON envelopes, method mapping, validation, and client/server transport mechanics | Provider selection, business policy, or application persistence |
| `packages/config` | Runtime-config parsing, validation, source-preserving mutation, backup, and persistence | Setup presentation or runtime orchestration |
| `packages/setup-core` / `packages/setup-messages` | Runtime-independent setup decisions and setup copy contracts | CLI interaction, concrete tool execution, or configuration storage |
| `packages/station-host` (`@station/host`) | The local Host protocol/client and PTY lifetime, attachment, and replay contracts | Observer graph authority or dashboard presentation policy |
| `packages/runtime` | Shared mechanics for bounded IO, cancellation, external commands, process evidence, paths, and atomic files | Product decisions that belong to an application or integration |
| `packages/harness-shared` | Reusable harness-adapter mechanics | Provider-specific parsing or policy |
| `packages/observability` / `packages/testing` | Shared diagnostics/redaction and test support | Production state authority |
| `integrations/**` | Translation to Worktrunk, terminal, harness, and repository systems, including provider-private parsing and commands | Observer application policy or shared-contract ownership |

Folders organize code; they do not create architectural roles by themselves.
Name modules after the responsibility they own, and extract shared mechanics
only when more than one owner genuinely uses the same contract.

## Sources Of Truth

Authority is scoped. When facts disagree, resolve the owner of that fact rather
than choosing a globally preferred layer.

| Fact | Authority |
| --- | --- |
| Managed projects, defaults, provider choices, and local policy | Validated loaded configuration |
| Worktrees, terminal targets, harness runs, and repository metadata | A fresh, complete read from the adapter for the owning external system |
| Recorded commands and events, admitted Station sessions, Groups, titles, observations, and recovery evidence | Observer durable state, within the contract of each persistence port |
| The current normalized graph presented to clients | The latest committed Observer snapshot; it is derived state, not a durable replay log |
| Client connection state and reducible snapshot updates | The canonical `@station/client` runtime for that process |
| Dashboard filters, focus, screens, optimistic rows, and other presentation state | The dashboard runtime; these are projections, not external or Observer truth |
| Pane layout, renderer geometry, terminal buffers, attachments, and hosted PTY lifetime | Station and Station Host within their respective UI and Host boundaries |
| Logs, traces, bundles, and debug projections | Diagnostic evidence only; they never authorize mutation or outrank current owner evidence |

Incomplete or ambiguous provider evidence never proves absence. External
identity remains opaque outside the integration that minted it; shared code may
carry that identity but must not parse its format or reconstruct provider-private
endpoints. Reconciliation combines authoritative inputs without promoting cached
or diagnostic evidence into a second source of truth.

## Boundary Rules

- Provider-specific behavior belongs in `integrations/**` or an injected
  provider capability. Observer application code depends on provider-neutral
  contracts and must not parse raw provider payloads, invoke provider commands,
  or select a concrete adapter to recover private identity.
- Parse untrusted TOML, JSON, CLI, hook, protocol, and provider input once at its
  boundary with the owning strict schema. Pass typed application values inward;
  keep raw payloads and representation-specific errors at the adapter edge.
- `packages/protocol` adapts transport to application contracts. It must not
  become a provider boundary or a home for product policy.
- Composition roots choose concrete adapters and own their lifecycle. Anything
  that owns a socket, process, timer, queue, watcher, or durable handle must have
  an explicit startup-failure and shutdown owner.
- Station is an Observer client. Core UI behavior must not import provider
  packages, read Observer SQLite, shell out to provider, terminal-multiplexer,
  Git, or repository tools, or infer runtime truth from provider-private data.
- Observer sees Station-managed terminals only through provider-neutral
  lifecycle contracts and opaque target identity. Host sockets, PTY identity,
  replay, attachment, and renderer selection stay inside Station or its terminal
  integration.
- Dashboard-core owns semantic state and identity. Station owns measured
  terminal geometry, clipping, pointer resolution, focus-follow, and painting.
  Neither side may recreate the other's state as a parallel authority.
- Setup decisions remain independent of presentation and concrete execution:
  setup-core decides, setup-messages names copy, config owns persistence, and CLI
  composition supplies adapters and interaction.
- CLI composition owns native update discovery as one process-local, read-only
  check with no persistent cache. Only a completed version-changing result can
  become a TUI notice; [Install Station](install.md#automatic-update-ownership)
  and [TUI Development](tui.md#renderers-and-entry-points) own its behavior.
- Observer and Station Host sockets are same-user local control planes. Access
  to their protected endpoints admits privileged operations; PID, version, and
  build metadata provide identity or compatibility evidence, not authentication.
  Ambiguous ownership fails closed, and only freshly proven ownership may
  authorize unlink, replacement, signaling, handoff, or destructive cleanup.
- Retry, fallback, and destructive behavior stay with the boundary that can
  prove identity, idempotency, and safe repetition. A failed advertised
  capability must not silently fall through to a second implementation that
  could duplicate work or abandon owned state.

## Conflict Rule

This document is authoritative for repository ownership and allowed dependency
direction. Current code, tests, schemas, and runtime evidence establish what the
program does; the owning living document establishes the durable subsystem
contract or procedure.

If implementation and a living document disagree, determine which is stale and
correct it in the same change. Historical plans, release narratives, audit
findings, and old acceptance evidence are context only, never current authority.
