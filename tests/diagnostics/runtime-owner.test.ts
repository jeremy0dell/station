import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOwnedDisposableRuntimeChild,
  DisposableRuntimeOwnerRecordSchema,
  RuntimeLifecycleEventSchema,
  runOwnedDisposableRuntime,
  runtimeOwnerRecordDirectory,
} from "../../scripts/runtime-owner.mjs";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-runtime-owner-"));
  await chmod(root, 0o700);
  temporaryRoots.push(root);
  return root;
}

function runtimeInput(root: string, steps = [{ command: process.execPath, args: ["-e", ""] }]) {
  return {
    role: "native-hmr" as const,
    checkoutRoot: process.cwd(),
    stateDir: root,
    socketRoots: [join(root, "run")],
    persistenceRoots: [root],
    survivorPolicy: "preserve-persistent-station-runtime" as const,
    terminalKey: "diagnostics-test-terminal",
    correlation: {
      traceId: "trc_runtime_owner_test",
      spanId: "spn_runtime_owner_test",
      uiRunId: "ui_11111111-1111-4111-8111-111111111111",
    },
    launch: {
      cwd: process.cwd(),
      steps,
    },
  };
}

async function lifecycleEvents(root: string) {
  const source = await readFile(join(root, "logs", "cli.jsonl"), "utf8");
  return source
    .trim()
    .split("\n")
    .map((line) => RuntimeLifecycleEventSchema.parse(JSON.parse(line) as unknown));
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("disposable runtime ownership", () => {
  it("corroborates an owned child against its active record and process group", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "corroborated");
    const childScript = join(root, "owned-child.mjs");
    await writeFile(
      childScript,
      [
        `import { writeFile } from "node:fs/promises";`,
        `import { assertOwnedDisposableRuntimeChild } from ${JSON.stringify(new URL("../../scripts/runtime-owner.mjs", import.meta.url).href)};`,
        `await assertOwnedDisposableRuntimeChild({ role: "native-hmr", stateDir: ${JSON.stringify(root)}, runtimeId: process.env.STATION_RUNTIME_OWNER_ID });`,
        `await writeFile(${JSON.stringify(marker)}, "yes");`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = await runOwnedDisposableRuntime(
      runtimeInput(root, [{ command: process.execPath, args: [childScript] }]),
    );

    expect(result.exitCode).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("yes");
    await expect(
      assertOwnedDisposableRuntimeChild({
        role: "native-hmr",
        stateDir: root,
        runtimeId: "run_11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_OWNER_CHILD_UNCORROBORATED" });
  });

  it("publishes lifecycle evidence and retires the exact record after normal exit", async () => {
    const root = await temporaryRoot();

    const result = await runOwnedDisposableRuntime(runtimeInput(root));

    expect(result).toMatchObject({ exitCode: 0 });
    expect(await readdir(runtimeOwnerRecordDirectory(root))).toEqual([]);
    const events = await lifecycleEvents(root);
    expect(events.map((event) => event.message)).toEqual([
      "runtime.owner.registered",
      "runtime.process.started",
      "runtime.shutdown.requested",
      "runtime.cleanup.started",
      "runtime.cleanup.completed",
      "runtime.owner.retired",
    ]);
    expect(events.every((event) => event.traceId === "trc_runtime_owner_test")).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("STATION_");
  });

  it("retires registration when the runtime command cannot start", async () => {
    const root = await temporaryRoot();

    const result = await runOwnedDisposableRuntime(
      runtimeInput(root, [{ command: join(root, "missing-command"), args: [] }]),
    );

    expect(result.exitCode).toBe(1);
    expect(await readdir(runtimeOwnerRecordDirectory(root))).toEqual([]);
    const events = await lifecycleEvents(root);
    expect(events.map((event) => event.message)).not.toContain("runtime.process.started");
    expect(events.map((event) => event.message)).toContain("runtime.cleanup.completed");
  });

  it("cleans the owned group even when lifecycle logging is unavailable", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "logs"), "not a directory", { mode: 0o600 });

    const result = await runOwnedDisposableRuntime(runtimeInput(root));

    expect(result.exitCode).toBe(0);
    expect(await readdir(runtimeOwnerRecordDirectory(root))).toEqual([]);
  });

  it("does not spawn work when the owner directory is insecure", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "spawned");
    const ownerDirectory = runtimeOwnerRecordDirectory(root);
    await mkdir(ownerDirectory, { recursive: true, mode: 0o755 });
    await chmod(ownerDirectory, 0o755);

    await expect(
      runOwnedDisposableRuntime(
        runtimeInput(root, [
          {
            command: process.execPath,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`],
          },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "RUNTIME_OWNER_DIRECTORY_INSECURE",
    });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a malformed owner record before spawning work", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "spawned");
    const ownerDirectory = runtimeOwnerRecordDirectory(root);
    await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(ownerDirectory, "run_11111111-1111-4111-8111-111111111111.json"),
      "{not-json}\n",
      { mode: 0o600 },
    );

    await expect(
      runOwnedDisposableRuntime(
        runtimeInput(root, [
          {
            command: process.execPath,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`],
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_OWNER_RECORD_MALFORMED" });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps record and event contracts strict", () => {
    expect(
      DisposableRuntimeOwnerRecordSchema.safeParse({ schemaVersion: 1, unexpected: true }).success,
    ).toBe(false);
    expect(
      RuntimeLifecycleEventSchema.safeParse({
        timestamp: new Date().toISOString(),
        level: "info",
        component: "cli",
        message: "runtime.owner.registered",
        traceId: "trc_test",
        spanId: "spn_test",
        attributes: {
          runtimeId: "run_11111111-1111-4111-8111-111111111111",
          role: "native-hmr",
          disposition: "disposable",
          runtimeKey: "a".repeat(64),
          checkoutKey: "b".repeat(64),
          socketRootsKey: "c".repeat(64),
          persistenceRootsKey: "d".repeat(64),
          survivorPolicy: "preserve-persistent-station-runtime",
          ownerPid: 1,
          ownerStartTime: "start",
          argv: ["private"],
        },
      }).success,
    ).toBe(false);
    expect(
      RuntimeLifecycleEventSchema.safeParse({
        timestamp: new Date().toISOString(),
        level: "info",
        component: "cli",
        message: "runtime.prune.applied",
        traceId: "trc_test",
        spanId: "spn_test",
        attributes: {
          runtimeId: "run_11111111-1111-4111-8111-111111111111",
          role: "binary-smoke",
          disposition: "disposable",
          runtimeKey: "a".repeat(64),
          checkoutKey: "b".repeat(64),
          socketRootsKey: "c".repeat(64),
          persistenceRootsKey: "d".repeat(64),
          survivorPolicy: "preserve-persistent-station-runtime",
          ownerPid: 1,
          ownerStartTime: "start",
          planDigest: "e".repeat(64),
          pruneAction: "terminate-and-retire",
        },
      }).success,
    ).toBe(true);
  });
});
