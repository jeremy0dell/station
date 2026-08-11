# Architecture

Status: current living repository-wide system and boundary map.

Use [Philosophy](philosophy.md) for the product principles that guide Station.
This document remains authoritative for implementation boundaries and ownership.

Use [Naming](naming.md) for provider hook, provider hook ingress, harness event report, STATION event, and observer event hook terminology.

Use [Observer Architecture](observer-architecture.md) for the Observer's application model,
dependency direction, runtime flows, state lifetimes, and active deviations. Use
[Observer singleton lifecycle](observer-singleton.md) for process ownership, handoff,
displacement, duplicate cleanup, and explicit reap. Use
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
- `packages/dashboard-core` owns the render-framework-free dashboard behavior shared by Station's native workspace and standalone dashboard renderer compositions: projection state, screens, actions, lifecycle, and role entrypoints (see [Dashboard Architecture](dashboard-architecture.md)).
- `packages/contracts` owns shared application schemas and types, including `ObserverApi`, external-launch values, commands, events, snapshots, observations, provider ports, hooks, diagnostics, and safe errors.
- `packages/protocol` owns the observer NDJSON transport: envelopes, method mapping, validation execution, client/server mechanics, and fail-closed Unix-socket probing and stale-owner evidence.
- `packages/runtime` owns shared runtime boundary helpers for timeouts, retry, cancellation, external commands, typed error conversion, and atomic text replacement.
- `packages/setup-core` owns runtime-independent setup decisions and operation ports over normalized evidence and intent, including semantic issues, operations, plans, typed outcomes, and readiness results. Its only package dependency is contracts for shared types such as `SafeError` and the CLI setup harness ID; setup-core imports no contract runtime values.
- `packages/setup-messages` owns UI-independent setup message IDs, typed arguments, message references, and presentation copy variants. Setup core remains copy-independent; CLI presentation combines semantic setup state with this catalog.
- `packages/client` owns the framework-neutral rich-client observer runtime: one canonical snapshot/connection state source, the event subscription/reconnect loop, event-to-snapshot reduction, and a convergence-safe Observer service whose loads and reconciliation commit to that same reducer base before resolving to Station UI consumers. Group events reduce directly only when version progress and graph relationships are safe; structural ambiguity and `session.created` enter the bounded canonical refresh chain so clients never synthesize a relationship-incomplete session. Accepted Group terminal outcomes await a canonical load. Provider-neutral typed command execution normalizes rejection, acceptance, completion, and thrown failures without owning UI policy.
- `apps/cli/src/ingress` owns the tiny `stn-ingress` sender: raw provider hook delivery to the observer socket and offline spool writes. Events sent through this raw path normalize and compact observer-side via provider hook adapters; integrations that submit typed harness reports normalize in their own adapter.
- `packages/station-host` owns the standalone `station-station-host` daemon contract and client: a process that owns PTYs and their bounded raw/semantic replay state beyond the Station UI lifetime, exposing attach/list/close over its own local socket so panes can warm-reattach. Station consumes it directly; Observer application code can reach host-backed terminal behavior only through an adapter supplied by CLI composition.
- `packages/config` owns runtime-config parsing plus setup config generation, source-preserving mutation planning, validation, preconditions, backups, and atomic persistence. `packages/observability` and `packages/testing` are shared support packages.
- `integrations/...` adapt external tools: Worktrunk, tmux, Claude Code, Codex, Cursor, Pi, OpenCode, scripted harnesses, and GitHub repository metadata.

## Source Of Truth

No single layer owns all truth.

- Config is authoritative for the projects station manages, project defaults, provider choices, and safe local policy.
- Worktree providers are authoritative for external worktree existence and worktree metadata they can prove.
- Terminal providers are authoritative for terminal topology and provider-owned target identity.
- Harness providers are authoritative for agent launch, discovery, event ingestion, status signals, and provider-native recovery artifacts they can prove.
- A sealed session-rescue archive becomes temporary cutover authority only after the exact source sessions have stopped and every recovery-critical asset has been captured and hashed; a live-source archive remains evidence, not launch authority.
- Repository providers are authoritative only for code-host metadata they fetch or cache through their integration boundary.
- Observer SQLite is durable observer memory for commands, events, correlations, explicit Station-session lifecycle, project-local Session Group definitions and exclusive membership, canonical worktree display titles keyed by project and worktree, provider observations, and current metadata cache rows.
- Observer snapshots are the normalized current graph exposed to clients. `rows` is configured
  worktree inventory; `sessions` is canonical session membership; and `sessionGroups` is the
  flat project-local organizational projection, retaining optional parent relationships in
  deterministic parent-before-child order. `WorktreeRow.title` is the
  display authority, while `SessionView.title` is its lifecycle projection. Session and activity
  counts derive from `sessions`, while worktree counts derive from `rows`.
