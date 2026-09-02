import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExternalCommandInput,
  nodeExternalCommandRunner,
  runExternalCommand,
} from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeBinaryRelease } from "../../src/update/githubRelease.js";
import { createInstallerBinaryUpdateChannel } from "../../src/update/installerBinaryUpdate.js";

const CURRENT_TAG = "v0.7.1-rc.8";
const TARGET_TAG = "v0.0.0-pre-alpha.14.3";
const RECEIPT = "station-installer-binary-v1\n";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installer-binary channel with the real installer", () => {
  it("replaces the binary through install.sh while preserving launchers and receipt", async () => {
    const fixture = await realInstallerFixture();
    const beforeReceipt = await lstat(fixture.receiptPath, { bigint: true });
    const beforeIngress = await lstat(join(fixture.installDir, "stn-ingress"), { bigint: true });
    const channel = fixture.channel();
    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected installer-owned detection");
    const plan = await channel.plan(detection);
    if (plan.status !== "update-available") throw new Error("expected update plan");

    const report = await channel.apply(plan);

    expect(report).toMatchObject({
      status: "installed",
      previousVersion: CURRENT_TAG.slice(1),
      installedVersion: TARGET_TAG.slice(1),
      warnings: [],
    });
    expect(await executableVersion(fixture.executablePath)).toBe(TARGET_TAG.slice(1));
    expect(await readlink(join(fixture.installDir, "stn-ingress"))).toBe("stn");
    expect(await readlink(join(fixture.installDir, "stn-tmux-popup"))).toBe("stn");
    expect(await readFile(fixture.receiptPath, "utf8")).toBe(RECEIPT);
    const afterReceipt = await lstat(fixture.receiptPath, { bigint: true });
    const afterIngress = await lstat(join(fixture.installDir, "stn-ingress"), { bigint: true });
    expect([afterReceipt.dev, afterReceipt.ino]).toEqual([beforeReceipt.dev, beforeReceipt.ino]);
    expect([afterIngress.dev, afterIngress.ino]).toEqual([beforeIngress.dev, beforeIngress.ino]);
  });

  it("refuses an installation replaced at the invocation boundary", async () => {
    const fixture = await realInstallerFixture({ replaceIngressBeforeInstaller: true });
    const channel = fixture.channel();
    const detection = await channel.detect();
    if (detection === undefined) throw new Error("expected installer-owned detection");
    const plan = await channel.plan(detection);
    if (plan.status !== "update-available") throw new Error("expected update plan");

    await expect(channel.apply(plan)).rejects.toMatchObject({ code: "UPDATE_INSTALL_FAILED" });
    expect(await executableVersion(fixture.executablePath)).toBe(CURRENT_TAG.slice(1));
    expect(await readFile(fixture.receiptPath, "utf8")).toBe(RECEIPT);
  });
});

