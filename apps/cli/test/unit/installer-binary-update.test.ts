import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
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
  createInstallerBinaryUpdateChannel,
  type InstallerBinaryUpdateChannelDeps,
  type InstallerBinaryUpdatePlan,
} from "../../src/update/installerBinaryUpdate.js";

const CURRENT_TAG = "v0.7.1-rc.8";
const CURRENT_VERSION = CURRENT_TAG.slice(1);
const TARGET_TAG = "v0.0.0-pre-alpha.9";
const TARGET_VERSION = TARGET_TAG.slice(1);
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
const RECEIPT = "station-installer-binary-v1\n";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GitHub installer-binary release discovery", () => {
  it("isolates curl configuration and selects across bounded pagination", async () => {
    const calls: ExternalCommandInput[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ invalid: index }));
    const discovery = createGithubNativeReleaseDiscovery({
      commandRunner: async (input) => {
        calls.push(input);
        const url = input.args?.at(-1) ?? "";
        if (url.includes("/tags/")) {
          return commandResult(
            input,
            JSON.stringify(
              githubRelease(CURRENT_TAG, 8, "2026-07-01T00:00:00Z", releaseAssets(CURRENT_TAG)),
            ),
          );
        }
        if (url.endsWith("page=1")) return commandResult(input, JSON.stringify(firstPage));
        return commandResult(
          input,
          JSON.stringify([
            githubRelease(TARGET_TAG, 41, "2026-08-01T00:00:00Z", releaseAssets(TARGET_TAG)),
            githubRelease("v1.0.0", 42, "2026-08-01T00:00:00Z", releaseAssets("v1.0.0")),
          ]),
        );
      },
    });

    const result = await discovery.resolve({ currentTag: CURRENT_TAG });

    expect(result.current.tag).toBe(CURRENT_TAG);
    expect(result.latest.tag).toBe("v1.0.0");
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.command === "curl" && call.args?.[0] === "--disable")).toBe(
      true,
    );
    expect(calls.map((call) => call.args?.at(-1))).toContain(
      "https://api.github.com/repos/jeremy0dell/station/releases?per_page=100&page=2",
    );
  });

  it("requires complete current metadata and skips malformed candidates", async () => {
    const incompleteCurrent = createGithubNativeReleaseDiscovery({
      commandRunner: async (input) =>
        commandResult(
          input,
          JSON.stringify(
            input.args?.at(-1)?.includes("/tags/")
              ? githubRelease(CURRENT_TAG, 8, "2026-07-01T00:00:00Z", [])
              : [],
          ),
        ),
    });
    await expect(incompleteCurrent.resolve({ currentTag: CURRENT_TAG })).rejects.toMatchObject({
      code: "UPDATE_RELEASE_INVALID",
    });

    const candidates = createGithubNativeReleaseDiscovery({
      commandRunner: async (input) =>
        commandResult(
          input,
          JSON.stringify(
            input.args?.at(-1)?.includes("/tags/")
              ? githubRelease(CURRENT_TAG, 8, "2026-07-01T00:00:00Z", releaseAssets(CURRENT_TAG))
              : [
                  { bad: "shape" },
                  githubRelease("v9.0.0", 90, "2026-09-01T00:00:00Z", releaseAssets("v9.0.0"), {
                    draft: true,
                  }),
                  githubRelease("v8.0.0", 80, "2026-08-01T00:00:00Z", [
                    ...releaseAssets("v8.0.0"),
                    "unexpected",
                  ]),
                  githubRelease(TARGET_TAG, 42, "2026-08-01T00:00:00Z", releaseAssets(TARGET_TAG)),
                ],
          ),
        ),
    });
    await expect(candidates.resolve({ currentTag: CURRENT_TAG })).resolves.toMatchObject({
      latest: { tag: TARGET_TAG },
    });
  });

  it("fails closed when 1,000 releases do not terminate pagination", async () => {
    let pageCalls = 0;
    const discovery = createGithubNativeReleaseDiscovery({
      commandRunner: async (input) => {
        if (input.args?.at(-1)?.includes("/tags/")) {
          return commandResult(
            input,
            JSON.stringify(
              githubRelease(CURRENT_TAG, 8, "2026-07-01T00:00:00Z", releaseAssets(CURRENT_TAG)),
            ),
          );
        }
        pageCalls += 1;
        return commandResult(
          input,
          JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ pageCalls, index }))),
        );
      },
    });

    await expect(discovery.resolve({ currentTag: CURRENT_TAG })).rejects.toMatchObject({
      code: "UPDATE_RELEASE_INVALID",
      message: expect.stringContaining("1000"),
    });
    expect(pageCalls).toBe(10);
  });

  it("preserves cancellation and distinguishes missing current metadata", async () => {
    const cancellation = createGithubNativeReleaseDiscovery({
      commandRunner: async () => {
        throw { cause: Object.assign(new Error("cancelled"), { name: "AbortError" }) };
      },
    });
    await expect(cancellation.resolve({ currentTag: CURRENT_TAG })).rejects.toMatchObject({
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_ABORTED",
    });

    const missing = createGithubNativeReleaseDiscovery({
      commandRunner: async () => {
        throw Object.assign(new Error("not found"), { exitCode: 22 });
      },
    });
    await expect(missing.resolve({ currentTag: CURRENT_TAG })).rejects.toMatchObject({
      code: "UPDATE_RELEASE_DISCOVERY_FAILED",
    });
  });
});

