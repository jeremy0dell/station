# Station Documentation

Welcome to Station. These docs are for people setting up their first agent session,
people returning to troubleshoot a running workspace, and contributors working on
the system itself. You do not need to understand Station's internals before you
can use it or help improve it.

> [!IMPORTANT]
> Station is experimental pre-alpha software. The current public version is
> `v0.0.0-pre-alpha.6`. Native binaries support macOS 13+ and glibc 2.39+ Linux
> on arm64 and x64.

## Start Here

Choose the path that matches what you want to do:

| Goal | Start with |
| --- | --- |
| Install Station safely | [Install Station](install.md) |
| Let a coding agent handle installation | [Agent-led install prompt](install.md#let-your-agent-install-and-validate-station) |
| Create your first agent session | [Quick start](quick-start.md) |
| Understand the system before using it | [Overview](overview.md) |
| Understand the choices behind Station | [Philosophy](philosophy.md) |
| Diagnose something that is not working | [Debugging](debugging.md) |

Install the current release:

```sh
curl --disable -fsSL https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.6/install.sh | sh
```

Then complete and verify setup:

```sh
stn setup
stn setup check --json
stn doctor
```

> [!TIP]
> If Station is already installed, go straight to the [Quick start](quick-start.md).
> It takes you from setup to an isolated agent session without requiring an
> architecture tour first.

## Use Station

These guides are organized around the work you are trying to complete:

- [Quick start](quick-start.md) — add a project and create your first agent session.
- [Configuration](configuration.md) — configure projects, providers, harnesses, hooks, and the terminal workspace.
- [Harnesses](harnesses.md) — compare supported agents, status coverage, and hook delivery.
- [Diagnostics](diagnostics.md) — check current health and collect support evidence.
- [Debugging](debugging.md) — investigate a trace, command, diagnostic ID, or runtime symptom.
- [Limitations and workarounds](limitations.md) — review current user-visible constraints and recovery paths.

## Understand Station

Use these pages when you want the reasoning and mental model behind the commands:

- [Philosophy](philosophy.md) — the product principles that guide Station.
- [Overview](overview.md) — projects, worktrees, sessions, providers, commands, and the observer.
- [Naming](naming.md) — the shared vocabulary for hooks, reports, events, and providers.
- [Architecture](architecture.md) — repository boundaries, ownership, and sources of truth.

## Develop Station

You do not need to learn the entire repository before improving one part of it.
Start with the workflow for your change, then follow the deeper architecture link
only when that boundary is involved.

- [Contributing](../CONTRIBUTING.md) — report bugs, prepare changes, and open a pull request.
- [Development](development.md) — set up the toolchain and find the owning contributor guide.
- [Testing](../tests/README.md) — choose a test gate and understand machine isolation.
- [Releasing](releasing.md) — prepare, accept, and promote a native release.
- [Local development](local-development.md) — run isolated observer, TUI, and tmux development lanes.
- [Architecture](architecture.md) — understand repository-wide boundaries and sources of truth.
- [Observer architecture](observer-architecture.md) — work with Observer ports, adapters, flows, persistence, and dependency direction.
- [Dashboard architecture](dashboard-architecture.md) — work with the dashboard runtime, role entrypoints, and state ownership.
- [TUI development](tui.md) — change the OpenTUI workspace and its tests.
- [Harness authoring](harness-authoring.md) — add or upgrade an agent harness integration.
- [System dependencies](system-dependencies.md) — understand external tools and setup checks.

Documentation corrections, focused bug reports, and small fixes are useful
contributions. A report does not need to include a root-cause diagnosis to be
valuable.

## Get Help

If Station behaves differently from what you expected:

1. Run `stn doctor` for current health.
2. Follow [Debugging](debugging.md) when you have an ID or a specific symptom.
3. Review [Limitations and workarounds](limitations.md) for known preview constraints.
4. Open a report in [GitHub Issues](https://github.com/jeremy0dell/station/issues) with what you expected, what happened, and the smallest useful reproduction.

Diagnostic bundles are designed to be redacted, but review any output before
sharing it. Questions and unclear documentation are useful feedback too.

Contributor references describe the current implementation and its invariants.
Historical design records and release-planning files remain in the repository
but are not part of this documentation path.
