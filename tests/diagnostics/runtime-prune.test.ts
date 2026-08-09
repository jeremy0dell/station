import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRuntimePrune,
  buildRuntimePrunePlan,
  classifyRuntimePruneProtection,
  formatRuntimePrunePlan,
  parseRuntimePruneArgs,
} from "../../scripts/maintenance/runtime-prune.mjs";
import { RuntimeLifecycleEventSchema } from "../../scripts/runtime-owner.mjs";

const fixturePath = new URL("./fixtures/runtime-prune/owner.fixture.mjs", import.meta.url);
const pruneScriptPath = new URL("../../scripts/maintenance/runtime-prune.mjs", import.meta.url);
const temporaryRoots: string[] = [];
const processGroups = new Set<number>();

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await chmod(root, 0o700);
  temporaryRoots.push(root);
  return root;
}

async function startRuntime(mode: "normal" | "term-resistant" = "normal") {
  const stateDir = await temporaryRoot("station-runtime-prune-state-");
  const cleanupRoot = await temporaryRoot("station-runtime-prune-owned-");
  const owner = spawn(process.execPath, [fixturePath.pathname, stateDir, cleanupRoot, mode], {
    stdio: "ignore",
  });
  const recordDirectory = join(stateDir, "run", "runtime-owners", "v1");
  const record = await waitForRecord(recordDirectory);
  await waitForLifecycleMessage(stateDir, "runtime.process.started");
  processGroups.add(record.processGroup.pgid);
  return { stateDir, cleanupRoot, owner, record, recordDirectory };
}

async function abandonRuntime(runtime: Awaited<ReturnType<typeof startRuntime>>) {
  runtime.owner.kill("SIGKILL");
  await new Promise<void>((resolvePromise) => runtime.owner.once("exit", () => resolvePromise()));
}

