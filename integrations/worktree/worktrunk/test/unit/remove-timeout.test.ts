import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderProjectConfig } from "@station/contracts";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { WorktrunkProvider } from "@station/worktrunk";
import { expect, it } from "vitest";

const project: ProviderProjectConfig = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaultBranch: "main",
  defaults: { harness: "codex", terminal: "tmux", layout: "agent-shell" },
  worktrunk: { enabled: true, base: "main" },
};

it.each([
  {
    title: "confirms removal when Worktrunk times out after deleting the checkout",
    deleteCheckout: true,
    succeeds: true,
  },
  {
    title: "preserves the timeout when the checkout remains after registration disappears",
    deleteCheckout: false,
    succeeds: false,
  },
])("$title", async ({ deleteCheckout, succeeds }) => {
  const root = await mkdtemp(join(tmpdir(), "station-wt-remove-timeout-"));
  const worktreePath = join(root, "feature");
  await mkdir(worktreePath);
  let listed = true;
  let listCalls = 0;
  let aborted = false;
  const provider = new WorktrunkProvider({
    command: "wt",
    timeoutMs: 5,
    resolveRegistrationIdentity: async (path) => `git-registration:${path}`,
    runner: async (input) => {
      if (input.command === "wt" && input.args?.includes("remove")) {
        listed = false;
        if (deleteCheckout) await rm(worktreePath, { recursive: true });
        return new Promise((_, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }),
              );
            },
            { once: true },
          );
        });
      }
      listCalls += 1;
      return result(
        input,
        JSON.stringify(listed ? [{ path: worktreePath, branch: "feature" }] : []),
      );
    },
  });

  try {
    const [selected] = await provider.listWorktrees(project);
    if (selected === undefined) throw new Error("Expected the worktree to be listed.");
    const removal = provider.removeWorktree({
      project,
      worktreeId: selected.id,
      expectedPath: selected.path,
      expectedBranch: selected.branch,
      expectedRegistrationIdentity: `git-registration:${selected.path}`,
    });

    if (succeeds) {
      await expect(removal).resolves.toEqual({ worktreeId: selected.id, removed: true });
    } else {
      await expect(removal).rejects.toMatchObject({ code: "WORKTRUNK_TIMEOUT" });
    }
    expect(aborted).toBe(true);
    expect(listCalls).toBe(succeeds ? 3 : 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
