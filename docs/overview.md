# Overview

Status: conceptual overview — the mental model behind station. For repository-wide boundaries
see [Architecture](architecture.md), for Observer internals see
[Observer Architecture](observer-architecture.md), and for setup see the [README](../README.md).

## What station is

station is a terminal-native control plane for AI-agent worktree sessions. It keeps one honest, live picture of the repositories, worktrees, terminal workspaces, and agent harnesses you have in flight — and lets you act on them from a single TUI.

## Why it exists

Running one AI agent is easy. Running several is not. Each agent wants its own branch and worktree, its own terminal pane, its own harness process. Within an hour you have a dozen worktrees, tmux panes whose names no longer mean anything, and no quick answer to simple questions: *Which branch has the agent that's been running for twenty minutes? Did that session finish or stall? Which pane is even which?*

The state that would answer those questions is real, but it's scattered across tools that don't talk to each other — your worktree manager knows about branches, tmux knows about panes, each agent CLI knows about its own session. station exists to **correlate that scattered truth into one graph** and keep it current, so you can see and steer your agent fleet instead of bookkeeping it by hand.

## The core idea

One process — the **observer** — owns the live picture. Everything else either feeds it evidence or asks it questions. The observer does not invent external facts; it correlates what real tools report while minting command IDs and records, events, correlations, and durable overlays needed to operate the normalized graph.

The runtime model reads top to bottom:

```text
config      declares the projects station manages and the defaults
providers   observe external systems (worktrees, terminals, harnesses, code hosts)
observer    correlates provider truth into snapshots and commands
protocol    exposes the observer over a local Unix socket (NDJSON)
CLI / TUI   control and debug the system, and render the live graph
```

A crucial subtlety: **no single layer owns all truth.** Config is authoritative for *which* projects station manages. Worktree providers are authoritative for *which worktrees exist*. Harness providers are authoritative for *agent launch and status*. The observer's job is not to be the source of truth but to *reconcile* these sources into the current graph — and when they disagree, to trust live providers and config over stale logs. Logs and debug bundles are evidence to inspect, never authority.

## How the pieces fit

- **Providers** adapt provider-facing external tools behind boundaries: *worktree* providers (Worktrunk) prove which branches and worktrees exist; *terminal* providers (tmux) own pane and window topology; *harness* providers (Claude Code, Codex, Cursor, Pi, OpenCode) report agent launches and status; *repository* providers fetch code-host metadata like PR and CI state. Other outside-world edges include SQLite, filesystem, sockets, logging, Git, and processes. The adopted Observer architecture puts those mechanics behind application-owned adapter seams and tracks current violations explicitly.

- **The observer** is the long-lived background process. It runs reconciliation, routes commands, tracks provider health, persists durable memory in SQLite, ingests provider hooks, and publishes the graph. It is the one place where scattered evidence becomes a coherent picture.

- **Snapshots and events** are the two ways to read the graph. A *snapshot* is the whole current graph at a moment; *events* (`StationEvent`s like `worktree.agentStateChanged` or `command.failed`) are the incremental changes clients subscribe to. A client subscribes, loads a full snapshot while the subscription is live, reduces safe events, and reloads after a gap or an event it cannot reduce safely.

- **Commands** are how clients change the world. Clients never run `git`, `tmux`, or `wt` themselves — they submit a typed command (for example, "create a session for this project on this branch with this harness"), and the observer routes it to the providers that own the mechanics.

- **Clients** — the CLI and the TUI — render the graph and dispatch commands. The TUI is the live dashboard; the CLI (`stn`) handles observer lifecycle, setup, reconcile, snapshots, hooks, and debugging. Both are *consumers*: they ask the observer, they don't invent state.

## Two kinds of hooks (don't conflate them)

The word "hook" points in two opposite directions, and keeping them straight is the key to reasoning about runtime behavior:

- **Provider hooks are ingress.** They are external callbacks — a Claude Code hook, a Worktrunk lifecycle hook — that *enter* the observer as evidence. They are hints and status reports, not authoritative truth on their own; the observer decides what they mean.
- **Observer event hooks are egress.** They are commands *you configure* to run when a `StationEvent` matches (for example, notify me when an agent goes idle).

The full directional model: a provider hook callback enters as ingress, becomes a normalized report, drives observer persistence and reconcile, may emit a `StationEvent`, which may finally trigger an observer event hook. (See [Naming](naming.md) for the precise vocabulary.)

## Design principles

- **Terminal-native.** station is a TUI/CLI tool first. The interface is the terminal, not a browser.
- **Provider boundaries.** External tools stay in their own lane. station checks and reports their availability rather than bundling or wrapping them, so the core stays provider-neutral.
- **Diagnostics from day one.** Trace IDs, command lifecycle records, debug bundles, and bounded log retention are built in, so when something goes wrong you can ask the system what happened instead of guessing.

## Where to go next

- [README](../README.md) — install, setup, and first run
- [Architecture](architecture.md) — the authoritative boundary and ownership map
- [Naming](naming.md) — provider hooks, harness reports, STATION events, and observer event hooks
- [Development](development.md) — environment, test gates, and conventions
- [Debugging](debugging.md) — trace IDs, command lifecycle, and runtime evidence lookup