async function realInstallerFixture(options: { replaceIngressBeforeInstaller?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "station-installer-update-integration-"));
  tempRoots.push(root);
  const installDir = join(root, "bin");
  const dataHome = join(root, "data");
  const tempRoot = join(root, "tmp");
  const fakeBin = join(root, "fake-bin");
  const releaseDir = join(root, "release");
  const archiveSource = join(root, "archive-source");
  await Promise.all(
    [installDir, join(dataHome, "station"), tempRoot, fakeBin, releaseDir, archiveSource].map(
      (path) => mkdir(path, { recursive: true }),
    ),
  );

  const executablePath = join(installDir, "stn");
  const receiptPath = join(installDir, ".station-install-receipt");
  await writeExecutable(executablePath, versionScript(CURRENT_TAG.slice(1)));
  await Promise.all([
    symlink("stn", join(installDir, "stn-ingress")),
    symlink("stn", join(installDir, "stn-tmux-popup")),
    writeFile(receiptPath, RECEIPT, { mode: 0o600 }),
    writeFile(join(dataHome, "station", "LICENSE"), "old license\n", { mode: 0o644 }),
  ]);

  await writeExecutable(join(archiveSource, "stn"), versionScript(TARGET_TAG.slice(1)));
  await Promise.all([
    symlink("stn", join(archiveSource, "stn-ingress")),
    symlink("stn", join(archiveSource, "stn-tmux-popup")),
    writeFile(join(archiveSource, "LICENSE"), "target license\n", { mode: 0o644 }),
  ]);
  const target = hostTarget();
  const archiveName = `stn-v${TARGET_TAG.slice(1)}-${target}.tar.gz`;
  const archivePath = join(releaseDir, archiveName);
  await runExternalCommand({
    command: "tar",
    args: ["-czf", archivePath, "stn", "stn-ingress", "stn-tmux-popup", "LICENSE"],
    cwd: archiveSource,
  });

  const sourceInstaller = await readFile(join(process.cwd(), "scripts", "install.sh"), "utf8");
  const installer = sourceInstaller.replace(
    'embedded_version=""',
    `embedded_version="${TARGET_TAG}"`,
  );
  if (installer === sourceInstaller) throw new Error("installer stamp marker missing");
  const installerPath = join(releaseDir, "install.sh");
  await writeFile(installerPath, installer, { mode: 0o700 });
  const checksumsPath = join(releaseDir, "SHA256SUMS");
  await writeFile(
    checksumsPath,
    `${await sha256(installerPath)}  install.sh\n${await sha256(archivePath)}  ${archiveName}\n`,
  );

  const fakeCurl = join(fakeBin, "curl");
  await writeExecutable(
    fakeCurl,
    `#!/bin/sh
set -eu
output=""
want_output=0
url=""
for arg do
  if [ "$want_output" -eq 1 ]; then output=$arg; want_output=0; continue; fi
  case "$arg" in
    --output) want_output=1 ;;
    http://*|https://*) url=$arg ;;
  esac
done
case "$url" in
  */install.sh) source_file=$FIXTURE_INSTALLER ;;
  */SHA256SUMS) source_file=$FIXTURE_CHECKSUMS ;;
  */${archiveName}) source_file=$FIXTURE_ARCHIVE ;;
  *) printf 'unexpected URL: %s\n' "$url" >&2; exit 22 ;;
esac
if [ -n "$output" ]; then cp "$source_file" "$output"; else cat "$source_file"; fi
`,
  );

  let replaced = false;
  const commandRunner = async (input: ExternalCommandInput) => {
    const installerInvocation =
      input.command === "/bin/sh" &&
      input.args?.[0]?.endsWith("/install.sh") === true &&
      input.args?.[0] !== "-n";
    if (installerInvocation && options.replaceIngressBeforeInstaller === true && !replaced) {
      const ingressPath = join(installDir, "stn-ingress");
      await rename(ingressPath, `${ingressPath}.previous`);
      await symlink("stn", ingressPath);
      replaced = true;
    }
    const environment = {
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: root,
      XDG_DATA_HOME: dataHome,
      TMPDIR: tempRoot,
      FIXTURE_INSTALLER: installerPath,
      FIXTURE_CHECKSUMS: checksumsPath,
      FIXTURE_ARCHIVE: archivePath,
    };
    return nodeExternalCommandRunner({
      ...input,
      command: input.command === "curl" ? fakeCurl : input.command,
      env: { ...input.env, ...environment },
    });
  };

  const current = release(CURRENT_TAG, 8, "2026-07-01T00:00:00Z");
  const latest = release(TARGET_TAG, 42, "2026-08-01T00:00:00Z");
  return {
    installDir: await realpath(installDir),
    executablePath: await realpath(executablePath),
    receiptPath: await realpath(receiptPath),
    channel: () =>
      createInstallerBinaryUpdateChannel({
        buildInfo: () => ({
          version: CURRENT_TAG.slice(1),
          compiled: true,
          buildIdentity: "a".repeat(64),
        }),
        executablePath,
        platform: process.platform,
        architecture: process.arch,
        releaseDiscovery: { resolve: async () => ({ current, latest }) },
        commandRunner,
        tempRoot,
      }),
  };
}

function release(tag: string, releaseId: number, publishedAt: string): NativeBinaryRelease {
  const version = tag.slice(1);
  const base = `https://github.com/jeremy0dell/station/releases/download/${tag}`;
  const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
  return {
    tag,
    version,
    releaseId,
    publishedAt,
    assets: {
      installer: { name: "install.sh", url: `${base}/install.sh` },
      checksums: { name: "SHA256SUMS", url: `${base}/SHA256SUMS` },
      archive: Object.fromEntries(
        targets.map((target) => {
          const name = `stn-v${version}-${target}.tar.gz`;
          return [target, { name, url: `${base}/${name}` }];
        }),
      ) as NativeBinaryRelease["assets"]["archive"],
    },
  };
}

function hostTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  return "linux-x64";
}

function versionScript(version: string) {
  return `#!/bin/sh\nprintf '%s\\n' '${version}'\n`;
}

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function executableVersion(path: string) {
  return (await runExternalCommand({ command: path, args: ["--version"] })).stdout.trim();
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