- JSONL logs and debug bundles are diagnostic evidence, not runtime truth.

When these disagree, reconcile from config, providers, and current observer state first. Treat stale logs, old bundles, and historical plans as evidence to inspect, not as authority.

## Boundary Rules

- Provider-specific behavior stays in `integrations/...` or provider-injected capabilities. Observer/core code aggregates through contracts, registries, and provider interfaces; session migration locates Codex, Claude, and OpenCode recovery artifacts through provider-owned adapters rather than scraping their layouts in Observer code.
- Station-managed terminal lifecycle is supplied as an explicit application role. Observer application code may forward opaque managed-terminal attachments returned by that role, but must not select its adapter by provider ID, reconstruct provider-owned target IDs, or expose Station Host PTY and socket mechanics. Forgetting a deterministic managed target requires its expected Station session, so delayed exits and failed launches cannot remove a replacement binding.
- Station resolves managed-terminal attachments through its own host attacher. An absent attachment permits the existing local launch; an advertised attachment that cannot resolve fails visibly and must never fall through to a local spawn.
- The Station UI is a client. It renders snapshots/events and dispatches typed commands; shared dispatch/completion normalization belongs to `@station/client`, while optimistic rows, fallback copy, toasts, and renderer effects remain dashboard or composition policy. Station must not import providers, read SQLite, run `wt`, run `tmux`, run `git`/`gh`, or parse raw provider payloads for core behavior.
- Observer singleton selection remains generic: non-UI commands, hooks, ingress, and protocol clients may use the healthy handoff winner selected by Observer build ordering. A command-capable Station UI launcher adds a stricter composition check after that selection and proceeds only when its complete caller selector exactly equals the accepted Observer selector. Native Station directly operates Station Host, while the pane-free popup dashboard can dispatch commands that produce later Host work, so both refuse before renderer, reconcile, popup, Host, PTY, or layout effects.
- The outer terminal environment is authoritative only for Station's OpenTUI
  renderer. Its strictly observed palette is appearance authority only for the
  embedded standalone/tmux dashboard; Station resolves that evidence into one
  complete provider-neutral theme, and terminal providers do not participate in
  appearance selection. Native `auto` remains Station-owned; Station does not
  request or consume outer-palette evidence for native appearance selection.
  Native composition supplies one resolved `StationTerminalTheme` projection
  to the PTY registry, which remembers it for future emulator screens and fans
  updates out to existing Station-owned screens without becoming appearance
  authority. This visual operation changes no PTY identity, environment,
  lifecycle, provider behavior, or Observer/Station Host contract.
  Every Station-owned child PTY receives Station's terminal
  identity and supported capabilities at the final native spawn boundary; local
  bridge, Bun, and Station Host paths must not expose outer-emulator identity as
  child capability evidence. A persistent Station Host process is never renderer
  provenance, so Host PTYs fail closed on inherited and launch-plan tmux
  context and on daemon-inherited color controls; only color controls carried
  by the explicit launch request are authoritative.
