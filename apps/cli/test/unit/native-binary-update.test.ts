import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGithubNativeReleaseDiscovery,
  type NativeBinaryRelease,
  type NativeReleaseDiscovery,
} from "../../src/update/githubRelease.js";
import {
  createNativeBinaryUpdateEngine,
  type NativeBinaryUpdateEngineDeps,
} from "../../src/update/nativeBinaryUpdate.js";

const CURRENT_TAG = "v0.7.1-rc.8";
const CURRENT_VERSION = CURRENT_TAG.slice(1);
const TARGET_TAG = "v0.0.0-pre-alpha.5.1";
const TARGET_VERSION = TARGET_TAG.slice(1);
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GitHub native release discovery", () => {
  it("selects the newest complete immutable release, including prereleases", async () => {
    const calls: ExternalCommandInput[] = [];
    const discovery = createGithubNativeReleaseDiscovery({
      commandRunner: async (input) => {
        calls.push(input);
        const url = input.args?.at(-1);
        return commandResult(
          input,
          JSON.stringify(
            url?.includes("/tags/")
              ? githubRelease(CURRENT_TAG, 8, "2026-07-01T00:00:00Z", [])
              : [
                  githubRelease("v9.0.0", 99, "2026-08-03T00:00:00Z", releaseAssets("v9.0.0"), {
                    immutable: false,
                  }),
                  githubRelease("v8.0.0", 98, "2026-08-02T00:00:00Z", ["install.sh"]),
                  githubRelease("v7.0.0", 97, "2026-08-02T00:00:00Z", [
                    ...releaseAssets("v7.0.0").slice(0, -1),
                    "install.sh",
                  ]),
                  githubRelease(TARGET_TAG, 42, "2026-08-01T00:00:00Z", releaseAssets(TARGET_TAG)),
                ],
          ),
        );
      },
    });

    const result = await discovery.resolve({ currentTag: CURRENT_TAG });

    expect(result.current.tag).toBe(CURRENT_TAG);
    expect(result.latest.tag).toBe(TARGET_TAG);
    expect(result.latest.assets.archive["darwin-arm64"].name).toBe(
      `stn-v${TARGET_VERSION}-darwin-arm64.tar.gz`,
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.command === "curl")).toBe(true);
    expect(calls.map((call) => call.args?.at(-1))).not.toContain(
      "https://api.github.com/repos/jeremy0dell/station/releases/latest",
    );
    expect(calls[0]?.unsetEnv).toContain("GITHUB_TOKEN");
  });

  it("rejects release lists without a complete immutable candidate", async () => {
    const discovery = createGithubNativeReleaseDiscovery({
      commandRunner: async (input) =>
        commandResult(
          input,
          JSON.stringify(
            input.args?.at(-1)?.includes("/tags/")
              ? githubRelease(CURRENT_TAG, 8, "2026-07-01T00:00:00Z", [])
              : [githubRelease(TARGET_TAG, 42, "2026-08-01T00:00:00Z", ["install.sh"])],
          ),
        ),
    });

    await expect(discovery.resolve({ currentTag: CURRENT_TAG })).rejects.toMatchObject({
      code: "UPDATE_RELEASE_INVALID",
    });
  });

  it("rejects a current build that is not a published immutable release", async () => {
    const discovery = createGithubNativeReleaseDiscovery({
      commandRunner: async (input) =>
        commandResult(
          input,
          JSON.stringify(
            input.args?.at(-1)?.includes("/tags/")
              ? githubRelease(CURRENT_TAG, 8, "2026-07-01T00:00:00Z", [], {
                  immutable: false,
                })
              : [githubRelease(TARGET_TAG, 42, "2026-08-01T00:00:00Z", releaseAssets(TARGET_TAG))],
          ),
        ),
    });

    await expect(discovery.resolve({ currentTag: CURRENT_TAG })).rejects.toMatchObject({
      code: "UPDATE_RELEASE_INVALID",
    });
  });
});

