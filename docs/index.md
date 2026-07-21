# Station Documentation

Station is a terminal workspace for running AI coding agents in isolated Git worktrees. It is currently available as a private preview for macOS and Linux on arm64 and x64.

## Start Here

- [Install Station](install.md) — install the public stable binary or the
  current authenticated preview.
- [Agent-led install prompt](install.md#let-your-agent-install-and-validate-station) — let a coding agent install the binary and validate `stn setup` safely.
- [Quick start](quick-start.md) — add a project and create your first agent session.
- [Overview](overview.md) — understand projects, worktrees, sessions, providers, and the observer.

## Use Station

- [Configuration](configuration.md) — configure projects, providers, harnesses, hooks, and the terminal workspace.
- [Harnesses](harnesses.md) — compare supported agents, status coverage, and hook delivery.
- [Diagnostics](diagnostics.md) — check runtime health and collect support evidence.
- [Debugging](debugging.md) — investigate a trace, command, diagnostic ID, or runtime symptom.
- [Limitations and workarounds](limitations.md) — review current user-visible constraints.

## Develop Station

- [Development](development.md) — set up the toolchain and choose the correct test gate.
- [Local development](local-development.md) — run isolated observer, TUI, and tmux development lanes.
- [Architecture](architecture.md) — understand repository boundaries and sources of truth.
- [Observer architecture](observer-architecture.md) — work with Observer ports, adapters, flows, persistence, and dependency direction.
- [TUI development](tui.md) — change the OpenTUI workspace and its tests.
- [Harness authoring](harness-authoring.md) — add or upgrade an agent harness integration.
- [System dependencies](system-dependencies.md) — understand external tools and setup checks.

Contributor references describe the current implementation and its invariants. Historical design records and release-planning files remain in the repository but are not part of this documentation path.
