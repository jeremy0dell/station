import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type ExternalCommandInput,
  type ExternalCommandResult,
  nodeExternalCommandRunner,
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
    const pnpmCommands: string[][] = [];
    const channel = createDevCheckoutUpdateChannel({
      cliEntryPath: fixture.cliEntryPath,
      pathEnv: process.env.PATH ?? "",
      buildInfo: () => ({
        compiled: false,
        version: "1.0.0",
        buildIdentity: "a".repeat(64),
      }),
      commandRunner: async (input) => {
        if (basename(input.command) === "pnpm") {
          pnpmCommands.push(input.args ?? []);
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
    expect(pnpmCommands).toEqual([["build"], ["station:link"]]);
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
  return { checkout, cliEntryPath, currentRevision, targetRevision };
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
