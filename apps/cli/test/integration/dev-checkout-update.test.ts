import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type ExternalCommandInput,
  type ExternalCommandResult,
  nodeExternalCommandRunner,
  resolveExecutablePath,
} from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createDevCheckoutUpdateChannel } from "../../src/update/devCheckoutUpdate.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("dev-checkout update channel", () => {
  it("plans without moving refs, then applies the pinned fast-forward and rebuilds", async () => {
    const fixture = await checkoutFixture();
    const preparationCommands: ExternalCommandInput[] = [];
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: process.env.PATH ?? "",
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
      commandRunner: async (input) => {
        if (["pnpm", "bun"].includes(basename(input.command))) {
          preparationCommands.push(input);
          return commandResult(input);
        }
        return nodeExternalCommandRunner(input);
      },
    });

    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    const plan = await channel.plan(detection);
    expect(plan).toMatchObject({
      status: "update-available",
      currentRevision: fixture.currentRevision,
      targetRevision: fixture.targetRevision,
      upstreamRemote: "origin",
      upstreamRef: "refs/heads/main",
    });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.currentRevision);

    await expect(
      channel.apply({ ...plan, currentCli: ["/not/the/planned/cli"] }),
    ).rejects.toMatchObject({ code: "UPDATE_PLAN_INVALID" });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.currentRevision);

    const report = await channel.apply(plan);
    expect(report).toMatchObject({
      status: "updated",
      previousRevision: fixture.currentRevision,
      installedRevision: fixture.targetRevision,
      successorCli: [process.execPath, plan.cliEntryPath],
    });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.targetRevision);
    expect(preparationCommands).toEqual([
      expect.objectContaining({
        command: plan.pnpmPath,
        args: ["install", "--frozen-lockfile"],
        cwd: plan.repoRoot,
      }),
      expect.objectContaining({
        command: plan.bunPath,
        args: ["install", "--frozen-lockfile"],
        cwd: join(plan.repoRoot, "station"),
      }),
      expect.objectContaining({ command: plan.pnpmPath, args: ["build"], cwd: plan.repoRoot }),
      expect.objectContaining({
        command: plan.bunPath,
        args: ["run", "link:station"],
        cwd: join(plan.repoRoot, "station"),
      }),
      expect.objectContaining({
        command: plan.bunPath,
        args: ["run", "repair:node-pty"],
        cwd: join(plan.repoRoot, "station"),
      }),
      expect.objectContaining({
        command: plan.pnpmPath,
        args: ["station:link"],
        cwd: plan.repoRoot,
      }),
    ]);
  });

  it("requires Bun before admitting a development checkout", async () => {
    const fixture = await checkoutFixture();
    const pathEnv = await toolPath(fixture.root, ["git", "pnpm"]);
    let commandRan = false;
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
      commandRunner: async (input) => {
        commandRan = true;
        return commandResult(input);
      },
    });

    await expect(channel.detect()).resolves.toBeUndefined();
    expect(commandRan).toBe(false);
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.currentRevision);
  });

  it("rejects a missing pinned Bun executable before fast-forwarding", async () => {
    const fixture = await checkoutFixture();
    const pathEnv = await toolPath(fixture.root, ["git", "pnpm", "bun"]);
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
    });
    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    const plan = await channel.plan(detection);

    await rm(plan.bunPath);

    await expect(channel.apply(plan)).rejects.toMatchObject({ code: "UPDATE_PLAN_STALE" });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.currentRevision);
  });

  it("keeps the pinned fast-forward and diagnostics when dependency preparation fails", async () => {
    const fixture = await checkoutFixture();
    const preparationCommands: ExternalCommandInput[] = [];
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: process.env.PATH ?? "",
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
      commandRunner: async (input) => {
        if (["pnpm", "bun"].includes(basename(input.command))) {
          preparationCommands.push(input);
          throw Object.assign(new Error("dependency install failed"), {
            code: 17,
            stderr: "registry unavailable",
          });
        }
        return nodeExternalCommandRunner(input);
      },
    });
    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    const plan = await channel.plan(detection);

    const failure = await captureFailure(channel.apply(plan));

    expect(failure).toMatchObject({
      code: "UPDATE_DEV_CHECKOUT_PREPARE_FAILED",
      diagnosticDetails: [
        expect.objectContaining({
          type: "external_command",
          cwd: plan.repoRoot,
          exitCode: 17,
          stderrSnippet: "registry unavailable",
        }),
      ],
    });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.targetRevision);
    expect(preparationCommands).toEqual([
      expect.objectContaining({
        command: plan.pnpmPath,
        args: ["install", "--frozen-lockfile"],
        cwd: plan.repoRoot,
      }),
    ]);
    expect(channel.applyRecoveryCommands?.(plan, failure)).toEqual([
      [plan.pnpmPath, "--dir", plan.repoRoot, "install", "--frozen-lockfile"],
      [plan.bunPath, "--cwd", join(plan.repoRoot, "station"), "install", "--frozen-lockfile"],
      [plan.pnpmPath, "--dir", plan.repoRoot, "build"],
      [plan.bunPath, "run", "--cwd", join(plan.repoRoot, "station"), "link:station"],
      [plan.bunPath, "run", "--cwd", join(plan.repoRoot, "station"), "repair:node-pty"],
      [plan.pnpmPath, "--dir", plan.repoRoot, "station:link"],
    ]);
  });

  it("preserves cancellation after the checkout fast-forwards", async () => {
    const fixture = await checkoutFixture();
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: process.env.PATH ?? "",
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
      commandRunner: async (input) => {
        if (basename(input.command) === "pnpm" && input.args?.[0] === "install") {
          throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }
        return nodeExternalCommandRunner(input);
      },
    });
    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    const plan = await channel.plan(detection);

    const failure = await captureFailure(channel.apply(plan));

    expect(failure).toMatchObject({
      code: "EXTERNAL_COMMAND_ABORTED",
      diagnosticDetails: [
        expect.objectContaining({ type: "external_command", cwd: plan.repoRoot }),
      ],
    });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.targetRevision);
  });

  it("refuses to plan a dirty checkout", async () => {
    const fixture = await checkoutFixture();
    await writeFile(join(fixture.checkout, "dirty.txt"), "dirty\n");
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: process.env.PATH ?? "",
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
    });
    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    await expect(channel.plan(detection)).rejects.toMatchObject({ code: "UPDATE_PLAN_FAILED" });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.currentRevision);
  });
});