describe("installer-binary detection and planning", () => {
  it("detects only a receipt-owned compiled installation without release I/O", async () => {
    const fixture = await installedFixture();
    let discoveries = 0;
    const channel = createChannel(fixture, {
      releaseDiscovery: {
        async resolve() {
          discoveries += 1;
          return { current: currentRelease(), latest: targetRelease() };
        },
      },
    });

    const detection = await channel.detect();

    expect(detection).toMatchObject({
      channel: "installer-binary",
      currentVersion: CURRENT_VERSION,
      currentTag: CURRENT_TAG,
      platform: hostTarget(),
      executablePath: fixture.executablePath,
      binaryIdentity: {
        device: expect.any(String),
        inode: expect.any(String),
        sha256: createHash("sha256").update("current-binary").digest("hex"),
      },
      ingressIdentity: { device: expect.any(String), inode: expect.any(String) },
      popupIdentity: { device: expect.any(String), inode: expect.any(String) },
      receiptIdentity: { device: expect.any(String), inode: expect.any(String) },
    });
    expect(discoveries).toBe(0);
  });

  it("returns undefined for source, unsupported, receipt-less, and non-owned layouts", async () => {
    const fixture = await installedFixture();
    await expect(
      createChannel(fixture, {
        buildInfo: () => ({
          version: CURRENT_VERSION,
          compiled: false,
          buildIdentity: "a".repeat(64),
        }),
      }).detect(),
    ).resolves.toBeUndefined();
    await expect(createChannel(fixture, { platform: "win32" }).detect()).resolves.toBeUndefined();

    await unlink(fixture.receiptPath);
    await expect(createChannel(fixture).detect()).resolves.toBeUndefined();
    await writeFile(fixture.receiptPath, RECEIPT, { mode: 0o600 });

    await unlink(join(fixture.installDir, "stn-ingress"));
    await writeFile(join(fixture.installDir, "stn-ingress"), "not-a-link");
    await expect(createChannel(fixture).detect()).resolves.toBeUndefined();

    await unlink(join(fixture.installDir, "stn-ingress"));
    await symlink("stn", join(fixture.installDir, "stn-ingress"));
    await chmod(fixture.executablePath, 0o644);
    await expect(createChannel(fixture).detect()).resolves.toBeUndefined();
  });

  it("fails visibly for malformed present receipts", async () => {
    const fixture = await installedFixture();
    await writeFile(fixture.receiptPath, "wrong\n", { mode: 0o600 });
    await expect(createChannel(fixture).detect()).rejects.toMatchObject({
      code: "UPDATE_INSTALLATION_INVALID",
    });

    await writeFile(fixture.receiptPath, RECEIPT, { mode: 0o644 });
    await chmod(fixture.receiptPath, 0o644);
    await expect(createChannel(fixture).detect()).rejects.toMatchObject({
      code: "UPDATE_INSTALLATION_INVALID",
    });
  });

  it("requires the physical binary version to match the running build", async () => {
    const fixture = await installedFixture();
    await expect(
      createChannel(fixture, {
        commandRunner: versionRunner("different-version"),
      }).detect(),
    ).resolves.toBeUndefined();
  });

  it("plans forward publication only and reports current without downgrading", async () => {
    const fixture = await installedFixture();
    const update = createChannel(fixture);
    const detection = await requiredDetection(update);
    await expect(update.plan(detection)).resolves.toMatchObject({
      status: "update-available",
      channel: "installer-binary",
      current: { tag: CURRENT_TAG },
      target: { tag: TARGET_TAG },
    });

    const exactRelease = currentRelease();
    const exact = createChannel(fixture, {
      releaseDiscovery: fakeDiscovery(exactRelease, exactRelease),
    });
    await expect(exact.plan(await requiredDetection(exact))).resolves.toMatchObject({
      status: "current",
      target: exactRelease,
    });

    const newerCurrent = { ...exactRelease, publishedAt: "2026-09-01T00:00:00Z" };
    const downgrade = createChannel(fixture, {
      releaseDiscovery: fakeDiscovery(newerCurrent, targetRelease()),
    });
    await expect(downgrade.plan(await requiredDetection(downgrade))).resolves.toMatchObject({
      status: "current",
      target: newerCurrent,
    });
  });
});