describe("native binary update planning", () => {
  it("plans an update from a recognized compiled installation", async () => {
    const fixture = await installedFixture();
    const engine = createEngine(fixture, fakeDiscovery(currentRelease(), targetRelease()));

    await expect(engine.plan()).resolves.toMatchObject({
      status: "update-available",
      channel: "native-binary",
      current: { tag: CURRENT_TAG },
      target: { tag: TARGET_TAG },
      platform: hostTarget(),
      executablePath: fixture.executablePath,
      installDir: fixture.installDir,
      executableIdentity: { device: expect.any(String), inode: expect.any(String) },
    });
  });

  it("returns current for the installed release and never downgrades a newer publication", async () => {
    const fixture = await installedFixture();
    const exact = currentRelease();
    const same = createEngine(fixture, fakeDiscovery(exact, exact));
    await expect(same.plan()).resolves.toMatchObject({ status: "current", target: exact });

    const newerCurrent = { ...exact, publishedAt: "2026-09-01T00:00:00Z" };
    const noDowngrade = createEngine(fixture, fakeDiscovery(newerCurrent, targetRelease()));
    await expect(noDowngrade.plan()).resolves.toMatchObject({
      status: "current",
      current: newerCurrent,
      target: newerCurrent,
    });
  });

  it("refuses source runs and malformed launcher layouts before release discovery", async () => {
    const fixture = await installedFixture();
    let discoveries = 0;
    const discovery: NativeReleaseDiscovery = {
      async resolve() {
        discoveries += 1;
        return { current: currentRelease(), latest: targetRelease() };
      },
    };
    const sourceEngine = createEngine(fixture, discovery, {
      buildInfo: () => ({
        version: CURRENT_VERSION,
        compiled: false,
        buildIdentity: "a".repeat(64),
      }),
    });
    await expect(sourceEngine.plan()).rejects.toMatchObject({ code: "UPDATE_CHANNEL_UNSUPPORTED" });

    const invalidVersionEngine = createEngine(fixture, discovery, {
      buildInfo: () => ({
        version: "0.0.0-local+dirty",
        compiled: true,
        buildIdentity: "a".repeat(64),
      }),
    });
    await expect(invalidVersionEngine.plan()).rejects.toMatchObject({
      code: "UPDATE_RELEASE_INVALID",
    });

    const unsupportedPlatformEngine = createEngine(fixture, discovery, { platform: "win32" });
    await expect(unsupportedPlatformEngine.plan()).rejects.toMatchObject({
      code: "UPDATE_CHANNEL_UNSUPPORTED",
    });

    await rm(join(fixture.installDir, "stn-ingress"));
    await writeFile(join(fixture.installDir, "stn-ingress"), "not-a-symlink");
    const malformedEngine = createEngine(fixture, discovery);
    await expect(malformedEngine.plan()).rejects.toMatchObject({
      code: "UPDATE_CHANNEL_UNSUPPORTED",
    });
    expect(discoveries).toBe(0);
  });
});

