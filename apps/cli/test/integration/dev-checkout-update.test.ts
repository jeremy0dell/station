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
      pathEnv: fixture.pathEnv,
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

  it("uses the fetched root Bun target's four-command preparation plan", async () => {
    const fixture = await checkoutFixture({
      targetPackage: rootBunTargetPackage("1.4.0"),
      bunVersion: "1.4.0",
    });
    const preparationCommands: ExternalCommandInput[] = [];
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
      commandRunner: async (input) => {
        if (basename(input.command) === "bun") {
          if (input.args?.[0] === "--version") {
            return nodeExternalCommandRunner(input);
          }
          preparationCommands.push(input);
          return commandResult(input);
        }
        if (basename(input.command) === "pnpm") {
          throw new Error("the root Bun target must not invoke pnpm");
        }
        return nodeExternalCommandRunner(input);
      },
    });

    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    const plan = await channel.plan(detection);
    const report = await channel.apply(plan);

    expect(report).toMatchObject({
      status: "updated",
      previousRevision: fixture.currentRevision,
      installedRevision: fixture.targetRevision,
    });
    expect(preparationCommands).toEqual([
      expect.objectContaining({
        command: plan.bunPath,
        args: ["install", "--frozen-lockfile"],
        cwd: plan.repoRoot,
      }),
      expect.objectContaining({
        command: plan.bunPath,
        args: ["run", "build"],
        cwd: plan.repoRoot,
      }),
      expect.objectContaining({
        command: plan.bunPath,
        args: ["run", "repair:node-pty"],
        cwd: join(plan.repoRoot, "station"),
      }),
      expect.objectContaining({
        command: plan.bunPath,
        args: ["run", "station:link"],
        cwd: plan.repoRoot,
      }),
    ]);
  });

  it("can cross to a root Bun target when pnpm is no longer available", async () => {
    const fixture = await checkoutFixture({
      targetPackage: rootBunTargetPackage("1.4.0"),
      bunVersion: "1.4.0",
      includePnpm: false,
    });
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
    });

    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    expect(detection.pnpmPath).toBeUndefined();
    const plan = await channel.plan(detection);

    await expect(channel.apply(plan)).resolves.toMatchObject({
      status: "updated",
      installedRevision: fixture.targetRevision,
    });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.targetRevision);
  });

  it("requires pnpm only when the fetched target remains legacy", async () => {
    const fixture = await checkoutFixture({ includePnpm: false });
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
    });

    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    const plan = await channel.plan(detection);

    await expect(channel.apply(plan)).rejects.toMatchObject({
      code: "UPDATE_PLAN_FAILED",
      message: "The legacy-pnpm target requires pnpm, but no pnpm executable is available.",
    });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.currentRevision);
  });

  it("requires the fetched root target's exact Bun before fast-forwarding", async () => {
    const fixture = await checkoutFixture({
      targetPackage: rootBunTargetPackage("1.4.0"),
      bunVersion: "1.3.14",
    });
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
    });
    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    const plan = await channel.plan(detection);

    await expect(channel.apply(plan)).rejects.toMatchObject({
      code: "UPDATE_DEV_CHECKOUT_BUN_MISMATCH",
      message:
        "The target Station revision requires Bun 1.4.0, but the planned Bun executable reports 1.3.14.",
      hint: expect.stringContaining("checkout was not advanced"),
    });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.currentRevision);
  });

  it("rejects an unsupported fetched package policy before fast-forwarding", async () => {
    const fixture = await checkoutFixture({
      targetPackage: rootBunTargetPackage("^1.4.0"),
      bunVersion: "1.4.0",
    });
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
    });
    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    const plan = await channel.plan(detection);

    await expect(channel.apply(plan)).rejects.toMatchObject({
      code: "UPDATE_PLAN_FAILED",
      message:
        "The target Station revision is not a supported legacy-pnpm or exact root-Bun checkout.",
    });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.currentRevision);
  });

  it("rejects a root Bun target without its native-helper repair script", async () => {
    const fixture = await checkoutFixture({
      targetPackage: rootBunTargetPackage("1.4.0"),
      targetStationPackage: {
        name: "@station/workspace",
        scripts: {},
      },
      bunVersion: "1.4.0",
    });
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
    });
    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected dev-checkout detection");
    const plan = await channel.plan(detection);

    await expect(channel.apply(plan)).rejects.toMatchObject({
      code: "UPDATE_PLAN_FAILED",
      message:
        "The target Station revision is not a supported legacy-pnpm or exact root-Bun checkout.",
    });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.currentRevision);
  });

  it("requires Bun before admitting a development checkout", async () => {
    const fixture = await checkoutFixture();
    const pathEnv = await toolPath(fixture.root, ["git"], "missing-bun-bin");
    await writeFakePnpm(pathEnv);
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
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
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
      pathEnv: fixture.pathEnv,
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

  it("reports only the root Bun recovery sequence after crossing the migration boundary", async () => {
    const fixture = await checkoutFixture({
      targetPackage: rootBunTargetPackage("1.4.0"),
      bunVersion: "1.4.0",
    });
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
      commandRunner: async (input) => {
        if (basename(input.command) === "bun" && input.args?.[0] === "--version") {
          return commandResult(input, "1.4.0\n");
        }
        if (basename(input.command) === "bun" && input.args?.[0] === "install") {
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

    expect(failure).toMatchObject({ code: "UPDATE_DEV_CHECKOUT_PREPARE_FAILED" });
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.targetRevision);
    await expect(channel.inspectInstalled(plan)).resolves.toEqual({
      version: "1.0.0",
      revision: fixture.targetRevision,
    });
    expect(channel.applyRecoveryCommands?.(plan, failure)).toEqual([
      [plan.bunPath, "install", "--cwd", plan.repoRoot, "--frozen-lockfile"],
      [plan.bunPath, "run", "--cwd", plan.repoRoot, "build"],
      [plan.bunPath, "run", "--cwd", join(plan.repoRoot, "station"), "repair:node-pty"],
      [plan.bunPath, "run", "--cwd", plan.repoRoot, "station:link"],
    ]);
  });

  it("preserves cancellation after the checkout fast-forwards", async () => {
    const fixture = await checkoutFixture({
      targetPackage: rootBunTargetPackage("1.4.0"),
      bunVersion: "1.4.0",
      includePnpm: false,
    });
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
      commandRunner: async (input) => {
        if (basename(input.command) === "bun" && input.args?.[0] === "install") {
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
    expect(channel.applyRecoveryCommands?.(plan, failure)).toEqual([
      [plan.bunPath, "install", "--cwd", plan.repoRoot, "--frozen-lockfile"],
      [plan.bunPath, "run", "--cwd", plan.repoRoot, "build"],
      [plan.bunPath, "run", "--cwd", join(plan.repoRoot, "station"), "repair:node-pty"],
      [plan.bunPath, "run", "--cwd", plan.repoRoot, "station:link"],
    ]);
  });

  it("refuses to plan a dirty checkout", async () => {
    const fixture = await checkoutFixture();
    await writeFile(join(fixture.checkout, "dirty.txt"), "dirty\n");
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: fixture.pathEnv,
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

async function checkoutFixture(
  options: {
    targetPackage?: Record<string, unknown>;
    targetStationPackage?: Record<string, unknown>;
    bunVersion?: string;
    includePnpm?: boolean;
  } = {},
) {
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
  await mkdir(join(checkout, "station"), { recursive: true });
  const cliEntryPath = join(checkout, "apps", "cli", "dist", "main.js");
  await writeFile(join(checkout, "package.json"), JSON.stringify(legacyTargetPackage()));
  await writeFile(join(checkout, "station", "package.json"), JSON.stringify(stationPackage()));
  await writeFile(cliEntryPath, 'process.stdout.write("1.0.0\\n");\n');
  await writeFile(join(checkout, "README.md"), "one\n");
  await run("git", ["add", "."], checkout);
  await run("git", ["commit", "-m", "initial"], checkout);
  await run("git", ["remote", "add", "origin", remote], checkout);
  await run("git", ["push", "-u", "origin", "main"], checkout);
  const currentRevision = await git(checkout, ["rev-parse", "HEAD"]);
  await writeFile(join(checkout, "README.md"), "two\n");
  await writeFile(
    join(checkout, "package.json"),
    JSON.stringify(options.targetPackage ?? legacyTargetPackage()),
  );
  await writeFile(
    join(checkout, "station", "package.json"),
    JSON.stringify(options.targetStationPackage ?? stationPackage()),
  );
  await run("git", ["add", "README.md", "package.json", "station/package.json"], checkout);
  await run("git", ["commit", "-m", "target"], checkout);
  const targetRevision = await git(checkout, ["rev-parse", "HEAD"]);
  await run("git", ["push", "origin", "main"], checkout);
  await run("git", ["reset", "--hard", currentRevision], checkout);
  const pathEnv = await devToolPath(
    root,
    options.bunVersion ?? "1.3.14",
    options.includePnpm ?? true,
  );
  return { root, checkout, cliEntryPath, currentRevision, targetRevision, pathEnv };
}

function legacyTargetPackage(): Record<string, unknown> {
  return {
    name: "station",
    version: "1.0.0",
    packageManager: "pnpm@11.0.0",
    scripts: {
      build: "node scripts/build.mjs",
      "station:link": "pnpm add --global .",
    },
  };
}

function rootBunTargetPackage(version: string): Record<string, unknown> {
  return {
    name: "station",
    version: "1.0.0",
    packageManager: `bun@${version}`,
    workspaces: ["apps/*", "packages/*", "integrations/*/*", "station"],
    scripts: {
      build: "node scripts/build.mjs",
      "station:link": "bun link",
    },
  };
}

function stationPackage(): Record<string, unknown> {
  return {
    name: "@station/workspace",
    scripts: {
      "link:station": "./scripts/link-station-packages.sh",
      "repair:node-pty": "./scripts/repair-node-pty.sh",
    },
  };
}

async function devToolPath(
  root: string,
  bunVersion: string,
  includePnpm: boolean,
): Promise<string> {
  const bin = await toolPath(root, ["git"]);
  if (includePnpm) await writeFakePnpm(bin);
  await writeFakeBun(bin, bunVersion);
  return bin;
}

async function writeFakePnpm(bin: string): Promise<void> {
  await writeFile(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

async function writeFakeBun(bin: string, version: string): Promise<void> {
  await writeFile(
    join(bin, "bun"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf '%s\\n' '${version}'\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
}

async function toolPath(root: string, commands: string[], directory = "test-bin"): Promise<string> {
  const bin = join(root, directory);
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

function commandResult(input: ExternalCommandInput, stdout = ""): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
