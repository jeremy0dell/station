// Declarative machine-state profiles for STATION's `stn setup` flow. A profile
// describes which tools a machine has (or lacks) plus the expected outcome of
// `stn setup check`. The same profile contract is realised at three fidelities:
//   1. in-process (apps/cli/test/integration/setup-profiles.test.ts) — every PR;
//   2. Linux containers (tests/env/docker) — real exit codes/filesystem;
//   3. macOS Tart VMs (tests/env/macos) — real brew + Command Line Tools.
// Tiers 2/3 assert the same `expect` as tier 1; only brew/CLT profiles need a VM.

export type ToolPresence = "present" | "absent";

export type SetupCheckStatus = "ok" | "missing" | "warning" | "skipped";

export type MachineProfileState = {
  platform: "darwin" | "linux";
  // Command Line Tools; only meaningful on darwin.
  xcodeClt: ToolPresence;
  git: ToolPresence;
  // Whether the working directory is inside a git repository (git rev-parse).
  insideRepo: boolean;
  brew: ToolPresence;
  worktrunk: ToolPresence;
  tmux: ToolPresence;
  // Bun runtime; bare `stn` renders the TUI through `bun run`, so it is required.
  bun: ToolPresence;
  diffnav: ToolPresence;
  gitDelta: ToolPresence;
  // Detected agent CLIs, e.g. ["codex"]. Empty means no supported harness.
  harnesses: string[];
  // Optional valid STATION config TOML; when present a happy machine can reach
  // requiredOk: true. {{REPO}} is replaced with the temp repo path by the adapter.
  configToml?: string;
};

export type MachineProfileExpect = {
  // `stn setup check` exits 0 when requiredOk, else 1.
  exitCode: 0 | 1;
  requiredOk: boolean;
  // Subset of check ids to assert; not every check id need be listed.
  checks: Record<string, SetupCheckStatus>;
};

export type MachineProfile = {
  name: string;
  description: string;
  state: MachineProfileState;
  expect: MachineProfileExpect;
};

const linuxAllTools: MachineProfileState = {
  platform: "linux",
  xcodeClt: "present",
  git: "present",
  insideRepo: true,
  brew: "present",
  worktrunk: "present",
  tmux: "present",
  bun: "present",
  diffnav: "present",
  gitDelta: "present",
  harnesses: ["codex"],
};

// A valid first-project config; {{REPO}} is replaced with the temp repo path.
const readyConfigToml = [
  "schema_version = 1",
  "",
  "[observer]",
  'socket_path = "~/.local/state/station/observer.sock"',
  'state_dir = "~/.local/state/station"',
  "",
  "[defaults]",
  'worktree_provider = "worktrunk"',
  'terminal = "tmux"',
  'harness = "codex"',
  'layout = "agent-shell"',
  "",
  "[[projects]]",
  'id = "repo"',
  'label = "repo"',
  'root = "{{REPO}}"',
  "",
].join("\n");

export const machineProfiles: readonly MachineProfile[] = [
  {
    name: "ready",
    description: "Every dependency present and a valid first-project config; setup is complete.",
    state: { ...linuxAllTools, configToml: readyConfigToml },
    expect: {
      exitCode: 0,
      requiredOk: true,
      checks: {
        worktrunk: "ok",
        tmux: "ok",
        bun: "ok",
        "git-project": "ok",
        harness: "ok",
        diffnav: "ok",
        "git-delta": "ok",
        config: "ok",
      },
    },
  },
  {
    name: "all-tools-present",
    description:
      "Every required dependency present but no STATION config or socket evidence tool yet.",
    state: { ...linuxAllTools },
    expect: {
      exitCode: 1,
      requiredOk: false,
      checks: {
        worktrunk: "ok",
        tmux: "ok",
        bun: "ok",
        "git-project": "ok",
        harness: "ok",
        diffnav: "ok",
        "git-delta": "ok",
        config: "missing",
        "observer-socket-evidence": "warning",
      },
    },
  },
  {
    name: "no-git",
    description: "git binary absent (the bare-machine case); git-project fails.",
    state: { ...linuxAllTools, git: "absent", insideRepo: false },
    expect: {
      exitCode: 1,
      requiredOk: false,
      checks: { "git-project": "missing", worktrunk: "ok", tmux: "ok" },
    },
  },
  {
    name: "no-tmux",
    description: "tmux missing; the reference terminal workflow is unavailable.",
    state: { ...linuxAllTools, tmux: "absent" },
    expect: {
      exitCode: 1,
      requiredOk: false,
      checks: { tmux: "missing", worktrunk: "ok" },
    },
  },
  {
    name: "no-worktrunk",
    description: "Worktrunk missing; core worktree setup is unavailable.",
    state: { ...linuxAllTools, worktrunk: "absent" },
    expect: {
      exitCode: 1,
      requiredOk: false,
      checks: { worktrunk: "missing", tmux: "ok" },
    },
  },
  {
    name: "no-diffnav",
    description: "diffnav + delta missing; now a required-tier failure (See diff automation).",
    state: { ...linuxAllTools, diffnav: "absent", gitDelta: "absent" },
    expect: {
      exitCode: 1,
      requiredOk: false,
      checks: { diffnav: "missing", "git-delta": "missing", worktrunk: "ok", tmux: "ok" },
    },
  },
  {
    name: "no-bun",
    description: "Bun runtime missing; bare stn cannot render the TUI until it is installed.",
    state: { ...linuxAllTools, bun: "absent" },
    expect: {
      exitCode: 1,
      requiredOk: false,
      checks: { bun: "missing", worktrunk: "ok", tmux: "ok" },
    },
  },
  {
    name: "no-harness",
    description: "No supported agent CLI installed.",
    state: { ...linuxAllTools, harnesses: [] },
    expect: {
      exitCode: 1,
      requiredOk: false,
      checks: { harness: "missing", worktrunk: "ok" },
    },
  },
  {
    name: "no-brew",
    description: "Homebrew and the brew-installed tools absent; manual-install path.",
    state: {
      ...linuxAllTools,
      brew: "absent",
      worktrunk: "absent",
      tmux: "absent",
      bun: "absent",
      diffnav: "absent",
      gitDelta: "absent",
    },
    expect: {
      exitCode: 1,
      requiredOk: false,
      checks: {
        worktrunk: "missing",
        tmux: "missing",
        bun: "missing",
        diffnav: "missing",
        "git-delta": "missing",
      },
    },
  },
  {
    name: "no-xcode-clt",
    description: "macOS host missing the Command Line Tools (the nightmare machine).",
    state: {
      platform: "darwin",
      xcodeClt: "absent",
      git: "absent",
      insideRepo: false,
      brew: "absent",
      worktrunk: "absent",
      tmux: "absent",
      bun: "absent",
      diffnav: "absent",
      gitDelta: "absent",
      harnesses: [],
    },
    expect: {
      exitCode: 1,
      requiredOk: false,
      checks: { "command-line-tools": "missing" },
    },
  },
];
