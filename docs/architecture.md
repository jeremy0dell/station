# Architecture

Status: current living repository-wide system and boundary map.

Use [Naming](naming.md) for provider hook, provider hook ingress, harness event report, STATION event, and observer event hook terminology.

Use [Observer Architecture](observer-architecture.md) for the Observer's application model,
dependency direction, runtime flows, state lifetimes, and active deviations. Use
[Architecture Documentation](architecture-documentation.md) for the controlled JSDoc language
applied to Observer architectural seams.

station is a terminal-native control plane for AI-agent worktree sessions. It keeps repositories, worktrees, terminal targets, provider hooks, agent runs, commands, and diagnostics in one runtime graph.

## Current Shape

The main runtime model is:

```text
config declares managed projects and defaults
providers observe external systems
observer correlates provider truth into snapshots and commands
protocol exposes observer APIs over NDJSON transport
CLI starts, controls, and debugs the system
TUI renders snapshots/events and submits typed commands
```

The repo is organized around these boundaries:

- `apps/observer` owns runtime correlation, reconciliation, command routing, provider health, persistence, hook ingestion, harness ingress queuing, diagnostics, and snapshot publication.
- `apps/cli` owns the `stn` command surface: observer lifecycle, setup/doctor, reconcile/snapshot, hooks, debug trace, debug bundles, and terminal UI entrypoints.
- `station/` owns the terminal UI (the OpenTUI renderer, package `@station/workspace`). It consumes observer snapshots/events through `@station/protocol` and must not call providers directly.
- `packages/contracts` owns shared application schemas and types, including `ObserverApi`, external-launch values, commands, events, snapshots, observations, provider ports, hooks, diagnostics, and safe errors.
- `packages/protocol` owns the observer NDJSON transport: envelopes, method mapping, validation execution, and client/server mechanics.
- `packages/runtime` owns shared runtime boundary helpers for timeouts, retry, cancellation, external commands, and typed error conversion.
- `packages/client` owns the framework-neutral rich-client observer runtime: snapshot loading, the event subscription/reconnect loop, event-to-snapshot reduction, and command dispatch/completion-wait wrappers consumed by the Station UI.
- `apps/cli/src/ingress` owns the tiny `stn-ingress` sender: raw provider hook delivery to the observer socket and offline spool writes. Events sent through this raw path normalize and compact observer-side via provider hook adapters; integrations that submit typed harness reports normalize in their own adapter.
- `packages/station-host` owns the standalone `station-station-host` daemon contract and client: a process that owns PTYs outliving the Station UI, exposing attach/list/close over its own local socket so panes can warm-reattach with scrollback. Station consumes it directly; Observer application code can reach host-backed terminal behavior only through an adapter supplied by CLI composition.
- `packages/config`, `packages/observability`, and `packages/testing` are shared support packages.
- `integrations/...` adapt external tools: Worktrunk, tmux, Claude Code, Codex, Cursor, Pi, OpenCode, scripted harnesses, and GitHub repository metadata.

## Source Of Truth

No single layer owns all truth.

- Config is authoritative for the projects station manages, project defaults, provider choices, and safe local policy.
- Worktree providers are authoritative for external worktree existence and worktree metadata they can prove.
- Terminal providers are authoritative for terminal topology and provider-owned target identity.
- Harness providers are authoritative for agent launch, discovery, event ingestion, and status signals they can prove.
- Repository providers are authoritative only for code-host metadata they fetch or cache through their integration boundary.
- Observer SQLite is durable observer memory for commands, events, correlations, provider observations, and current metadata cache rows.
- Observer snapshots are the normalized current graph exposed to clients.
- JSONL logs and debug bundles are diagnostic evidence, not runtime truth.

When these disagree, reconcile from config, providers, and current observer state first. Treat stale logs, old bundles, and historical plans as evidence to inspect, not as authority.

## Boundary Rules

- Provider-specific behavior stays in `integrations/...` or provider-injected capabilities. Observer/core code aggregates through contracts, registries, and provider interfaces.
- Station-managed terminal lifecycle is supplied as an explicit application role. Observer application code may forward target IDs returned by that role, but must not select its adapter by provider ID, reconstruct provider-owned target IDs, or discover lifecycle operations through runtime method probing.
- The Station UI is a client. It renders snapshots/events and dispatches typed commands; it must not import providers, read SQLite, run `wt`, run `tmux`, run `git`/`gh`, or parse raw provider payloads for core behavior.
- The CLI is the command/debug entrypoint, but long-lived runtime correlation belongs in the observer.
- `packages/contracts` defines shared language with strict schemas for untrusted input and shared payloads.
- The protocol validates transport messages and keeps consumer APIs simple. It should not become a provider boundary.
- Effect/runtime usage belongs at IO, orchestration, timeout, retry, cancellation, queue, and external-command boundaries. Prefer Effect when one block combines async streams or subscriptions with cancellation, cleanup, retry/reconnect, timeout, queueing, or typed error mapping. Pure schemas, mappers, selectors, fixtures, and OpenTUI/React presentation components should stay plain TypeScript.
- Provider hooks are ingress notifications and fast status reports. They can trigger persistence, projection, spool fallback, or scheduled reconcile, but they are not authoritative graph truth by themselves. Observer event hooks are configured commands triggered by STATION events and should not be conflated with provider hook ingress.
- Terminal topology is provider-owned. Shared contracts and Station UI behavior should express product intent where possible, not provider target mechanics.

## Station UI Module Layout

Within `station/`, when a directory outgrows a handful of files, keep its public surface and composition root at the directory root and push internal concern-clusters into lowercase subdirs — mirroring `terminal/`'s `protocol|pty|registry` and `state/`'s `reducers|reconcilers`. For example `input/` keeps the consumed hubs (`router`, `mouse`) and the `stationInput` composition root at root, with `keymap/` and `runtime/` beneath. Colocate each test beside its source and move it with the source. Add an `index.ts` barrel only when a directory's public symbols would otherwise be reached through deep subpaths; skip it when the public surface already sits at the root.

Observer layout follows ownership and dependency direction rather than this UI-specific shape.
See [Observer Architecture](observer-architecture.md).

## Station Subsystem

The Station UI in `station/` is a `@station/client` consumer plus a terminal-hosting runtime:

- The `station-station-host` daemon (`packages/station-host`) owns PTYs that outlive the UI. Its socket defaults beside the observer socket at `<state_dir>/run/station-host.sock` (override `STATION_HOST_SOCKET_PATH`).
- Pane liveness is split from pane layout. On a UI restart while the host survives, panes **warm-reattach** to live PTYs with scrollback via the host's attach call; on a cold start (reboot or host down) the saved layout spec **cold-respawns** fresh shells in their saved working directory. Layout persists to `<state_dir>/station/layout.json` (override `STATION_LAYOUT_PATH`), which deliberately does not fall back to `XDG_RUNTIME_DIR` so it survives a reboot.
- "New Session" in Station hosts the agent in a Station pane by dispatching the observer `worktree.create` command, rather than launching an external tmux session. Liveness decisions (launch vs. focus, destructive guards) route through the shared `worktreeHasLiveAgent` contract in `packages/contracts`.

This subsystem runs on its own Bun lane outside the root pnpm workspace (OpenTUI / native-renderer isolation), with its boundaries kept deliberately narrow. See `docs/local-development.md` for the dev host workflow and `docs/debugging.md` for the runtime-topology checklist.

## Conflict Rule

For ordinary work, current code, current tests, package scripts, runtime evidence, and these living docs supersede old planning baselines.

When a living doc conflicts with current code or tests, verify the runtime/code path and update the doc in the same change if the doc is stale.