- The CLI is the command/debug entrypoint, but long-lived runtime correlation belongs in the observer.
- Update orchestration remains in the CLI. Install-channel adapters prove physical ownership and normalize only current/target identity, mutation commands, warnings, successor launcher identity, and apply recovery they alone can own. `stn update` selects exactly one owner, plans before mutation, and leaves package-manager channels deferred unless explicitly driven. Mutation-capable updates default to `processes` Host preservation: before install mutation the CLI inspects the incumbent, requires a viable dry-run handoff only for a busy compatible replacement, and fails closed when preservation is uncertain. `--handoff=screen` changes fidelity, while `--no-handoff` explicitly leaves the incumbent in place and warns that a later TUI may refuse it. A dev-checkout fast-forward commits before frozen root and Station UI dependency preparation, rebuild, nested relinking, native-helper repair, and launcher relinking; preparation failure preserves that commit and reports the adapter's complete idempotent recovery sequence. After channel apply completes, the new launcher restarts Observer before any planned Host handoff, so the old process never impersonates the installed build. Later failure does not roll back a verified installation or Git fast-forward and reports sanitized evidence plus exact recovery commands.
- Setup orchestration remains in the CLI. Its inspection adapter validates external facts, probes provider-owned tracking status, and normalizes only semantic evidence for the in-memory `@station/setup-core` session. `setup check`, `setup plan`, and non-interactive apply drive that session through inspect, install/preflight, re-inspect, config commit, Observer activation, re-inspect, tracking, and final verification; its typed operation checkpoints prevent completed operations from replaying only within that process and make no restart-recovery claim. Config, TOML, provider payloads, and provider-native identities remain in CLI adapters; provider tracking runs in-process and only sanitized commit evidence returns to setup-core. The session view resolves no copy. Human presenters alone resolve `@station/setup-messages` references, while `presenters/json.ts` independently owns the stable JSON projection and calculates legacy warning rows from semantic evidence rather than core result counts. Guided `stn setup` now drives the same invocation-local session application through the Clack terminal adapter, including typed cancellation, staged prerequisite preparation, and the complete apply sequence; its operation checkpoints remain process-local and make no persistence or restart-recovery claim. Clack is selected only at CLI composition, owns interactive controls and compact progress, and requires TTY input and output before inspection starts. Guided presentation progressively discloses the current decision, selected prerequisite changes, and focused blockers; the complete Core/Recommended/Actions/Next diagnostic matrix remains exclusive to check and plan surfaces. Mutation consent copy keeps the decision primary and supporting effects visually secondary; trusted web sources use allowlisted OSC 8 labels, stable command names replace resolved temporary shim paths, and home-relative targets avoid exposing raw operation payloads. Tmux configuration revalidates the selected key against the exact admitted config bytes and current server immediately before mutation. Operation progress is a non-authoritative outward port: presenter failures surface only after operation evidence is incorporated and cannot rewrite outcomes or checkpoints. Check and plan JSON project the frozen CLI schema directly from semantic state and inspection evidence; machine actions are presentation records and never execution authority. `setup system` is a bootstrap boundary that executes ordered typed tool operations through the same CLI operation adapter, stops after the first required install failure, and then collects fresh bootstrap facts. The text presenter remains available for semantic setup results, recovery blocks, non-Clack terminal layout, styling, shell quoting, and output writing. Routine successful progress is intentionally outcome-only, without repeating path or command details already present in the plan; failures retain sanitized evidence and recovery commands. Future graphical variants live beside terminal copy rather than in setup state or flow control.
- `packages/contracts` defines shared language with strict schemas for untrusted input and shared payloads.
- The protocol validates transport messages and keeps consumer APIs simple. It should not become a provider boundary.
- Client processes may spawn after an absent or proven-stale socket, but only the process binding the replacement may unlink it. Inaccessible ownership is preserved; pidfiles never establish liveness or authorize reclaim.
- Effect/runtime usage belongs at IO, orchestration, timeout, retry, cancellation, queue, and external-command boundaries. Prefer Effect when one block combines async streams or subscriptions with cancellation, cleanup, retry/reconnect, timeout, queueing, or typed error mapping. Pure schemas, mappers, selectors, fixtures, and OpenTUI/React presentation components should stay plain TypeScript.
- Provider hooks are ingress notifications and fast status reports. They can trigger persistence, projection, spool fallback, or scheduled reconcile, but they are not authoritative graph truth by themselves. Observer event hooks are configured commands triggered by STATION events and should not be conflated with provider hook ingress.
- Every managed agent launch preflights only its selected active harness immediately before mutation: launch capability, a fresh provider-health probe, and provider-owned hook status when supported remain separate authoritative facts coordinated by one ephemeral Observer use case. This creates no readiness catalog, cache, or durable readiness state, and returning an existing live session remains ungated.
- Terminal topology is provider-owned. Shared contracts and Station UI behavior should express product intent where possible, not provider target mechanics.
- The Station terminal provider may select a generic terminal-output compatibility policy at the managed-PTY launch boundary. Station carries the selected policy into both UI-owned fallback PTYs and Host-owned PTYs without exposing harness identity at either PTY boundary. The current policy rewrites only the exact row-1 region scroll followed by its correlated cursor-and-erase repaint.