async function waitForRecord(directory: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const name = (await readdir(directory)).find((entry) => entry.endsWith(".json"));
      if (name !== undefined) {
        const record = JSON.parse(await readFile(join(directory, name), "utf8")) as {
          generation: number;
          runtimeId: string;
          updatedAt: string;
          owner: { processToken: string };
          processGroup: { pgid: number };
        };
        if (record.processGroup !== undefined) return record;
      }
    } catch {
      // Registration is atomic; retry until the process-bearing record appears.
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime prune fixture.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

async function readLifecycle(stateDir: string) {
  return (await readFile(join(stateDir, "logs", "cli.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => RuntimeLifecycleEventSchema.parse(JSON.parse(line) as unknown));
}

async function waitForLifecycleMessage(stateDir: string, message: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      if ((await readLifecycle(stateDir)).some((event) => event.message === message)) return;
    } catch {
      // The lifecycle file appears atomically after the first emitted event.
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

afterEach(async () => {
  for (const pgid of processGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // The verified prune path already removed this fixture group.
    }
  }
  processGroups.clear();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runtime prune", () => {
  it("parses only a single digest-bound runtime apply", () => {
    const digest = "a".repeat(64);
    expect(
      parseRuntimePruneArgs([
        "--runtime",
        "run_11111111-1111-4111-8111-111111111111",
        "--yes",
        "--expect-plan",
        digest,
        "--json",
      ]),
    ).toMatchObject({ command: "apply", expectPlan: digest, json: true });
    expect(() => parseRuntimePruneArgs([])).toThrow("--runtime requires");
    expect(() =>
      parseRuntimePruneArgs([
        "--runtime",
        "run_11111111-1111-4111-8111-111111111111",
        "--runtime",
        "run_22222222-2222-4222-8222-222222222222",
      ]),
    ).toThrow("only once");
    expect(() =>
      parseRuntimePruneArgs(["--runtime", "run_11111111-1111-4111-8111-111111111111", "--yes"]),
    ).toThrow("must be supplied together");
    expect(() =>
      parseRuntimePruneArgs([
        "--runtime",
        "run_11111111-1111-4111-8111-111111111111",
        "--expect-plan",
        digest,
      ]),
    ).toThrow("must be supplied together");
  });

  it("produces a stable redacted plan and removes one exact abandoned runtime", async () => {
    const runtime = await startRuntime("term-resistant");
    await abandonRuntime(runtime);

    const first = await buildRuntimePrunePlan({
      stateDir: runtime.stateDir,
      runtimeId: runtime.record.runtimeId,
    });
    const second = await buildRuntimePrunePlan({
      stateDir: runtime.stateDir,
      runtimeId: runtime.record.runtimeId,
    });
    expect(first).toMatchObject({
      eligible: true,
      action: "terminate-and-retire",
      runtimeId: runtime.record.runtimeId,
    });
    expect(second).toEqual(first);
    const rendered = JSON.stringify(first);
    expect(rendered).not.toContain(runtime.stateDir);
    expect(rendered).not.toContain(runtime.cleanupRoot);
    expect(rendered).not.toContain(runtime.record.owner.processToken);
    expect(formatRuntimePrunePlan(first)).toContain("read-only");
    if (!first.eligible) return;

    const result = await applyRuntimePrune({
      stateDir: runtime.stateDir,
      runtimeId: runtime.record.runtimeId,
      expectPlan: first.planDigest,
    });
    expect(result).toMatchObject({ applied: true, action: "terminate-and-retire", exitCode: 0 });
    expect(await readdir(runtime.recordDirectory)).toEqual([]);
    await expect(readFile(runtime.cleanupRoot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => process.kill(-runtime.record.processGroup.pgid, 0)).toThrow();
    processGroups.delete(runtime.record.processGroup.pgid);

    const events = await readLifecycle(runtime.stateDir);
    expect(events.map((event) => event.message)).toEqual(
      expect.arrayContaining([
        "runtime.shutdown.requested",
        "runtime.cleanup.started",
        "runtime.cleanup.escalated",
        "runtime.cleanup.completed",
        "runtime.owner.retired",
        "runtime.prune.applied",
      ]),
    );
    expect(events.at(-1)?.attributes.planDigest).toBe(first.planDigest);
    await expect(
      applyRuntimePrune({
        stateDir: runtime.stateDir,
        runtimeId: runtime.record.runtimeId,
        expectPlan: first.planDigest,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_PRUNE_NOT_ELIGIBLE" });
  }, 15_000);

  it("invalidates a stale plan without signaling the surviving group", async () => {
    const runtime = await startRuntime("term-resistant");
    await abandonRuntime(runtime);
    const plan = await buildRuntimePrunePlan({
      stateDir: runtime.stateDir,
      runtimeId: runtime.record.runtimeId,
    });
    if (!plan.eligible) throw new Error(`Fixture plan refused: ${plan.refusalCodes.join(", ")}`);
    const recordPath = join(runtime.recordDirectory, `${runtime.record.runtimeId}.json`);
    const changed = {
      ...JSON.parse(await readFile(recordPath, "utf8")),
      generation: runtime.record.generation + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(recordPath, `${JSON.stringify(changed)}\n`, { mode: 0o600 });

    await expect(
      applyRuntimePrune({
        stateDir: runtime.stateDir,
        runtimeId: runtime.record.runtimeId,
        expectPlan: plan.planDigest,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_PRUNE_PLAN_CHANGED" });
    expect(await readFile(recordPath, "utf8")).toContain(runtime.record.runtimeId);
    expect(await readdir(runtime.cleanupRoot)).toEqual([]);
    expect((await readLifecycle(runtime.stateDir)).map((event) => event.message)).not.toContain(
      "runtime.shutdown.requested",
    );
  });

  it("refuses an active owner and a replaced cleanup root", async () => {
    const runtime = await startRuntime("term-resistant");
    const active = await buildRuntimePrunePlan({
      stateDir: runtime.stateDir,
      runtimeId: runtime.record.runtimeId,
    });
    expect(active).toMatchObject({
      eligible: false,
      refusalCodes: expect.arrayContaining(["RUNTIME_PRUNE_OWNER_ACTIVE"]),
    });
    await abandonRuntime(runtime);
    const plan = await buildRuntimePrunePlan({
      stateDir: runtime.stateDir,
      runtimeId: runtime.record.runtimeId,
    });
    if (!plan.eligible) throw new Error(`Fixture plan refused: ${plan.refusalCodes.join(", ")}`);
    const original = `${runtime.cleanupRoot}-original`;
    temporaryRoots.push(original);
    await rename(runtime.cleanupRoot, original);
    await mkdir(runtime.cleanupRoot, { mode: 0o700 });

    await expect(
      applyRuntimePrune({
        stateDir: runtime.stateDir,
        runtimeId: runtime.record.runtimeId,
        expectPlan: plan.planDigest,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_PRUNE_NOT_ELIGIBLE" });
    expect(() => process.kill(-runtime.record.processGroup.pgid, 0)).not.toThrow();
    expect(await readdir(runtime.cleanupRoot)).toEqual([]);
  });

  it("returns the operator signal and retains evidence when interrupted during cleanup", async () => {
    const runtime = await startRuntime("term-resistant");
    await abandonRuntime(runtime);
    const plan = await buildRuntimePrunePlan({
      stateDir: runtime.stateDir,
      runtimeId: runtime.record.runtimeId,
    });
    if (!plan.eligible) throw new Error(`Fixture plan refused: ${plan.refusalCodes.join(", ")}`);
    const apply = spawn(
      process.execPath,
      [
        pruneScriptPath.pathname,
        "--state-dir",
        runtime.stateDir,
        "--runtime",
        runtime.record.runtimeId,
        "--yes",
        "--expect-plan",
        plan.planDigest,
      ],
      { stdio: "ignore" },
    );
    await waitForLifecycleMessage(runtime.stateDir, "runtime.cleanup.started");
    const exited = new Promise<number | null>((resolvePromise) =>
      apply.once("exit", (code) => resolvePromise(code)),
    );
    apply.kill("SIGINT");
    const exitCode = await exited;

    expect(exitCode).toBe(130);
    expect(() => process.kill(-runtime.record.processGroup.pgid, 0)).not.toThrow();
    expect(await readdir(runtime.cleanupRoot)).toEqual([]);
    expect(await readdir(runtime.recordDirectory)).toEqual(
      expect.arrayContaining([`${runtime.record.runtimeId}.json`]),
    );
    expect((await readLifecycle(runtime.stateDir)).map((event) => event.message)).toContain(
      "runtime.cleanup.refused",
    );
  }, 15_000);

  it("protects Host and PTY identities outside the disposable boundary", () => {
    const record = { role: "native-hmr" };
    const hostEvidence = {
      hosts: [
        {
          state: "available",
          socketPath: "/tmp/runtime/station-host.sock",
          holder: { state: "available", pid: 10, pgid: 10, osStartTime: "host" },
          livePtys: [{ state: "available", pid: 11, pgid: 11, osStartTime: "pty" }],
        },
      ],
    };
    expect(
      classifyRuntimePruneProtection({
        record,
        groupMembers: [10],
        cleanupRoots: [],
        hostEvidence,
      }).refusalCodes,
    ).toContain("RUNTIME_PRUNE_PERSISTENT_RUNTIME_OVERLAP");
    expect(
      classifyRuntimePruneProtection({
        record: { role: "binary-smoke" },
        groupMembers: [10, 11],
        cleanupRoots: [{ state: "exact", path: "/tmp/runtime" }],
        hostEvidence,
      }).refusalCodes,
    ).toEqual([]);
    expect(
      classifyRuntimePruneProtection({
        record: { role: "binary-smoke" },
        groupMembers: [10],
        cleanupRoots: [{ state: "exact", path: "/tmp/runtime" }],
        hostEvidence,
      }).refusalCodes,
    ).toContain("RUNTIME_PRUNE_CLEANUP_ROOT_IN_USE");
  });
});
