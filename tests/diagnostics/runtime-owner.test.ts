import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
import {
  cliUxPilotOwnerStateDirectory,
  cliUxPilotRuntimeRootPrefix,
  finalizeCliUxPilotRoots,
} from "../../scripts/test-runners/run-cli-ux-pilot.mjs";

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
  it("owns the CLI UX pilot as a first-class disposable runtime role", async () => {
    const root = await temporaryRoot();

    const result = await runOwnedDisposableRuntime({
      ...runtimeInput(root),
      role: "cli-ux-pilot",
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(
      (await lifecycleEvents(root)).every((event) => event.attributes.role === "cli-ux-pilot"),
    ).toBe(true);
  });

  it("recovers a killed pilot launcher and removes its exact process, tmux, and root residue", async () => {
    const fixtureRoot = await temporaryRoot();
    const checkout = join(fixtureRoot, "checkout");
    await mkdir(checkout, { mode: 0o700 });
    const ownerStateDir = await cliUxPilotOwnerStateDirectory(checkout, fixtureRoot);
    const firstIsolatedRoot = await pilotRoot();
    const firstRuntimeRoot = await pilotRoot(cliUxPilotRuntimeRootPrefix);
    const firstTmuxRoot = join(firstRuntimeRoot.path, "stn-real-tmux-orphan");
    const firstSocket = join(firstTmuxRoot, "server.sock");
    const childPidPath = join(fixtureRoot, "child.pid");
    const childScript = join(fixtureRoot, "child.mjs");
    const ownerScript = join(fixtureRoot, "owner.mjs");
    await mkdir(firstTmuxRoot, { recursive: true, mode: 0o700 });
    await writeFile(firstSocket, "orphan\n", { mode: 0o600 });
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
      { mode: 0o600 },
    );
    await writeFile(
      ownerScript,
      [
        `import { runOwnedDisposableRuntime } from ${JSON.stringify(new URL("../../scripts/runtime-owner.mjs", import.meta.url).href)};`,
        `await runOwnedDisposableRuntime(${JSON.stringify(pilotRuntimeInput({ checkout, ownerStateDir, isolatedRoot: firstIsolatedRoot, runtimeRoot: firstRuntimeRoot, steps: [{ command: process.execPath, args: [childScript] }] }))});`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const firstOwner = spawn(process.execPath, [ownerScript], { stdio: "ignore" });
    let childPid: number | undefined;
    let secondIsolatedRoot: Awaited<ReturnType<typeof pilotRoot>> | undefined;
    let secondRuntimeRoot: Awaited<ReturnType<typeof pilotRoot>> | undefined;
    let legacyRoot: Awaited<ReturnType<typeof pilotRoot>> | undefined;
    try {
      childPid = Number(await waitForFile(childPidPath));
      await waitForOwnerRecord(ownerStateDir);
      firstOwner.kill("SIGKILL");
      await waitForChildExit(firstOwner);
      expect(firstOwner.signalCode).toBe("SIGKILL");

      secondIsolatedRoot = await pilotRoot();
      secondRuntimeRoot = await pilotRoot(cliUxPilotRuntimeRootPrefix);
      const result = await runOwnedDisposableRuntime(
        pilotRuntimeInput({
          checkout,
          ownerStateDir,
          isolatedRoot: secondIsolatedRoot,
          runtimeRoot: secondRuntimeRoot,
          steps: [{ command: process.execPath, args: ["-e", ""] }],
        }),
      );
      legacyRoot = await pilotRoot();
      const legacyTmuxRoot = join(legacyRoot.path, "runtime", "stn-real-tmux-legacy");
      await mkdir(legacyTmuxRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(legacyTmuxRoot, "server.sock"), "legacy\n", { mode: 0o600 });
      const fakeTmux = join(fixtureRoot, "fake-tmux.mjs");
      await writeFile(
        fakeTmux,
        [
          "#!/usr/bin/env node",
          'import { existsSync, rmSync } from "node:fs";',
          'const socket = process.argv[process.argv.indexOf("-S") + 1];',
          "const command = process.argv.at(-1);",
          'if (command === "kill-server") { rmSync(socket, { force: true }); process.exit(0); }',
          'process.exit(command === "list-sessions" && existsSync(socket) ? 0 : 1);',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      await finalizeCliUxPilotRoots(
        [...(result.cleanupRoots ?? []), legacyRoot],
        process.env,
        fakeTmux,
      );

      await waitForProcessExit(childPid);
      expect(existsSync(firstSocket)).toBe(false);
      expect(existsSync(firstIsolatedRoot.path)).toBe(false);
      expect(existsSync(firstRuntimeRoot.path)).toBe(false);
      expect(existsSync(secondIsolatedRoot.path)).toBe(false);
      expect(existsSync(secondRuntimeRoot.path)).toBe(false);
      expect(existsSync(legacyRoot.path)).toBe(false);
      expect(await readdir(runtimeOwnerRecordDirectory(ownerStateDir))).toEqual([]);
    } finally {
      if (firstOwner.exitCode === null && firstOwner.signalCode === null)
        firstOwner.kill("SIGKILL");
      await waitForChildExit(firstOwner).catch(() => undefined);
      if (childPid !== undefined && processExists(childPid)) process.kill(childPid, "SIGKILL");
      await rm(firstIsolatedRoot.path, { recursive: true, force: true });
      await rm(firstRuntimeRoot.path, { recursive: true, force: true });
      if (secondIsolatedRoot !== undefined)
        await rm(secondIsolatedRoot.path, { recursive: true, force: true });
      if (secondRuntimeRoot !== undefined)
        await rm(secondRuntimeRoot.path, { recursive: true, force: true });
      if (legacyRoot !== undefined) await rm(legacyRoot.path, { recursive: true, force: true });
    }
  }, 15_000);

  it("cleans a valid pilot root after refusing an earlier replaced root", async () => {
    const replaced = await pilotRoot();
    const originalPath = `${replaced.path}-original`;
    const valid = await pilotRoot(cliUxPilotRuntimeRootPrefix);
    try {
      await rename(replaced.path, originalPath);
      await mkdir(replaced.path, { mode: 0o700 });
      await writeFile(join(replaced.path, "preserve"), "yes\n", { mode: 0o600 });

      await expect(
        finalizeCliUxPilotRoots([replaced, valid], process.env, "/usr/bin/false"),
      ).rejects.toThrow("CLI UX pilot root cleanup failed.");

      expect(await readFile(join(replaced.path, "preserve"), "utf8")).toBe("yes\n");
      expect(existsSync(valid.path)).toBe(false);
    } finally {
      await rm(replaced.path, { recursive: true, force: true });
      await rm(originalPath, { recursive: true, force: true });
      await rm(valid.path, { recursive: true, force: true });
    }
  });

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

async function pilotRoot(prefix = join(tmpdir(), "station-cli-ux-pilot-")) {
  const path = await realpath(await mkdtemp(prefix));
  const metadata = await lstat(path);
  return { path, device: String(metadata.dev), inode: String(metadata.ino) };
}

function pilotRuntimeInput(input: {
  checkout: string;
  ownerStateDir: string;
  isolatedRoot: { path: string; device: string; inode: string };
  runtimeRoot: { path: string; device: string; inode: string };
  steps: Array<{ command: string; args: string[] }>;
}) {
  return {
    role: "cli-ux-pilot" as const,
    checkoutRoot: input.checkout,
    stateDir: input.ownerStateDir,
    socketRoots: [input.runtimeRoot.path],
    persistenceRoots: [input.isolatedRoot.path, input.runtimeRoot.path],
    cleanupRoots: [input.isolatedRoot, input.runtimeRoot],
    survivorPolicy: "preserve-persistent-station-runtime" as const,
    terminalKey: "cli-ux-pilot",
    recoveryKey: "origin/main",
    correlation: {
      traceId: "trc_cli_ux_pilot_recovery",
      spanId: "spn_cli_ux_pilot_recovery",
    },
    launch: { cwd: input.checkout, steps: input.steps },
  };
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

async function waitForOwnerRecord(stateDir: string): Promise<void> {
  const directory = runtimeOwnerRecordDirectory(stateDir);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const entries = await readdir(directory).catch(() => []);
    if (entries.length > 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for pilot owner record.");
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processExists(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit.`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
