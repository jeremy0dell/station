import { describe, expect, it } from "vitest";
import { tmuxPaneProofFormat } from "../../src/parse";
import { buildPlacedWorkspaceMutationArgs } from "../../src/placement/mutation";

const base = {
  create: "window" as const,
  sessionTarget: "$1",
  windowName: "web-feature",
  cwd: "/repo/feature",
  bindingToken: "placement_token",
  stationSessionId: "ses_feature",
  projectId: "web",
  worktreeId: "wt_feature",
  worktreePath: "/repo/feature",
  harness: "codex",
  proofFormat: tmuxPaneProofFormat,
  configureWorkbench: false,
};

describe("placed tmux workspace mutation", () => {
  it("orders creation, complete identity stamping, proof, and final rename", () => {
    const commands = splitCommands(buildPlacedWorkspaceMutationArgs(base));

    expect(commands.map((command) => command[0])).toEqual([
      "new-window",
      "set-option",
      "set-option",
      "set-option",
      "set-option",
      "set-option",
      "set-option",
      "set-option",
      "display-message",
      "rename-window",
    ]);
    expect(commands.slice(1, 8).map((command) => command.at(-2))).toEqual([
      "@station.open_token",
      "@station.session_id",
      "@station.project_id",
      "@station.worktree_id",
      "@station.worktree_path",
      "@station.role",
      "@station.harness",
    ]);
    expect(commands.at(-2)?.at(-1)).toBe(tmuxPaneProofFormat);
    expect(commands.at(-1)).toEqual(["rename-window", "-t", "$1:placement_token", "web-feature"]);
  });

  it("wraps the complete sibling mutation in one proof guard", () => {
    const args = buildPlacedWorkspaceMutationArgs({
      ...base,
      guard: {
        serverPid: 10,
        sessionId: "$1",
        windowId: "@1",
        paneId: "%1",
        panePid: 20,
        rejectionMarker: "REJECT",
      },
    });

    expect(args.slice(0, 4)).toEqual(["if-shell", "-F", "-t", "%1"]);
    const guardedMutation = args[5] ?? "";
    expect(guardedMutation.indexOf('"new-window"')).toBeLessThan(
      guardedMutation.indexOf('"@station.open_token"'),
    );
    expect(guardedMutation.indexOf('"@station.harness"')).toBeLessThan(
      guardedMutation.indexOf(`"${tmuxPaneProofFormat}"`),
    );
    expect(guardedMutation.indexOf(`"${tmuxPaneProofFormat}"`)).toBeLessThan(
      guardedMutation.indexOf('"rename-window"'),
    );
    expect(guardedMutation).not.toContain('"set-clipboard"');
  });
});

function splitCommands(args: readonly string[]): string[][] {
  const commands: string[][] = [[]];
  for (const arg of args) {
    if (arg === ";") {
      commands.push([]);
      continue;
    }
    commands.at(-1)?.push(arg);
  }
  return commands;
}
