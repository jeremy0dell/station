import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildHarnessLaunchRequest } from "@station/contracts";
import type { Sandbox } from "e2b";
import { afterEach, expect, it, vi } from "vitest";
import { E2bExecutionProvider } from "../../src/provider.js";
import { ROOT } from "../../src/remote.js";
import { git } from "../../src/source.js";
import { ExecutionStore } from "../../src/state.js";

const roots: string[] = [];
const providers: E2bExecutionProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "station-e2b-test-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "source.txt"), "original\n");
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "source",
  ]);
  const patch = Buffer.from("cloud patch\n");
  let metadata: Record<string, string> = {};
  let present = false;
  let corrupt = false;
  const operations: string[] = [];
  const sandbox = {
    sandboxId: "sandbox-test",
    files: {
      write: vi.fn(async () => {}),
      read: vi.fn(
        async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(corrupt ? Buffer.from("wrong") : patch);
              controller.close();
            },
          }),
      ),
    },
    commands: {
      run: vi.fn(async (command: string) => {
        operations.push(command);
        let stdout = "";
        if (command.includes("cat") && command.includes("launch-result.json"))
          stdout = JSON.stringify({
            status: "succeeded",
            command: { status: "succeeded", result: { sessionId: "ses_remote" } },
          });
        if (command.includes("session list"))
          stdout = JSON.stringify({
            sessions: [
              {
                sessionId: "ses_remote",
                path: `${ROOT}/worktrees/agent`,
                harness: { provider: "scripted" },
              },
            ],
          });
        if (command.includes("sha256sum"))
          stdout = `${patch.length}\n${"a".repeat(40)}\n${createHash("sha256").update(patch).digest("hex")}  result.patch\n`;
        return { exitCode: 0, stdout, stderr: "" };
      }),
    },
  };
  const sdk = {
    create: vi.fn(async (_template: string, options: { metadata: Record<string, string> }) => {
      metadata = options.metadata;
      present = true;
      return sandbox;
    }),
    getInfo: vi.fn(async () => ({ sandboxId: sandbox.sandboxId, metadata, state: "running" })),
    connect: vi.fn(async () => sandbox),
    list: vi.fn(() => {
      let hasNext = true;
      return {
        get hasNext() {
          return hasNext;
        },
        nextItems: async () => {
          hasNext = false;
          return present ? [{ sandboxId: sandbox.sandboxId, metadata, state: "running" }] : [];
        },
      };
    }),
    kill: vi.fn(async () => {
      operations.push("kill");
      present = false;
      return true;
    }),
  };
  const options = {
    stateDir: join(root, "state"),
    bridgeDirectory: join(root, "bridge"),
    bridgeCommand: ["stn"] as const,
    template: "base",
    apiKeyEnv: "COMPUTE_KEY",
    timeoutMinutes: 5,
    maxSandboxes: 1,
    harnessEnv: {},
    environment: { COMPUTE_KEY: "compute-secret" },
    sdk: sdk as unknown as typeof Sandbox,
  };
  const provider = new E2bExecutionProvider(options);
  providers.push(provider);
  const request: BuildHarnessLaunchRequest & { sessionId: string; harness: string } = {
    sessionId: "ses_test",
    harness: "scripted",
    project: {
      id: "test",
      label: "Test",
      root,
      defaults: {
        worktreeProvider: "worktrunk",
        terminal: "tmux",
        harness: "scripted",
        layout: "agent-only",
      },
    },
    worktree: {
      id: "wt_test",
      provider: "worktrunk",
      projectId: "test",
      path: root,
      branch: "main",
      isMain: false,
      isDirty: false,
      observedAt: new Date().toISOString(),
    },
  };
  const store = new ExecutionStore(join(root, "state/executions/e2b"));
  return {
    root,
    sdk,
    sandbox,
    provider,
    options,
    request,
    store,
    operations,
    patch,
    corrupt: () => {
      corrupt = true;
    },
  };
}
it("launches once, reconnects after Observer restart, and saves verified results before destruction", async () => {
  const f = await fixture();
  const plan = await f.provider.launch(f.request);
  expect(JSON.stringify(plan)).not.toContain("compute-secret");
  expect(plan.command).toBe("/usr/bin/env");
  expect(plan.args).toEqual([
    "-u",
    "COMPUTE_KEY",
    "stn",
    "execution",
    "attach",
    expect.any(String),
    "ses_test",
  ]);
  const before = await f.store.read("ses_test");
  const recovered = new E2bExecutionProvider(f.options);
  providers.push(recovered);
  await recovered.attach("ses_test");
  expect(f.sdk.create).toHaveBeenCalledTimes(1);
  expect((await f.store.read("ses_test")).remoteSessionId).toBe(before.remoteSessionId);
  await recovered.destroy("ses_test");
  const record = await f.store.read("ses_test");
  expect(record.phase).toBe("destroyed");
  expect(record.resultDirectory).toBeDefined();
  expect(await readFile(join(record.resultDirectory ?? "", "changes.patch"))).toEqual(f.patch);
  expect(await readFile(join(f.root, "source.txt"), "utf8")).toBe("original\n");
  expect(f.operations.at(-1)).toBe("kill");
  expect(f.sdk.list).toHaveBeenCalledTimes(3);
});
it("retains a lost create attempt across restart and refuses an automatic replacement", async () => {
  const f = await fixture();
  f.sdk.create.mockRejectedValueOnce(new Error("Response lost"));
  await expect(f.provider.launch(f.request)).rejects.toMatchObject({
    code: "TERMINAL_CLEANUP_UNCERTAIN",
  });
  const recovered = new E2bExecutionProvider(f.options);
  providers.push(recovered);
  await expect(recovered.launch(f.request)).rejects.toMatchObject({ code: "EXECUTION_CAPACITY" });
  await expect(recovered.destroy("ses_test")).rejects.toMatchObject({
    code: "EXECUTION_CREATE_UNCERTAIN",
  });
  expect(f.sdk.create).toHaveBeenCalledTimes(1);
  expect(f.sdk.kill).not.toHaveBeenCalled();
  expect((await f.store.read("ses_test")).phase).toBe("creating");
});
it("retains compute and the stopped identity when result verification fails", async () => {
  const f = await fixture();
  await f.provider.launch(f.request);
  f.corrupt();
  await expect(f.provider.destroy("ses_test")).rejects.toMatchObject({
    code: "EXECUTION_RESULT_INVALID",
  });
  expect(f.sdk.kill).not.toHaveBeenCalled();
  expect((await f.store.read("ses_test")).phase).toBe("stopped");
});
it("reports unavailable without treating transport failure as exit or resuming paused compute", async () => {
  const f = await fixture();
  await f.provider.launch(f.request);
  f.sdk.getInfo.mockRejectedValueOnce(new Error("Offline"));
  expect(await f.provider.observe("ses_test")).toMatchObject({
    execution: { state: "unavailable" },
    status: { value: "unknown" },
  });
  expect(f.sdk.connect).not.toHaveBeenCalled();
  expect(f.sdk.kill).not.toHaveBeenCalled();
});