describe("native binary update application", () => {
  it("verifies and invokes the exact-tag installer, then postchecks the installed binary", async () => {
    const fixture = await installedFixture();
    const commands: ExternalCommandInput[] = [];
    const installer = installerBody(TARGET_TAG);
    const runner = installingRunner(installer, commands);
    const engine = createEngine(fixture, fakeDiscovery(currentRelease(), targetRelease()), {
      commandRunner: runner,
      tempRoot: fixture.tempRoot,
    });
    const plan = await engine.plan();
    expect(plan.status).toBe("update-available");
    if (plan.status !== "update-available") throw new Error("expected update plan");

    await expect(engine.apply(plan)).resolves.toEqual({
      status: "installed",
      channel: "native-binary",
      previousVersion: CURRENT_VERSION,
      installedVersion: TARGET_VERSION,
      executablePath: fixture.executablePath,
    });

    const curls = commands.filter((command) => command.command === "curl");
    expect(curls).toHaveLength(2);
    expect(curls[0]?.args).toContain("--proto");
    expect(curls[0]?.args).toContain("=https");
    expect(curls.map((command) => command.args?.at(-1))).toEqual([
      targetRelease().assets.installer.url,
      targetRelease().assets.checksums.url,
    ]);
    expect(commands).toContainEqual(
      expect.objectContaining({
        command: "/bin/sh",
        args: [
          expect.stringContaining("/install.sh"),
          "--version",
          TARGET_TAG,
          "--install-dir",
          fixture.installDir,
        ],
        unsetEnv: expect.arrayContaining([
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "STATION_INSTALL_RELEASE_ID",
        ]),
      }),
    );
    expect(commands.at(-1)).toMatchObject({
      command: fixture.executablePath,
      args: ["--version"],
    });
    expect(await readlink(join(fixture.installDir, "stn-ingress"))).toBe("stn");
    expect(await readdir(fixture.tempRoot)).toEqual([]);
  });

  it("rejects an installer checksum mismatch without invoking the installer", async () => {
    const fixture = await installedFixture();
    const commands: ExternalCommandInput[] = [];
    const engine = createEngine(fixture, fakeDiscovery(currentRelease(), targetRelease()), {
      commandRunner: installingRunner(installerBody(TARGET_TAG), commands, {
        checksum: "0".repeat(64),
      }),
      tempRoot: fixture.tempRoot,
    });
    const plan = await engine.plan();
    if (plan.status !== "update-available") throw new Error("expected update plan");

    await expect(engine.apply(plan)).rejects.toMatchObject({
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
    });
    expect(commands.some(isInstallerInvocation)).toBe(false);
    expect(await readdir(fixture.tempRoot)).toEqual([]);
  });

  it("refuses a stale executable before downloading or after verification", async () => {
    const fixture = await installedFixture();
    const commands: ExternalCommandInput[] = [];
    const engine = createEngine(fixture, fakeDiscovery(currentRelease(), targetRelease()), {
      commandRunner: installingRunner(installerBody(TARGET_TAG), commands),
      tempRoot: fixture.tempRoot,
    });
    const plan = await engine.plan();
    if (plan.status !== "update-available") throw new Error("expected update plan");
    await replaceExecutable(fixture.executablePath);

    await expect(engine.apply(plan)).rejects.toMatchObject({ code: "UPDATE_PLAN_STALE" });
    expect(commands).toEqual([]);

    const secondPlan = await engine.plan();
    if (secondPlan.status !== "update-available") throw new Error("expected update plan");
    const afterDownloadCommands: ExternalCommandInput[] = [];
    const staleAfterDownload = createEngine(
      fixture,
      fakeDiscovery(currentRelease(), targetRelease()),
      {
        tempRoot: fixture.tempRoot,
        commandRunner: installingRunner(installerBody(TARGET_TAG), afterDownloadCommands, {
          afterChecksums: () => replaceExecutable(fixture.executablePath),
        }),
      },
    );

    await expect(staleAfterDownload.apply(secondPlan)).rejects.toMatchObject({
      code: "UPDATE_PLAN_STALE",
    });
    expect(afterDownloadCommands.some(isInstallerInvocation)).toBe(false);
    expect(await readdir(fixture.tempRoot)).toEqual([]);
  });

  it("rejects mismatched installer stamps and cleans up failed installer runs", async () => {
    const fixture = await installedFixture();
    const mismatched = createEngine(fixture, fakeDiscovery(currentRelease(), targetRelease()), {
      commandRunner: installingRunner(installerBody("v1.2.3"), []),
      tempRoot: fixture.tempRoot,
    });
    const mismatchPlan = await mismatched.plan();
    if (mismatchPlan.status !== "update-available") throw new Error("expected update plan");
    await expect(mismatched.apply(mismatchPlan)).rejects.toMatchObject({
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
    });

    const commands: ExternalCommandInput[] = [];
    const failing = createEngine(fixture, fakeDiscovery(currentRelease(), targetRelease()), {
      commandRunner: installingRunner(installerBody(TARGET_TAG), commands, { installFails: true }),
      tempRoot: fixture.tempRoot,
    });
    const failingPlan = await failing.plan();
    if (failingPlan.status !== "update-available") throw new Error("expected update plan");
    await expect(failing.apply(failingPlan)).rejects.toMatchObject({
      code: "UPDATE_INSTALL_FAILED",
      diagnosticDetails: [
        expect.objectContaining({
          type: "external_command",
          stderrSnippet: "Station install warning: activation could not be proven",
        }),
      ],
    });
    expect(await readdir(fixture.tempRoot)).toEqual([]);
  });

  it("maps shell-validation and postcheck failures without leaving staging files", async () => {
    const fixture = await installedFixture();
    const syntaxFailure = createEngine(fixture, fakeDiscovery(currentRelease(), targetRelease()), {
      commandRunner: installingRunner(installerBody(TARGET_TAG), [], { syntaxFails: true }),
      tempRoot: fixture.tempRoot,
    });
    const syntaxPlan = await syntaxFailure.plan();
    if (syntaxPlan.status !== "update-available") throw new Error("expected update plan");
    await expect(syntaxFailure.apply(syntaxPlan)).rejects.toMatchObject({
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
    });

    const badPostcheck = createEngine(fixture, fakeDiscovery(currentRelease(), targetRelease()), {
      commandRunner: installingRunner(installerBody(TARGET_TAG), [], {
        reportedVersion: CURRENT_VERSION,
      }),
      tempRoot: fixture.tempRoot,
    });
    const postcheckPlan = await badPostcheck.plan();
    if (postcheckPlan.status !== "update-available") throw new Error("expected update plan");
    await expect(badPostcheck.apply(postcheckPlan)).rejects.toMatchObject({
      code: "UPDATE_POSTCHECK_FAILED",
    });
    expect(await readdir(fixture.tempRoot)).toEqual([]);
  });
});

function githubRelease(
  tag: string,
  id: number,
  publishedAt: string,
  assets: readonly string[],
  overrides: { immutable?: boolean; draft?: boolean } = {},
) {
  return {
    id,
    tag_name: tag,
    draft: overrides.draft ?? false,
    immutable: overrides.immutable ?? true,
    published_at: publishedAt,
    assets: assets.map((name, assetIndex) => ({ id: id * 100 + assetIndex + 1, name })),
  };
}

function releaseAssets(tag: string): string[] {
  const version = tag.slice(1);
  return [
    "SHA256SUMS",
    "install.sh",
    ...TARGETS.map((target) => `stn-v${version}-${target}.tar.gz`),
  ];
}