## Station UI Module Layout

Within `station/`, when a directory outgrows a handful of files, keep its public surface and composition root at the directory root and push internal concern-clusters into lowercase subdirs — mirroring `terminal/`'s `protocol|pty|registry` and `state/`'s `reducers|reconcilers`. For example `input/` keeps the consumed hubs (`router`, `mouse`) and the `stationInput` composition root at root, with `keymap/` and `runtime/` beneath. Large runtime directories such as `host/` and `terminal/pty/` keep their tests in one lowercase `test/` child; smaller concerns may colocate tests beside their source. Add an `index.ts` barrel only when a directory's public symbols would otherwise be reached through deep subpaths; skip it when the public surface already sits at the root.

Observer layout follows ownership and dependency direction rather than this UI-specific shape.
See [Observer Architecture](observer-architecture.md).

## Station Subsystem

The Station UI in `station/` is a `@station/client` consumer plus a terminal-hosting runtime. Its Station-owned VT vocabulary lives under `station/src/terminal/protocol/`: typed command identities, domain values, complete sequence constants, and state reducers support explicit byte templates without widening `packages/protocol` or `packages/contracts`.

- The `station-station-host` daemon (`packages/station-host`) owns PTYs that outlive the UI. Its socket defaults beside the observer socket at `<state_dir>/run/station-host.sock` (override `STATION_HOST_SOCKET_PATH`).
- Host output compatibility is an optional generic spawn policy selected by integrations and applied before both scrollback retention and attached-client broadcast, so live and warm-reattached views consume one byte stream.
- Host retains complete transformed output plus every production-geometry transition within its bounded raw replay budget. Attach returns those ordered events while complete; after eviction it prefers restoration VT from xterm's serializer plus the small set of Station-relevant modes that serializer omits. Semantic capture fails closed between xterm parser boundaries, and the client retries that transient state after later output can complete the sequence. At a safe boundary where exact reconstruction is unavailable, Host retains the live sink and returns RIS-prefixed, control-only reset data that restores the boundary-captured interaction modes and a valid active-buffer cursor anchor without historical content; Station applies it before nudging PTY geometry so cursor-relative child repaint remains positioned from the captured frame. Live resize frames remain ordered with later output.
- Host reuse independently requires exact Host protocol and Station display-build-version equality. A different-display-version idle host is replaced through atomic stop-if-idle. A host with any agent or auxiliary PTY is preserved and the upgrade fails visibly (`HOST_UPGRADE_BLOCKED`) unless the caller opts into negotiated live handoff (`host.beginHandoff` / `completeHandoff` / `abortHandoff`, or `stn host handoff`). Handoff never crosses a Host protocol major mismatch. Attach still transfers replay events and live frames, never PTY file descriptors; ownership moves by parking per-terminal bridges and adopting their control sockets. Observer selectors additionally carry immutable build identity, so UI admission is not an immutable three-process cohort rule. Every PTY lifetime has one canonical `{ terminalTargetId, ptyId, ptyInstanceId }` reference. Spawn reuses a target only when every immutable identity field agrees, and attach requires the exact reference and acknowledgement identity so a replacement session or later PTY lifetime cannot inherit a stale attachment.
- Native TUI launch performs bounded Host health, compatibility, and idle-stop admission before layout restoration. Exact `STATION_HOST_HANDOFF=1` lets only a busy same-protocol replacement leave that bound for negotiated handoff; the successor re-lists adopted PTYs before warm restore and managed attachment resolution use the same inventory path. Before `completeHandoff` commits, a failed begin or successfully aborted completion failure restores the original busy-Host refusal with sanitized handoff evidence. After commit, or when abort cannot prove complete restoration, failure reports parked-bridge successor recovery and cannot claim the incumbent remains. Every failure stays visible and prohibits cold restore or local-spawn fallback. After invoking the native renderer, CLI composition starts one process-local owner-aware update detection and planning check with no persistent cache. It never calls the plan's apply capability; renderer resolution aborts unfinished discovery without awaiting it, and only an already-completed version-changing plan may print after a normal zero-code, unsignaled exit. Popup and fake-dashboard renderers never start this check.
- Host output may fan out to many attachments, while a Host-issued attachment lease allows at most one controller to write or resize each PTY. Controller grants advance a per-PTY epoch and revoke the former controller before it can mutate again; detach leaves viewers and the live PTY intact without promoting either. Native renderers cache their desired geometry while viewing and reclaim only for user input, then apply the latest geometry before forwarding that input. Bare PTY identity, resize traffic, process identity, and renderer environment never grant mutation authority.
- Each Host PTY runs behind a per-terminal bridge process. When the owning host dies without an intentional stop, or when beginHandoff releases owner pipes without SIGTERM, the bridge enters orphan mode: it keeps the PTY alive, parks output in a bounded backlog, and serves a per-bridge control socket under `<state_dir>/run/pty-bridges/` until a new host adopts it or a bounded TTL reaps it. The PTY instance ID survives negotiated handoff, abort re-adoption, and crash-orphan adoption; a bridge rejects an adopter naming another instance before changing ownership. A host crash therefore no longer kills its agents, and a clean host startup reaps stale orphan remains. Fidelity `processes` transfers registry + raw scrollback; `screen` additionally best-effort semantic snapshots and degrades to replay when capture fails. An intentional `host stop` still disposes owned PTYs; without handoff opt-in the busy-host refuse contract is unchanged.
- Host handoff and orphan-bridge adoption preserve an existing PTY and therefore always precede application recovery. Only when no live or attachable managed target remains may native activation resume one exact provider-native handle into a new PTY under reconcile's canonical open Station session ID. This preserves provider transcript identity while leaving canonical worktree-title, status-projection, and session-readiness ownership unchanged; it does not transfer a PTY, child process, file descriptor, screen, or scrollback.
- Observer external-launch results carry only an opaque managed-terminal target identity. Station resolves exactly one matching live Station Host PTY for the expected Station session immediately before pane creation, then retains its canonical PTY reference across reconnects; duplicate targets or stale identity fail visibly without a local-spawn fallback. Socket paths and PTY identity remain on the Station side of the boundary.
- Pane liveness is split from pane layout and attachment availability. A proven-exited managed pane retains its transcript and layout until explicit dashboard activation successfully prepares and recycles that exact runtime entry; direct pane navigation never relaunches it. On a UI restart while the host survives, panes **warm-reattach** through the Host's boundary-captured replay or mode-restoring live reset; on a cold start (reboot or host down) the saved layout spec **cold-respawns** fresh shells in their saved working directory. Compatibility and exhausted-transport failures mark the pane attachment unavailable without reporting a process exit to Observer; inability to reconstruct historical output does not block a live attachment. Layout persists to `<state_dir>/station/layout.json` (override `STATION_LAYOUT_PATH`), which deliberately does not fall back to `XDG_RUNTIME_DIR` so it survives a reboot.
- "New Session" and Fork in Station host the agent in a Station pane by dispatching observer `worktree.create` or `worktree.fork` with the resolved `launchHarness`, rather than launching an external tmux session. The optional field distinguishes launch-bound mutation from ordinary worktree-only commands; Station reuses that exact harness for later external preparation. New Session alone may carry an existing-root or inline-create Group placement into external preparation; Observer commits that placement with the fresh session seed before target publication. Liveness decisions (launch vs. focus, destructive guards) route through the shared `worktreeHasLiveAgent` contract in `packages/contracts`.
- Each `DashboardRuntime` owns one private effect scope for dashboard operations, capability completion, directory polling, and failed-row expiry. Disposal closes admission synchronously, detaches subscriptions, clears owned timers, suppresses late state writes, and asynchronously drains already-started bounded work before the renderer composition stops its client.

This subsystem runs on its own Bun lane outside the root pnpm workspace (OpenTUI / native-renderer isolation), with its boundaries kept deliberately narrow. See `docs/local-development.md` for the dev host workflow and `docs/debugging.md` for the runtime-topology checklist.

## Conflict Rule

For ordinary work, current code, current tests, package scripts, runtime evidence, and these living docs supersede old planning baselines.

When a living doc conflicts with current code or tests, verify the runtime/code path and update the doc in the same change if the doc is stale.
