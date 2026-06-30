# Tier 2 of the varied-machine-state test environment (see docs/setup-testing.md).
#
# A single multi-stage build whose per-profile final stages add or withhold real
# binaries, so `stn setup check --json` runs against a genuine Linux process tree
# with real exit codes and filesystem behaviour. Homebrew and the Xcode Command
# Line Tools are macOS-only, so brew/CLT profiles are covered by tier 3 (Tart),
# not here — every Linux image already exercises the "brew absent" manual path.
#
# Build one profile:  docker build -f tests/env/docker/Dockerfile --target no-git -t stn-setup-no-git .
# Run it:             docker run --rm stn-setup-no-git
# Or use the runner:  node scripts/test-runners/run-setup-container.mjs no-git
#
# Profile names mirror packages/testing/src/setupProfiles.ts (the canonical
# contract). Only the Linux-coverable profiles have a stage here.

# ---- builder: install + build the workspace once -------------------------------
FROM node:24-bookworm AS builder
RUN corepack enable && corepack prepare pnpm@11.0.0 --activate
WORKDIR /app
COPY . .
# The CLI/observer build is enough for `stn`; the Bun TUI workspace is not needed.
RUN pnpm install --frozen-lockfile && pnpm build

# ---- base: the built CLI on a full toolchain -----------------------------------
# git + tmux present; an agent CLI is faked with a tiny shim so the harness check
# passes. This stage is the "happy-path-linux" profile.
FROM node:24-bookworm AS happy-linux
RUN corepack enable && corepack prepare pnpm@11.0.0 --activate \
  && apt-get update && apt-get install -y --no-install-recommends git tmux \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app /app
# Fake Worktrunk, Bun, diffnav, delta, and an agent CLI on PATH (presence is enough).
RUN for tool in wt bun diffnav delta codex; do \
      printf '#!/bin/sh\necho "%s stub"\nexit 0\n' "$tool" > "/usr/local/bin/$tool" && \
      chmod +x "/usr/local/bin/$tool"; \
    done
RUN git init -q /work && git -C /work config user.email t@t && git -C /work config user.name t
WORKDIR /work
ENV STATION_FAST_POPUP_NO_FALLBACK=1
# `setup check` exits 1 here only because no config is written yet; all deps pass.
CMD ["node", "/app/apps/cli/dist/main.js", "--config", "/work/station.toml", "setup", "check", "--json"]

# ---- no-git: git binary withheld ----------------------------------------------
FROM happy-linux AS no-git
RUN rm -f /usr/bin/git /usr/local/bin/git && (apt-get remove -y git >/dev/null 2>&1 || true)

# ---- no-tmux: tmux withheld ----------------------------------------------------
FROM happy-linux AS no-tmux
RUN rm -f /usr/bin/tmux && (apt-get remove -y tmux >/dev/null 2>&1 || true)

# ---- no-worktrunk: wt withheld -------------------------------------------------
FROM happy-linux AS no-worktrunk
RUN rm -f /usr/local/bin/wt

# ---- no-bun: Bun runtime withheld (bare stn cannot render the TUI) -------------
FROM happy-linux AS no-bun
RUN rm -f /usr/local/bin/bun

# ---- no-diffnav: diffnav + delta withheld --------------------------------------
FROM happy-linux AS no-diffnav
RUN rm -f /usr/local/bin/diffnav /usr/local/bin/delta

# ---- no-harness: agent CLI withheld --------------------------------------------
FROM happy-linux AS no-harness
RUN rm -f /usr/local/bin/codex
