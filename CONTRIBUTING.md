# Contributing to Station

Thank you for taking the time to improve Station. Bug reports, documentation
corrections, focused code changes, and thoughtful design feedback are all useful.
You do not need to understand the entire system before contributing to one part
of it.

Station is experimental pre-alpha software. Expect active development.

## Ways to Contribute

- Report behavior that differs from the documentation or your expectations.
- Improve an unclear explanation, example, error-recovery step, or limitation.
- Add a focused test for a reproducible bug.
- Improve one provider, Observer flow, CLI command, or TUI interaction.
- Share a use case that the current workflow does not serve well.

Small improvements are welcome.

## Before You Start

Search [existing issues](https://github.com/jeremy0dell/station/issues) before
opening a new report. For a broad behavior change, new integration, or repository
boundary change, start with an issue so the intended outcome and scope can be
agreed before a large implementation is written.

Read the [Philosophy](docs/philosophy.md) for the product decision lens. Use the
[documentation home](docs/README.md) to find the user or contributor guide for
the area you are changing.

## Report a Bug

A strong report includes:

- the Station version from `stn --version`;
- the operating system and architecture;
- what you expected to happen;
- what happened instead;
- the smallest sequence that reproduces the behavior; and
- relevant output from `stn doctor` or a trace lookup.

Start with the [Debugging guide](docs/debugging.md). Diagnostic bundles are
designed to be redacted, but review all output before sharing it. Never post
credentials, tokens, private source, or unrelated machine data.

## Set Up a Development Checkout

Development uses Node.js 24.2+ and below 25, pnpm 11, and Bun 1.3.14 for the
Station renderer and compiled-binary lanes.

```sh
pnpm install
pnpm build
cd station && bun install && cd ..
```

Read [Development](docs/development.md) before choosing a test command. Use
[Local development](docs/local-development.md) for isolated Observer, TUI, and
tmux workflows; provider-backed and real-agent lanes require additional care.

## Test Your Change

For documentation-only work, run:

```sh
pnpm lint
pnpm test:diagnostics:policy
```

For implementation work, run the narrowest relevant test while iterating, then
the deterministic gate before requesting review:

```sh
pnpm test:all
```

Real-provider and broader end-to-end lanes are opt-in. Do not run them against
personal provider state when an isolated development lane can prove the behavior.
The [Development guide](docs/development.md) is the source of truth for current
test gates.

## Open a Pull Request

Keep the change focused enough that a reviewer can understand its responsibility
and risk. Use a semantic, reviewer-oriented title such as:

```text
fix(tui): preserve session focus after dashboard refresh
```

A substantive pull request should explain, in order:

1. **What this fixes** — the affected responsibility, concrete problem, and why it matters.
2. **What changed** — the resulting behavior and important design decisions.
3. **Testing** — the meaningful validation performed.

Include user-visible behavior or safety and scope when either helps a reviewer
make a decision. Avoid a file-by-file narration that repeats the diff.

## How We Work Together

Be direct, specific, and considerate. Discuss the work rather than the person,
make room for questions, and explain unfamiliar project language on first use.
Avoid treating prior knowledge as a prerequisite or describing a confusing step
as "obvious" or "just" easy.

Disagreement is useful when it improves the decision. State the trade-off,
provide evidence where possible, and leave the conversation clearer than you
found it.