function release(tag: string, releaseId: number, publishedAt: string): NativeBinaryRelease {
  const version = tag.slice(1);
  const releaseUrl = `https://github.com/jeremy0dell/station/releases/download/${tag}`;
  return {
    tag,
    version,
    releaseId,
    publishedAt,
    assets: {
      installer: { name: "install.sh", url: `${releaseUrl}/install.sh` },
      checksums: { name: "SHA256SUMS", url: `${releaseUrl}/SHA256SUMS` },
      archive: Object.fromEntries(
        TARGETS.map((target) => {
          const name = `stn-v${version}-${target}.tar.gz`;
          return [target, { name, url: `${releaseUrl}/${name}` }];
        }),
      ) as NativeBinaryRelease["assets"]["archive"],
    },
  };
}

function currentRelease() {
  return release(CURRENT_TAG, 8, "2026-07-01T00:00:00Z");
}

function targetRelease() {
  return release(TARGET_TAG, 42, "2026-08-01T00:00:00Z");
}

function fakeDiscovery(
  current: NativeBinaryRelease,
  latest: NativeBinaryRelease,
): NativeReleaseDiscovery {
  return { resolve: async () => ({ current, latest }) };
}

async function installedFixture() {
  const root = await mkdtemp(join(tmpdir(), "station-native-update-test-"));
  tempRoots.push(root);
  const installDir = join(root, "bin");
  const tempRoot = join(root, "tmp");
  await Promise.all([mkdir(installDir), mkdir(tempRoot)]);
  const executablePath = join(installDir, "stn");
  await writeFile(executablePath, "current-binary", { mode: 0o755 });
  await Promise.all([
    symlink("stn", join(installDir, "stn-ingress")),
    symlink("stn", join(installDir, "stn-tmux-popup")),
  ]);
  return {
    root,
    installDir: await realpath(installDir),
    tempRoot: await realpath(tempRoot),
    executablePath: await realpath(executablePath),
  };
}

function createEngine(
  fixture: Awaited<ReturnType<typeof installedFixture>>,
  releaseDiscovery: NativeReleaseDiscovery,
  overrides: Partial<NativeBinaryUpdateEngineDeps> = {},
) {
  return createNativeBinaryUpdateEngine({
    buildInfo: () => ({ version: CURRENT_VERSION, compiled: true, buildIdentity: "a".repeat(64) }),
    executablePath: fixture.executablePath,
    platform: process.platform,
    architecture: process.arch,
    releaseDiscovery,
    ...overrides,
  });
}

function hostTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  return "linux-x64";
}

function installerBody(tag: string) {
  return `#!/bin/sh\nembedded_version="${tag}"\nexit 0\n`;
}

function installingRunner(
  installer: string,
  commands: ExternalCommandInput[],
  options: {
    checksum?: string;
    installFails?: boolean;
    syntaxFails?: boolean;
    reportedVersion?: string;
    afterChecksums?: () => Promise<void>;
  } = {},
) {
  return async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
    commands.push(input);
    if (input.command === "curl") {
      const outputIndex = input.args?.indexOf("--output") ?? -1;
      const outputPath = input.args?.[outputIndex + 1];
      if (outputPath === undefined) throw new Error("missing curl output");
      if (input.args?.at(-1)?.endsWith("/install.sh")) {
        await writeFile(outputPath, installer, { mode: 0o600 });
      } else {
        const checksum = options.checksum ?? createHash("sha256").update(installer).digest("hex");
        await writeFile(outputPath, `${checksum}  install.sh\n${"1".repeat(64)}  archive.tar.gz\n`);
        await options.afterChecksums?.();
      }
      return commandResult(input);
    }
    if (input.command === "/bin/sh" && input.args?.[0] === "-n") {
      if (options.syntaxFails === true) {
        throw Object.assign(new Error("invalid shell syntax"), { exitCode: 2 });
      }
      return commandResult(input);
    }
    if (isInstallerInvocation(input)) {
      if (options.installFails === true) {
        throw Object.assign(new Error("installer failed"), {
          exitCode: 1,
          stderr: "Station install warning: activation could not be proven",
        });
      }
      return commandResult(input);
    }
    if (input.args?.[0] === "--version") {
      return commandResult(input, options.reportedVersion ?? TARGET_VERSION);
    }
    throw new Error(`unexpected command: ${input.command} ${(input.args ?? []).join(" ")}`);
  };
}

function isInstallerInvocation(input: ExternalCommandInput) {
  return input.command === "/bin/sh" && input.args?.[0]?.endsWith("/install.sh") === true;
}

async function replaceExecutable(executablePath: string) {
  const replacement = `${executablePath}.replacement`;
  await writeFile(replacement, "replacement", { mode: 0o755 });
  await rename(replacement, executablePath);
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
