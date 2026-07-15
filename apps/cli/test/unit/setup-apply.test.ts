import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { applySetupPlan, type SetupApplyFileSystem } from "../../src/commands/setup/apply.js";
import type { SetupPlan } from "../../src/commands/setup/model.js";

describe("setup apply engine", () => {
  it("records exact Brew install commands", async () => {
    const calls: ExternalCommandInput[] = [];
    const result = await applySetupPlan(plan([brewAction("install-worktrunk", "worktrunk")]), {
      runner: fakeRunner(calls),
    });

    expect(result.failedAction).toBeUndefined();
    expect(calls).toEqual([
      expect.objectContaining({
        command: "brew",
        args: ["install", "worktrunk"],
      }),
    ]);
    expect(result.plan.actions[0]).toMatchObject({ status: "completed" });
  });

  it("announces command actions and can request visible command output", async () => {
    const calls: ExternalCommandInput[] = [];
    const events: string[] = [];

    const result = await applySetupPlan(plan([brewAction("install-worktrunk", "worktrunk")]), {
      runner: fakeRunner(calls),
      showCommandOutput: true,
      onActionStart: (action) => events.push(`start:${action.id}`),
      onActionComplete: (action) => events.push(`complete:${action.id}`),
      onActionFailed: (action) => events.push(`failed:${action.id}`),
    });

    expect(result.failedAction).toBeUndefined();
    expect(calls[0]).toMatchObject({ command: "brew", stdio: "inherit" });
    expect(events).toEqual(["start:install-worktrunk", "complete:install-worktrunk"]);
  });

  it("dry-run records zero writes and zero external commands", async () => {
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs();

    const result = await applySetupPlan(
      plan([
        brewAction("install-tmux", "tmux"),
        {
          id: "write-config",
          kind: "write-config",
          tier: "required",
          selected: true,
          label: "Write config",
          message: "Write config",
          path: "/tmp/config.toml",
          data: { operation: "create", content: "schema_version = 1\n" },
        },
      ]),
      { runner: fakeRunner(calls), fs, dryRun: true },
    );

    expect(calls).toHaveLength(0);
    expect(fs.writes).toEqual({});
    expect(result.plan.actions.map((action) => action.status)).toEqual(["skipped", "skipped"]);
  });

  it("stops after a failed required install and skips later writes", async () => {
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs();

    const result = await applySetupPlan(
      plan([
        brewAction("install-worktrunk", "worktrunk"),
        {
          id: "write-config",
          kind: "write-config",
          tier: "required",
          selected: true,
          label: "Write config",
          message: "Write config",
          path: "/tmp/config.toml",
          data: { operation: "create", content: "schema_version = 1\n" },
        },
      ]),
      {
        runner: async (input) => {
          calls.push(input);
          throw new Error("install failed");
        },
        fs,
      },
    );

    expect(result.failedAction).toMatchObject({ id: "install-worktrunk", status: "failed" });
    expect(fs.writes).toEqual({});
    expect(result.plan.actions.map((action) => action.status)).toEqual(["failed", "skipped"]);
  });

  it("writes config atomically with a backup for existing targets", async () => {
    const fs = fakeFs({ "/tmp/config.toml": "old = true\n" });

    const result = await applySetupPlan(
      plan([
        {
          id: "write-config",
          kind: "write-config",
          tier: "required",
          selected: true,
          label: "Write config",
          message: "Write config",
          path: "/tmp/config.toml",
          data: { operation: "create", content: "schema_version = 1\n" },
        },
      ]),
      {
        fs,
        now: () => new Date("2026-06-08T12:00:00.000Z"),
      },
    );

    expect(result.failedAction).toBeUndefined();
    expect(fs.writes["/tmp/config.toml"]).toBe("schema_version = 1\n");
    expect(fs.writes["/tmp/config.toml.2026-06-08T12-00-00-000Z.bak"]).toBe("old = true\n");
  });

  it("appends marked files atomically and skips an existing marker", async () => {
    const fs = fakeFs({ "/tmp/home/.tmux.conf": "set -g mouse on\n" });

    const result = await applySetupPlan(
      plan([
        {
          id: "tmux-popup-binding",
          kind: "append-file",
          tier: "recommended",
          selected: true,
          label: "Install tmux popup binding",
          message: "Install tmux popup binding",
          path: "/tmp/home/.tmux.conf",
          data: {
            marker: "# >>> station popup binding >>>",
            endMarker: "# <<< station popup binding <<<",
            appendedText:
              "# >>> station popup binding >>>\n# Change Space to any tmux key; stn setup preserves it.\nbind-key Space run-shell -b 'stn-tmux-popup'\n# <<< station popup binding <<<\n",
          },
        },
      ]),
      {
        fs,
        now: () => new Date("2026-06-08T12:00:00.000Z"),
      },
    );

    expect(result.failedAction).toBeUndefined();
    expect(fs.writes["/tmp/home/.tmux.conf"]).toContain("set -g mouse on");
    expect(fs.writes["/tmp/home/.tmux.conf"]).toContain("stn-tmux-popup");
    expect(fs.writes["/tmp/home/.tmux.conf.2026-06-08T12-00-00-000Z.bak"]).toBe(
      "set -g mouse on\n",
    );

    const idempotent = await applySetupPlan(result.plan, { fs });

    expect(idempotent.failedAction).toBeUndefined();
    expect(fs.writes["/tmp/home/.tmux.conf"]?.match(/stn-tmux-popup/g)).toHaveLength(1);
  });

  it("replaces stale marked blocks when a new end marker and block are supplied", async () => {
    const fs = fakeFs({
      "/tmp/home/.tmux.conf": [
        "set -g mouse on",
        "",
        "# >>> station popup binding >>>",
        "# Change Space to any tmux key; stn setup preserves it.",
        "bind-key C-s run-shell -b 'old-command'",
        "# <<< station popup binding <<<",
        "",
        "set -g status on",
        "",
      ].join("\n"),
    });

    const result = await applySetupPlan(
      plan([
        {
          id: "tmux-popup-binding",
          kind: "append-file",
          tier: "recommended",
          selected: true,
          label: "Install tmux popup binding",
          message: "Install tmux popup binding",
          path: "/tmp/home/.tmux.conf",
          data: {
            marker: "# >>> station popup binding >>>",
            endMarker: "# <<< station popup binding <<<",
            appendedText:
              "# >>> station popup binding >>>\n# Change Space to any tmux key; stn setup preserves it.\nbind-key C-s run-shell -b 'managed-fast-command'\n# <<< station popup binding <<<\n",
          },
        },
      ]),
      {
        fs,
        now: () => new Date("2026-06-08T12:00:00.000Z"),
      },
    );

    expect(result.failedAction).toBeUndefined();
    expect(fs.writes["/tmp/home/.tmux.conf"]).toContain("set -g mouse on");
    expect(fs.writes["/tmp/home/.tmux.conf"]).toContain("set -g status on");
    expect(fs.writes["/tmp/home/.tmux.conf"]).toContain(
      "bind-key C-s run-shell -b 'managed-fast-command'",
    );
    expect(fs.writes["/tmp/home/.tmux.conf"]).not.toContain("'old-command'");
  });
});