async function checkoutFixture() {
  const root = await mkdtemp(join(tmpdir(), "station-dev-update-test-"));
  cleanup.push(root);
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  await run("git", ["init", "--bare", remote]);
  await mkdir(checkout, { recursive: true });
  await run("git", ["init", "-b", "main"], checkout);
  await run("git", ["config", "user.name", "Station Test"], checkout);
  await run("git", ["config", "user.email", "station@example.invalid"], checkout);
  await mkdir(join(checkout, "apps", "cli", "dist"), { recursive: true });
  const cliEntryPath = join(checkout, "apps", "cli", "dist", "main.js");
  await writeFile(
    join(checkout, "package.json"),
    JSON.stringify({ name: "station", version: "1.0.0" }),
  );
  await writeFile(cliEntryPath, 'process.stdout.write("1.0.0\\n");\n');
  await writeFile(join(checkout, "README.md"), "one\n");
  await run("git", ["add", "."], checkout);
  await run("git", ["commit", "-m", "initial"], checkout);
  await run("git", ["remote", "add", "origin", remote], checkout);
  await run("git", ["push", "-u", "origin", "main"], checkout);
  const currentRevision = await git(checkout, ["rev-parse", "HEAD"]);
  await writeFile(join(checkout, "README.md"), "two\n");
  await run("git", ["add", "README.md"], checkout);
  await run("git", ["commit", "-m", "target"], checkout);
  const targetRevision = await git(checkout, ["rev-parse", "HEAD"]);
  await run("git", ["push", "origin", "main"], checkout);
  await run("git", ["reset", "--hard", currentRevision], checkout);
  return { root, checkout, cliEntryPath, currentRevision, targetRevision };
}

async function toolPath(root: string, commands: string[]): Promise<string> {
  const bin = join(root, "test-bin");
  await mkdir(bin, { recursive: true });
  for (const command of commands) {
    const executable = await resolveExecutablePath(command);
    if (executable === undefined) throw new Error(`${command} is required for this test`);
    await symlink(executable, join(bin, command));
  }
  return bin;
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run("git", args, cwd)).stdout.trim();
}

function run(command: string, args: string[], cwd?: string) {
  return nodeExternalCommandRunner({ command, args, ...(cwd === undefined ? {} : { cwd }) });
}

function commandResult(input: ExternalCommandInput): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout: "",
    stderr: "",
    exitCode: 0,
  };
}