it("requires explicit abandonment to destroy compute after failed collection", async () => {
  const f = await fixture();
  await f.provider.launch(f.request);
  f.corrupt();
  await expect(f.provider.destroy("ses_test")).rejects.toMatchObject({
    code: "EXECUTION_RESULT_INVALID",
  });
  expect(f.sdk.kill).not.toHaveBeenCalled();
  await f.provider.destroy("ses_test", { discardResults: true });
  expect(f.sdk.kill).toHaveBeenCalledTimes(1);
  expect((await f.store.read("ses_test")).phase).toBe("destroyed");
});

it("does not attach to a retained remote seed when launch completion is missing", async () => {
  const f = await fixture();
  f.sandbox.commands.run.mockRejectedValueOnce(new Error("Bootstrap interrupted"));
  await expect(f.provider.launch(f.request)).rejects.toMatchObject({
    code: "TERMINAL_CLEANUP_UNCERTAIN",
  });
  const record = await f.store.read("ses_test");
  record.phase = "launching";
  await f.store.write(record);
  f.sandbox.commands.run.mockResolvedValueOnce({
    exitCode: 0,
    stdout: JSON.stringify({ status: "failed", command: { status: "failed" } }),
    stderr: "",
  });
  await expect(f.provider.attach("ses_test")).rejects.toBeDefined();
  expect(f.sdk.create).toHaveBeenCalledTimes(1);
  expect((await f.store.read("ses_test")).remoteSessionId).toBeUndefined();
});