function plan(actions: SetupPlan["actions"]): SetupPlan {
  return {
    generatedAt: "2026-06-08T12:00:00.000Z",
    mode: "apply",
    checks: [],
    actions,
    summary: {
      launchReady: true,
      workflowReady: true,
      requiredOk: true,
      requiredMissing: 0,
      warnings: 0,
      selectedActions: actions.filter((action) => action.selected).length,
      configPath: "/tmp/config.toml",
    },
    nextSteps: [],
  };
}

function brewAction(id: string, formula: string): SetupPlan["actions"][number] {
  return {
    id,
    kind: "brew-install",
    tier: "required",
    selected: true,
    label: `Install ${formula}`,
    message: `Install ${formula}`,
    command: ["brew", "install", formula],
    data: { formula },
  };
}

function fakeRunner(calls: ExternalCommandInput[]) {
  return async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
    calls.push(input);
    return {
      command: input.command,
      args: input.args ?? [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
  };
}

function fakeFs(initial: Record<string, string> = {}): SetupApplyFileSystem & {
  writes: Record<string, string>;
} {
  const writes = { ...initial };
  return {
    writes,
    async mkdir() {
      return undefined;
    },
    async readFile(path) {
      const content = writes[path];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return content;
    },
    async writeFile(path, content) {
      writes[path] = content;
    },
    async rename(from, to) {
      const content = writes[from];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      writes[to] = content;
      delete writes[from];
    },
    async access(path) {
      if (writes[path] === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
    },
  };
}