describe("installer-binary apply", () => {
  it("binds the installer invocation to every identity and postchecks the replacement", async () => {
    const fixture = await installedFixture();
    const commands: ExternalCommandInput[] = [];
    const runner = installingRunner(fixture, commands);
    const channel = createChannel(fixture, { commandRunner: runner });
    const plan = await updatePlan(channel);

    const applied = await channel.apply(plan);
    expect(applied).toEqual({
      status: "installed",
      channel: "installer-binary",
      previousVersion: CURRENT_VERSION,
      installedVersion: TARGET_VERSION,
      executablePath: fixture.executablePath,
      successorCli: [fixture.executablePath],
      warnings: [],
    });

    const curls = commands.filter((command) => command.command === "curl");
    expect(curls).toHaveLength(2);
    expect(curls.every((command) => command.args?.[0] === "--disable")).toBe(true);
    expect(commands).toContainEqual(
      expect.objectContaining({
        command: "/bin/sh",
        args: [
          expect.stringContaining("/install.sh"),
          "--version",
          TARGET_TAG,
          "--install-dir",
          fixture.installDir,
          "--expected-installation",
          expect.stringContaining("/expected-installation"),
        ],
      }),
    );
    expect(await readlink(join(fixture.installDir, "stn-ingress"))).toBe("stn");
    expect(await readFile(fixture.receiptPath, "utf8")).toBe(RECEIPT);
    expect(await readdir(fixture.tempRoot)).toEqual([]);
  });

  it("rejects in-place content changes and replacement of either launcher or receipt", async () => {
    for (const changed of ["binary", "ingress", "popup", "receipt"] as const) {
      const fixture = await installedFixture();
      const commands: ExternalCommandInput[] = [];
      const channel = createChannel(fixture, {
        commandRunner: installingRunner(fixture, commands),
      });
      const plan = await updatePlan(channel);
      if (changed === "binary") {
        await writeFile(fixture.executablePath, "in-place-tamper", { mode: 0o755 });
      } else if (changed === "receipt") {
        await writeFile(fixture.receiptPath, "tampered\n", { mode: 0o600 });
      } else {
        const path = join(
          fixture.installDir,
          changed === "ingress" ? "stn-ingress" : "stn-tmux-popup",
        );
        await rename(path, `${path}.previous`);
        await symlink("stn", path);
      }

      await expect(channel.apply(plan)).rejects.toMatchObject({ code: "UPDATE_PLAN_STALE" });
      expect(commands.filter((command) => command.command === "curl")).toEqual([]);
    }
  });

  it("rejects stale identity after verification before invoking the installer", async () => {
    const fixture = await installedFixture();
    const commands: ExternalCommandInput[] = [];
    const runner = installingRunner(fixture, commands, {
      afterChecksums: () => writeFile(fixture.executablePath, "late-tamper", { mode: 0o755 }),
    });
    const channel = createChannel(fixture, { commandRunner: runner });
    const plan = await updatePlan(channel);

    await expect(channel.apply(plan)).rejects.toMatchObject({ code: "UPDATE_PLAN_STALE" });
    expect(commands.some(isInstallerInvocation)).toBe(false);
  });

  it("rejects altered and downgrade plans before release or installer work", async () => {
    const fixture = await installedFixture();
    const commands: ExternalCommandInput[] = [];
    const channel = createChannel(fixture, { commandRunner: installingRunner(fixture, commands) });
    const original = await updatePlan(channel);
    const variants: InstallerBinaryUpdatePlan[] = [
      { ...original, channel: "different" as typeof original.channel },
      { ...original, currentVersion: "1.2.3" },
      { ...original, installDir: `${original.installDir}-other` },
      { ...original, platform: otherTarget(original.platform) },
      { ...original, binaryIdentity: { ...original.binaryIdentity, inode: "0" } },
      { ...original, target: original.current },
    ];

    for (const variant of variants) {
      try {
        await channel.apply(variant);
        throw new Error("altered plan unexpectedly applied");
      } catch (error) {
        expect(["UPDATE_PLAN_INVALID", "UPDATE_PLAN_STALE"]).toContain(
          (error as { code?: string }).code,
        );
      }
    }
    expect(commands.filter((command) => command.command === "curl")).toEqual([]);
  });

  it("rejects invalid checksums, duplicate stamps, and shell syntax without mutation", async () => {
    for (const failure of ["checksum", "duplicate-stamp", "syntax"] as const) {
      const fixture = await installedFixture();
      const commands: ExternalCommandInput[] = [];
      const channel = createChannel(fixture, {
        commandRunner: installingRunner(fixture, commands, { failure }),
      });
      const plan = await updatePlan(channel);

      await expect(channel.apply(plan)).rejects.toMatchObject({
        code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
      });
      expect(await readFile(fixture.executablePath, "utf8")).toBe("current-binary");
      expect(await readdir(fixture.tempRoot)).toEqual([]);
    }
  });

  it("preserves cancellation through download, syntax, installer, and postcheck phases", async () => {
    for (const phase of ["download", "syntax", "installer", "postcheck"] as const) {
      const fixture = await installedFixture();
      const channel = createChannel(fixture, {
        commandRunner: installingRunner(fixture, [], { cancelAt: phase }),
      });
      const plan = await updatePlan(channel);
      await expect(channel.apply(plan)).rejects.toMatchObject({
        tag: "ExternalCommandError",
        code: "EXTERNAL_COMMAND_ABORTED",
      });
      expect(await readdir(fixture.tempRoot)).toEqual([]);
    }
  });

  it("returns installed with a warning when a failing installer actually committed", async () => {
    const fixture = await installedFixture();
    const channel = createChannel(fixture, {
      commandRunner: installingRunner(fixture, [], { installFailsAfterMutation: true }),
    });
    const report = await channel.apply(await updatePlan(channel));

    expect(report.status).toBe("installed");
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: "UPDATE_INSTALL_REPORTED_FAILURE",
        diagnosticDetails: [expect.objectContaining({ type: "external_command", exitCode: 1 })],
      }),
    ]);
  });

  it("retains installer failure when the postcheck also fails", async () => {
    const fixture = await installedFixture();
    const channel = createChannel(fixture, {
      commandRunner: installingRunner(fixture, [], { installFailsBeforeMutation: true }),
    });
    await expect(channel.apply(await updatePlan(channel))).rejects.toMatchObject({
      code: "UPDATE_INSTALL_FAILED",
      diagnosticDetails: [expect.objectContaining({ type: "external_command", exitCode: 1 })],
    });
  });

  it("reports cleanup as a warning and never masks a primary failure", async () => {
    const fixture = await installedFixture();
    const success = createChannel(fixture, {
      commandRunner: installingRunner(fixture, []),
      removeTempDir: async () => {
        throw new Error("cleanup failed");
      },
    });
    const successReport = await success.apply(await updatePlan(success));
    expect(successReport.warnings).toEqual([
      expect.objectContaining({ code: "UPDATE_CLEANUP_FAILED" }),
    ]);

    const secondFixture = await installedFixture();
    const failure = createChannel(secondFixture, {
      commandRunner: installingRunner(secondFixture, [], { failure: "checksum" }),
      removeTempDir: async () => {
        throw new Error("cleanup failed");
      },
    });
    await expect(failure.apply(await updatePlan(failure))).rejects.toMatchObject({
      code: "UPDATE_INSTALLER_VERIFICATION_FAILED",
      hint: expect.stringContaining("cleanup also failed"),
    });
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
    assets: assets.map((name, index) => ({ id: id * 100 + index + 1, name })),
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
  const base = `https://github.com/jeremy0dell/station/releases/download/${tag}`;
  return {
    tag,
    version,
    releaseId,
    publishedAt,
    assets: {
      installer: { name: "install.sh", url: `${base}/install.sh` },
      checksums: { name: "SHA256SUMS", url: `${base}/SHA256SUMS` },
      archive: Object.fromEntries(
        TARGETS.map((target) => {
          const name = `stn-v${version}-${target}.tar.gz`;
          return [target, { name, url: `${base}/${name}` }];
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
  const root = await mkdtemp(join(tmpdir(), "station-installer-update-test-"));
  tempRoots.push(root);
  const installDir = join(root, "bin");
  const tempRoot = join(root, "tmp");
  await Promise.all([mkdir(installDir), mkdir(tempRoot)]);
  const executablePath = join(installDir, "stn");
  const receiptPath = join(installDir, ".station-install-receipt");
  await writeFile(executablePath, "current-binary", { mode: 0o755 });
  await writeFile(receiptPath, RECEIPT, { mode: 0o600 });
  await Promise.all([
    symlink("stn", join(installDir, "stn-ingress")),
    symlink("stn", join(installDir, "stn-tmux-popup")),
  ]);
  return {
    root,
    installDir: await realpath(installDir),
    tempRoot: await realpath(tempRoot),
    executablePath: await realpath(executablePath),
    receiptPath: await realpath(receiptPath),
  };
}

function createChannel(
  fixture: Awaited<ReturnType<typeof installedFixture>>,
  overrides: Partial<InstallerBinaryUpdateChannelDeps> = {},
) {
  return createInstallerBinaryUpdateChannel({
    buildInfo: () => ({ version: CURRENT_VERSION, compiled: true, buildIdentity: "a".repeat(64) }),
    executablePath: fixture.executablePath,
    platform: process.platform,
    architecture: process.arch,
    releaseDiscovery: fakeDiscovery(currentRelease(), targetRelease()),
    commandRunner: versionRunner(CURRENT_VERSION),
    tempRoot: fixture.tempRoot,
    ...overrides,
  });
}

async function requiredDetection(channel: ReturnType<typeof createChannel>) {
  const detection = await channel.detect();
  if (detection === undefined) throw new Error("expected installer-binary detection");
  return detection;
}

async function updatePlan(channel: ReturnType<typeof createChannel>) {
  const plan = await channel.plan(await requiredDetection(channel));
  if (plan.status !== "update-available") throw new Error("expected update plan");
  return plan;
}

function versionRunner(version: string) {
  return async (input: ExternalCommandInput) => {
    if (input.args?.[0] !== "--version") throw new Error(`unexpected command ${input.command}`);
    return commandResult(input, version);
  };
}

function installerBody(tag: string, duplicateStamp = false) {
  return `#!/bin/sh\nembedded_version="${tag}"\n${duplicateStamp ? `embedded_version="${tag}"\n` : ""}exit 0\n`;
}

function installingRunner(
  fixture: Awaited<ReturnType<typeof installedFixture>>,
  commands: ExternalCommandInput[],
  options: {
    afterChecksums?: () => Promise<void>;
    cancelAt?: "download" | "syntax" | "installer" | "postcheck";
    failure?: "checksum" | "duplicate-stamp" | "syntax";
    installFailsAfterMutation?: boolean;
    installFailsBeforeMutation?: boolean;
  } = {},
) {
  let installedVersion = CURRENT_VERSION;
  let installerInvoked = false;
  return async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
    commands.push(input);
    if (input.command === "curl") {
      if (options.cancelAt === "download") throw abortError();
      const outputIndex = input.args?.indexOf("--output") ?? -1;
      const outputPath = input.args?.[outputIndex + 1];
      if (outputPath === undefined) throw new Error("missing curl output");
      const installer = installerBody(TARGET_TAG, options.failure === "duplicate-stamp");
      if (input.args?.at(-1)?.endsWith("/install.sh")) {
        await writeFile(outputPath, installer, { mode: 0o600 });
      } else {
        const checksum =
          options.failure === "checksum"
            ? "0".repeat(64)
            : createHash("sha256").update(installer).digest("hex");
        await writeFile(outputPath, `${checksum}  install.sh\n${"1".repeat(64)}  archive.tar.gz\n`);
        await options.afterChecksums?.();
      }
      return commandResult(input);
    }
    if (input.command === "/bin/sh" && input.args?.[0] === "-n") {
      if (options.cancelAt === "syntax") throw abortError();
      if (options.failure === "syntax") throw Object.assign(new Error("syntax"), { exitCode: 2 });
      return commandResult(input);
    }
    if (isInstallerInvocation(input)) {
      installerInvoked = true;
      if (options.cancelAt === "installer") throw abortError();
      const expectedPath = input.args?.at(-1);
      if (expectedPath === undefined) throw new Error("missing expected installation path");
      const expected = await readFile(expectedPath, "utf8");
      expect(
        expected
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=")[0]),
      ).toEqual([
        "format",
        "binary_sha256",
        "binary_device",
        "binary_inode",
        "ingress_device",
        "ingress_inode",
        "popup_device",
        "popup_inode",
        "receipt_device",
        "receipt_inode",
      ]);
      if (options.installFailsBeforeMutation === true) throw installerError();
      await replaceExecutable(fixture.executablePath, "target-binary");
      installedVersion = TARGET_VERSION;
      if (options.installFailsAfterMutation === true) throw installerError();
      return commandResult(input);
    }
    if (input.command === fixture.executablePath && input.args?.[0] === "--version") {
      if (installerInvoked && options.cancelAt === "postcheck") throw abortError();
      return commandResult(input, installedVersion);
    }
    throw new Error(`unexpected command: ${input.command} ${(input.args ?? []).join(" ")}`);
  };
}

function installerError() {
  return Object.assign(new Error("installer failed"), {
    exitCode: 1,
    stderr: "Station install warning: activation could not be proven",
  });
}

function abortError() {
  return Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORT_ERR" });
}

function isInstallerInvocation(input: ExternalCommandInput) {
  return input.command === "/bin/sh" && input.args?.[0]?.endsWith("/install.sh") === true;
}

async function replaceExecutable(executablePath: string, contents: string) {
  const replacement = `${executablePath}.replacement`;
  await writeFile(replacement, contents, { mode: 0o755 });
  await rename(replacement, executablePath);
}

function hostTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  return "linux-x64";
}

function otherTarget(target: (typeof TARGETS)[number]) {
  return TARGETS.find((candidate) => candidate !== target) ?? "linux-x64";
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
