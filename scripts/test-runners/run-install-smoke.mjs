#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const inheritedUmask = process.umask(0o077);
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const installer = join(repoRoot, "scripts", "install.sh");
const root = mkdtempSync(join(tmpdir(), "station-install-smoke-"));
const releasesDir = join(root, "releases");
const fakeBinDir = join(root, "bin");
const homeDir = join(root, "home");
const dataDir = join(root, "data");
const tempDir = join(root, "tmp");
const ghLogsDir = join(root, "gh-logs");
const stableTag = "v1.2.3";
const rollbackTag = "v1.2.3-rc.1";
const activeChildren = new Set();
let invocationCount = 0;

const platforms = [
  { system: "Darwin", machine: "arm64", target: "darwin-arm64" },
  { system: "Darwin", machine: "x86_64", target: "darwin-x64" },
  { system: "Linux", machine: "aarch64", target: "linux-arm64" },
  { system: "Linux", machine: "x86_64", target: "linux-x64" },
];

try {
  prepareFixtures();
  await scenarioPlatformInstalls();
  await scenarioExplicitRollbackAndDraft();
  await scenarioAuthenticatedReleaseValidation();
  await scenarioStrictVersionValidation();
  await scenarioHostileUmaskModes();
  await scenarioPathResolutionAndFilesystemFailures();
  await scenarioProbeDeadline();
  await scenarioDestinationLock();
  await scenarioCommitFailures();
  await scenarioCaughtSignals();
  await scenarioSignalDuringLockAcquisition();
  await scenarioSigkillLeavesActionableLock();
  scenarioHelp();
  process.stdout.write("install smoke passed\n");
} finally {
  await stopActiveChildren();
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
  process.umask(inheritedUmask);
}

function prepareFixtures() {
  for (const path of [releasesDir, fakeBinDir, homeDir, dataDir, tempDir, ghLogsDir]) {
    makeDirectory(path);
  }
  writeFakeCommands();

  createRelease(
    stableTag,
    platforms.map(({ target }) => target),
  );
  createRelease(rollbackTag, ["linux-x64"]);
  createRelease("v1.2.4", ["linux-x64"], { corruptChecksum: true });
  createRelease("v1.2.5", ["linux-x64"], { extraMember: "postinstall" });
  createRelease("v1.2.6", ["linux-x64"], { probeMode: "fail" });
  createRelease("v1.2.7", ["linux-x64"], { probeMode: "hang" });
  createRelease("v1.2.8", ["linux-x64"], { probeMode: "gate" });
}

function scenarioPlatformInstalls() {
  for (const platform of platforms) {
    const installDir = join(root, `install-${platform.target}`);
    const result = runInstaller({ installDir, platform });
    assertSuccess(result, `${platform.target} latest install`);
    assertInstalled({ installDir, tag: stableTag, target: platform.target });
    assertIncludes(result.stdout, `Add ${installDir} to PATH`, `${platform.target} PATH hint`);
    assertNoInstallerResidue(installDir, dataDir);
  }
}

function scenarioExplicitRollbackAndDraft() {
  const rollbackDir = join(root, "rollback-bin");
  assertSuccess(
    runInstaller({
      installDir: rollbackDir,
      platform: linuxX64(),
      version: stableTag,
      includeInstallDirOnPath: true,
    }),
    "explicit stable install",
  );
  const rollback = runInstaller({
    installDir: rollbackDir,
    platform: linuxX64(),
    version: rollbackTag,
    includeInstallDirOnPath: true,
  });
  assertSuccess(rollback, "explicit prerelease rollback");
  assertInstalled({ installDir: rollbackDir, tag: rollbackTag, target: "linux-x64" });
  assertNotIncludes(rollback.stdout, "Add ", "PATH hint when install directory is present");

  const draftDir = join(root, "draft-bin");
  const draft = runInstaller({
    installDir: draftDir,
    platform: linuxX64(),
    version: rollbackTag,
    releaseId: "42",
  });
  assertSuccess(draft, "draft release ID install");
  assertInstalled({ installDir: draftDir, tag: rollbackTag, target: "linux-x64" });
}

function scenarioAuthenticatedReleaseValidation() {
  const installDir = join(root, "preserved-bin");
  makeDirectory(installDir);
  const binary = join(installDir, "stn");
  writeText(binary, "existing installation\n", 0o755);

  const failures = [
    {
      label: "checksum rejection",
      expected: "checksum verification failed",
      options: { version: "v1.2.4" },
    },
    {
      label: "unexpected archive member",
      expected: "exact Station release manifest",
      options: { version: "v1.2.5" },
    },
    {
      label: "binary compatibility probe",
      expected: "cannot run on this system",
      options: { version: "v1.2.6" },
    },
    {
      label: "duplicate asset rejection",
      expected: "exactly one",
      options: { version: stableTag, duplicateArchiveAsset: true },
    },
    {
      label: "duplicate draft asset rejection",
      expected: "exactly one",
      options: {
        version: stableTag,
        releaseId: "42",
        duplicateArchiveAsset: true,
      },
    },
    {
      label: "duplicate draft release",
      expected: "no single draft matched",
      options: { version: stableTag, releaseId: "42", duplicateDraftRelease: true },
    },
    {
      label: "draft tag mismatch",
      expected: "no single draft matched",
      options: { version: stableTag, releaseId: "42", releaseIdTag: rollbackTag },
    },
    {
      label: "published release ID refusal",
      expected: "no single draft matched",
      options: { version: stableTag, releaseId: "42", releaseDraft: false },
    },
    {
      label: "invalid draft release ID",
      expected: "must be a numeric",
      options: { version: stableTag, releaseId: "draft-42" },
    },
    {
      label: "authentication failure",
      expected: "gh auth login",
      options: { auth: false },
    },
    {
      label: "unsupported platform",
      expected: "unsupported platform",
      options: {
        platform: { system: "FreeBSD", machine: "x86_64", target: "unsupported" },
      },
    },
  ];

  for (const { expected, label, options } of failures) {
    const result = runInstaller({ installDir, platform: linuxX64(), ...options });
    assertFailure(result, expected, label);
    assertEqual(readFileSync(binary, "utf8"), "existing installation\n", `${label} preservation`);
    assertNoInstallerResidue(installDir, dataDir);
  }
}

function scenarioStrictVersionValidation() {
  const installDir = join(root, "invalid-versions-bin");
  const invalidVersions = [
    "",
    "1.2.3",
    "v01.2.3",
    "v1.2.3+build.1",
    "v1.2.3 ",
    "v1.2.3\r",
    "v1.2.3\nv9.9.9",
  ];

  for (const version of invalidVersions) {
    const result = runInstaller({ installDir, platform: linuxX64(), version });
    assertFailure(result, "v-prefixed SemVer", `invalid version ${JSON.stringify(version)}`);
    assertEqual(ghCalls(result).length, 0, `invalid version ${JSON.stringify(version)} gh calls`);
  }

  const duplicateEmpty = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "",
    extraArguments: ["--version", stableTag],
  });
  assertFailure(duplicateEmpty, "only once", "duplicate version after empty value");
  assertEqual(ghCalls(duplicateEmpty).length, 0, "duplicate version after empty value gh calls");

  for (const apiTag of ["v1.2.3\nv9.9.9", "v1.2.3\n"]) {
    const apiResult = runInstaller({
      installDir,
      platform: linuxX64(),
      environment: { FAKE_LATEST_TAG: apiTag },
    });
    assertFailure(apiResult, "invalid tag", `invalid latest API tag ${JSON.stringify(apiTag)}`);
    assertEqual(
      ghCalls(apiResult).filter((call) => call.startsWith("api ")).length,
      1,
      `invalid latest API tag ${JSON.stringify(apiTag)} stops after lookup`,
    );
  }
}

function scenarioHostileUmaskModes() {
  const installDir = join(root, "hostile-umask-bin");
  const dataHome = join(root, "hostile-umask-data");
  for (const version of [stableTag, rollbackTag]) {
    const result = runInstaller({
      installDir,
      platform: linuxX64(),
      version,
      dataHome,
      umask: "0777",
    });
    assertSuccess(result, `${version} install under umask 0777`);
    assertInstalled({ installDir, dataHome, tag: version, target: "linux-x64" });
    assertMode(join(installDir, "stn"), 0o755, `${version} binary mode`);
    assertMode(join(dataHome, "station", "LICENSE"), 0o644, `${version} license mode`);
    assertNoInstallerResidue(installDir, dataHome);
  }
}

function scenarioPathResolutionAndFilesystemFailures() {
  const noHomeBin = join(root, "no-home-bin");
  const noHomeData = join(root, "no-home-data");
  const noHome = runInstaller({
    installDir: noHomeBin,
    platform: linuxX64(),
    dataHome: noHomeData,
    environment: { HOME: undefined },
  });
  assertSuccess(noHome, "explicit install and XDG paths without HOME");
  assertInstalled({
    installDir: noHomeBin,
    dataHome: noHomeData,
    tag: stableTag,
    target: "linux-x64",
  });

  const relativeCwd = join(root, "relative-path-cwd");
  makeDirectory(relativeCwd);
  const relative = runInstaller({
    installDir: "-station-bin",
    platform: linuxX64(),
    cwd: relativeCwd,
    dataHome: "-station-data",
    environment: { HOME: undefined },
  });
  assertSuccess(relative, "relative leading-dash paths");
  assertInstalled({
    installDir: join(relativeCwd, "-station-bin"),
    dataHome: join(relativeCwd, "-station-data"),
    tag: stableTag,
    target: "linux-x64",
  });

  const unusualCwd = join(root, "path with spaces\nand newline");
  makeDirectory(unusualCwd);
  const unusualInstall = join(unusualCwd, "station bin\ncommands\n");
  const unusualData = join(unusualCwd, "station data\nfiles\n");
  const unusual = runInstaller({
    installDir: unusualInstall,
    platform: linuxX64(),
    cwd: unusualCwd,
    dataHome: unusualData,
    environment: { HOME: undefined },
  });
  assertSuccess(unusual, "paths containing spaces and newlines");
  assertInstalled({
    installDir: unusualInstall,
    dataHome: unusualData,
    tag: stableTag,
    target: "linux-x64",
  });

  const newlineLinkDir = join(root, "newline-link-bin");
  const newlineLinkData = join(root, "newline-link-data");
  seedInstallation({
    installDir: newlineLinkDir,
    dataHome: newlineLinkData,
    tag: "v0.9.0",
    withAliases: false,
  });
  symlinkSync("stn\n", join(newlineLinkDir, "stn-ingress"));
  const newlineLink = runInstaller({
    installDir: newlineLinkDir,
    platform: linuxX64(),
    dataHome: newlineLinkData,
  });
  assertFailure(newlineLink, "existing launcher", "newline launcher target");
  assertNoGhApiCalls(newlineLink, "newline launcher target");
  assertEqual(
    readlinkSync(join(newlineLinkDir, "stn-ingress")),
    "stn\n",
    "newline launcher target remains untouched",
  );
  const newlineLinkRuntime = spawnSync(join(newlineLinkDir, "stn"), ["--version"], {
    encoding: "utf8",
  });
  assertSuccess(newlineLinkRuntime, "newline launcher runtime preservation");
  assertEqual(newlineLinkRuntime.stdout, "0.9.0\n", "newline launcher runtime version");
  assertLicense(newlineLinkData, "v0.9.0", "newline launcher license preservation");
  assertNoInstallerResidue(newlineLinkDir, newlineLinkData);

  const readOnlyDir = join(root, "read-only-bin");
  const readOnlyData = join(root, "read-only-data");
  seedInstallation({ installDir: readOnlyDir, dataHome: readOnlyData, tag: "v0.9.0" });
  chmodSync(readOnlyDir, 0o500);
  try {
    const readOnly = runInstaller({
      installDir: readOnlyDir,
      platform: linuxX64(),
      dataHome: readOnlyData,
    });
    assertFailure(readOnly, "lock", "read-only destination");
    assertRuntimeVersion(readOnlyDir, "v0.9.0", "read-only destination preservation");
  } finally {
    chmodSync(readOnlyDir, 0o700);
  }
}

async function scenarioProbeDeadline() {
  const installDir = join(root, "probe-timeout-bin");
  const dataHome = join(root, "probe-timeout-data");
  const pidFile = join(root, "probe-timeout.pid");
  const clockBin = join(root, "watchdog-clock-bin");
  makeDirectory(clockBin);
  writeExecutable(
    join(clockBin, "sleep"),
    [
      "#!/bin/sh",
      `case "\${1:-}" in`,
      '  10) while [ ! -e "$FAKE_PROBE_PID_FILE" ]; do /bin/sleep 0.01; done; exec /bin/sleep 0.05 ;;',
      "  1) exec /bin/sleep 0.05 ;;",
      '  *) exec /bin/sleep "$@" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  seedInstallation({ installDir, dataHome, tag: stableTag });

  const startedAt = Date.now();
  const running = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.7",
    dataHome,
    commandBinDirs: [clockBin],
    environment: { FAKE_PROBE_PID_FILE: pidFile },
    asynchronous: true,
  });
  const result = await settleWithin(running, 5_000, "hanging compatibility probe");
  assertFailure(result, "did not respond", "hanging compatibility probe");
  assertIncludes(result.stderr, "10 seconds", "probe timeout duration");
  assertIncludes(result.stderr, "unchanged", "probe timeout preservation UX");
  assert(Date.now() - startedAt < 5_000, "probe timeout was bounded by the clock shim");
  assertRuntimeVersion(installDir, stableTag, "probe timeout runtime preservation");
  assertLicense(dataHome, stableTag, "probe timeout license preservation");
  assertProcessGone(Number(readFileSync(pidFile, "utf8")), "timed-out probe child");
  assertNoInstallerResidue(installDir, dataHome);
}

async function scenarioDestinationLock() {
  const installDir = join(root, "concurrent-bin");
  const dataHome = join(root, "concurrent-data");
  const probePid = join(root, "concurrent-probe.pid");
  const releaseFile = join(root, "concurrent-probe.release");
  seedInstallation({ installDir, dataHome, tag: stableTag });

  const first = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.8",
    dataHome,
    environment: {
      FAKE_PROBE_PID_FILE: probePid,
      FAKE_PROBE_RELEASE_FILE: releaseFile,
    },
    asynchronous: true,
  });
  await waitForPath(probePid, "first installer probe");
  const lockPath = join(installDir, ".station-install.lock");
  await waitForPath(lockPath, "destination lock");
  assertEqual(
    readFileSync(join(lockPath, "owner"), "utf8"),
    `pid=${first.child.pid}\nrequested=v1.2.8\n`,
    "destination lock owner",
  );

  const second = runInstaller({ installDir, platform: linuxX64(), dataHome });
  assertFailure(second, lockPath, "concurrent installer lock refusal");
  assertIncludes(second.stderr, String(first.child.pid), "concurrent lock owner PID");
  assertIncludes(second.stderr, "unchanged", "concurrent lock preservation UX");
  assertNoGhApiCalls(second, "concurrent installer lock refusal");
  assertRuntimeVersion(installDir, stableTag, "runtime while installer is locked");

  writeText(releaseFile, "release\n", 0o600);
  const firstResult = await settleWithin(first, 5_000, "first concurrent installer");
  assertSuccess(firstResult, "first concurrent installer");
  assertInstalled({ installDir, dataHome, tag: "v1.2.8", target: "linux-x64" });

  const retry = runInstaller({
    installDir,
    platform: linuxX64(),
    version: rollbackTag,
    dataHome,
  });
  assertSuccess(retry, "retry after concurrent install");
  assertInstalled({ installDir, dataHome, tag: rollbackTag, target: "linux-x64" });
  assertNoInstallerResidue(installDir, dataHome);
}

function scenarioCommitFailures() {
  const cases = [
    { command: "ln", destination: "stn-ingress", label: "ingress alias commit" },
    { command: "ln", destination: "stn-tmux-popup", label: "popup alias commit" },
    { command: "mv", destination: "LICENSE", label: "license commit" },
    { command: "mv", destination: "stn", label: "runtime commit" },
  ];

  for (const testCase of cases) {
    const slug = testCase.label.replaceAll(" ", "-");
    const installDir = join(root, `${slug}-bin`);
    const dataHome = join(root, `${slug}-data`);
    const withAliases = testCase.command !== "ln";
    seedInstallation({ installDir, dataHome, tag: "v0.9.0", withAliases });
    const destination =
      testCase.destination === "LICENSE"
        ? join(dataHome, "station", "LICENSE")
        : join(installDir, testCase.destination);
    const shim = makeFailOnceShim(testCase.command, destination, slug);

    const failed = runInstaller({
      installDir,
      platform: linuxX64(),
      version: stableTag,
      dataHome,
      commandBinDirs: [shim.directory],
      environment: shim.environment,
    });
    assertNonzero(failed, `${testCase.label} failure injection`);
    assertRuntimeVersion(installDir, "v0.9.0", `${testCase.label} runtime rollback`, {
      aliases: withAliases,
    });
    assertLicense(dataHome, "v0.9.0", `${testCase.label} license rollback`);
    assertNoInstallerResidue(installDir, dataHome);

    const retry = runInstaller({
      installDir,
      platform: linuxX64(),
      version: stableTag,
      dataHome,
    });
    assertSuccess(retry, `${testCase.label} retry`);
    assertInstalled({ installDir, dataHome, tag: stableTag, target: "linux-x64" });
  }
}

async function scenarioCaughtSignals() {
  const phases = ["download", "probe", "finalization"];
  const signals = [
    { name: "SIGINT", status: 130 },
    { name: "SIGTERM", status: 143 },
  ];

  for (const phase of phases) {
    for (const signal of signals) {
      await runSignalScenario(phase, signal);
    }
  }
}

async function runSignalScenario(phase, signal) {
  const slug = `${phase}-${signal.name.toLowerCase()}`;
  const installDir = join(root, `${slug}-bin`);
  const dataHome = join(root, `${slug}-data`);
  const marker = join(root, `${slug}.ready`);
  const releaseFile = join(root, `${slug}.release`);
  const options = {
    installDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome,
    asynchronous: true,
    environment: {},
    commandBinDirs: [],
  };
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });

  if (phase === "download") {
    options.environment = {
      FAKE_GH_BLOCK_DOWNLOAD: "1",
      FAKE_BLOCK_MARKER: marker,
      FAKE_BLOCK_RELEASE: releaseFile,
    };
  } else if (phase === "probe") {
    options.version = "v1.2.8";
    options.environment = {
      FAKE_PROBE_PID_FILE: marker,
      FAKE_PROBE_RELEASE_FILE: releaseFile,
    };
  } else {
    const shim = makeBlockingShim("mv", join(installDir, "stn"), marker);
    options.commandBinDirs = [shim.directory];
    options.environment = shim.environment;
  }

  const running = runInstaller(options);
  await waitForPath(marker, `${phase} ${signal.name} injection point`);
  signalProcessGroup(running.child, signal.name);
  const result = await settleWithin(running, 5_000, `${phase} ${signal.name}`);
  assertSignalStatus(result, signal, `${phase} ${signal.name}`);
  assertRuntimeVersion(installDir, "v0.9.0", `${phase} ${signal.name} runtime coherence`);
  assertLicense(dataHome, "v0.9.0", `${phase} ${signal.name} license rollback`);
  assertNoInstallerResidue(installDir, dataHome);
}

async function scenarioSignalDuringLockAcquisition() {
  const installDir = join(root, "lock-signal-bin");
  const dataHome = join(root, "lock-signal-data");
  const marker = join(root, "lock-signal.ready");
  const releaseFile = join(root, "lock-signal.release");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
  const shim = makeLockAcquisitionShim(
    join(installDir, ".station-install.lock"),
    marker,
    releaseFile,
  );
  const running = runInstaller({
    installDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome,
    asynchronous: true,
    commandBinDirs: [shim.directory],
    environment: shim.environment,
  });

  await waitForPath(marker, "signal during lock acquisition");
  running.child.kill("SIGTERM");
  writeText(releaseFile, "release\n", 0o600);
  const result = await settleWithin(running, 5_000, "signal during lock acquisition");
  assertSignalStatus(result, { name: "SIGTERM", status: 143 }, "signal during lock acquisition");
  assertRuntimeVersion(installDir, "v0.9.0", "lock acquisition signal runtime coherence");
  assertLicense(dataHome, "v0.9.0", "lock acquisition signal license preservation");
  assertNoInstallerResidue(installDir, dataHome);
}

async function scenarioSigkillLeavesActionableLock() {
  const installDir = join(root, "sigkill-bin");
  const dataHome = join(root, "sigkill-data");
  const probePid = join(root, "sigkill-probe.pid");
  const releaseFile = join(root, "sigkill-probe.release");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });

  const killed = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.8",
    dataHome,
    environment: {
      FAKE_PROBE_PID_FILE: probePid,
      FAKE_PROBE_RELEASE_FILE: releaseFile,
    },
    asynchronous: true,
  });
  await waitForPath(probePid, "SIGKILL probe");
  const lockPath = join(installDir, ".station-install.lock");
  await waitForPath(lockPath, "SIGKILL-owned lock");
  signalProcessGroup(killed.child, "SIGKILL");
  const killedResult = await settleWithin(killed, 5_000, "SIGKILL installer");
  assertEqual(killedResult.signal, "SIGKILL", "SIGKILL installer signal");
  assert(existsSync(lockPath), "SIGKILL leaves the owned destination lock");
  assertRuntimeVersion(installDir, "v0.9.0", "SIGKILL runtime coherence");

  const refused = runInstaller({ installDir, platform: linuxX64(), dataHome });
  assertFailure(refused, lockPath, "stale lock refusal");
  assertIncludes(refused.stderr, String(killed.child.pid), "stale lock owner PID");
  assertIncludes(refused.stderr, "manually", "stale lock manual recovery UX");
  assertIncludes(refused.stderr, "retry", "stale lock retry UX");
  assertNoGhApiCalls(refused, "stale lock refusal");

  rmSync(lockPath, { recursive: true });
  writeText(releaseFile, "release\n", 0o600);
  const retry = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.8",
    dataHome,
    environment: {
      FAKE_PROBE_PID_FILE: probePid,
      FAKE_PROBE_RELEASE_FILE: releaseFile,
    },
  });
  assertSuccess(retry, "manual stale-lock removal retry");
  assertInstalled({ installDir, dataHome, tag: "v1.2.8", target: "linux-x64" });
}

function scenarioHelp() {
  const help = spawnSync("/bin/sh", [installer, "--help"], { encoding: "utf8" });
  assertSuccess(help, "installer help");
  assertIncludes(help.stdout, "--install-dir", "installer help options");
}

function linuxX64() {
  return platforms.find(({ target }) => target === "linux-x64");
}

function createRelease(tag, targets, options = {}) {
  const releaseDir = join(releasesDir, tag);
  makeDirectory(releaseDir);
  const checksums = [];

  for (const target of targets) {
    const version = tag.slice(1);
    const archiveName = `stn-v${version}-${target}.tar.gz`;
    const archivePath = join(releaseDir, archiveName);
    const payloadDir = join(root, `payload-${version}-${target}`);
    rmSync(payloadDir, { recursive: true, force: true });
    makeDirectory(payloadDir);
    writeReleaseBinary(join(payloadDir, "stn"), { tag, target, mode: options.probeMode });
    symlinkSync("stn", join(payloadDir, "stn-ingress"));
    symlinkSync("stn", join(payloadDir, "stn-tmux-popup"));
    writeText(join(payloadDir, "LICENSE"), `Station fixture license ${tag}\n`, 0o644);

    const members = ["stn", "stn-ingress", "stn-tmux-popup", "LICENSE"];
    if (options.extraMember !== undefined) {
      writeText(join(payloadDir, options.extraMember), "unapproved archive payload\n", 0o755);
      members.push(options.extraMember);
    }
    spawnChecked("tar", ["-czf", archivePath, "-C", payloadDir, ...members], "fixture archive");
    chmodSync(archivePath, 0o600);
    const hash = options.corruptChecksum
      ? "0".repeat(64)
      : createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    checksums.push(`${hash}  ${archiveName}`);
  }

  writeText(join(releaseDir, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`, 0o600);
}

function writeReleaseBinary(path, { mode, tag, target }) {
  const version = tag.slice(1);
  let versionBody = `printf '%s\\n' '${version}'`;
  if (mode === "fail") versionBody = "exit 126";
  if (mode === "hang") {
    versionBody = [
      'printf \'%s\\n\' "$$" > "$FAKE_PROBE_PID_FILE"',
      'chmod 600 "$FAKE_PROBE_PID_FILE"',
      "trap '' HUP INT TERM",
      "while :; do /bin/sleep 0.02; done",
    ].join("\n  ");
  }
  if (mode === "gate") {
    versionBody = [
      `if [ -n "\${FAKE_PROBE_RELEASE_FILE:-}" ]; then`,
      '  printf \'%s\\n\' "$$" > "$FAKE_PROBE_PID_FILE"',
      '  chmod 600 "$FAKE_PROBE_PID_FILE"',
      "  trap 'exit 129' HUP",
      "  trap 'exit 130' INT",
      "  trap 'exit 143' TERM",
      '  while [ ! -e "$FAKE_PROBE_RELEASE_FILE" ]; do /bin/sleep 0.02; done',
      "fi",
      `printf '%s\\n' '${version}'`,
    ].join("\n  ");
  }

  writeExecutable(
    path,
    `#!/bin/sh
if [ "\${1:-}" = --version ]; then
  ${versionBody}
else
  printf '%s\\n' 'Station ${tag} ${target}'
fi
`,
  );
}

function writeFakeCommands() {
  writeExecutable(
    join(fakeBinDir, "uname"),
    [
      "#!/bin/sh",
      `case "\${1:-}" in`,
      "  -s) printf '%s\\n' \"$FAKE_UNAME_S\" ;;",
      "  -m) printf '%s\\n' \"$FAKE_UNAME_M\" ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(fakeBinDir, "gh"),
    [
      "#!/bin/sh",
      "set -eu",
      'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
      'chmod 600 "$FAKE_GH_LOG"',
      '[ "$GH_HOST" = github.com ] || exit 3',
      `if [ "\${1:-}" = auth ]; then`,
      `  [ "\${FAKE_GH_AUTH:-1}" = 1 ]`,
      "  exit",
      "fi",
      `[ "\${1:-}" = api ] || exit 2`,
      "shift",
      'endpoint=""',
      'jq_filter=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      "    -H) shift 2 ;;",
      "    --paginate) shift ;;",
      "    --jq) jq_filter=$2; shift 2 ;;",
      "    *) endpoint=$1; shift ;;",
      "  esac",
      "done",
      'case "$endpoint" in',
      "  */releases/latest)",
      '    [ "$jq_filter" = .tag_name ] || exit 2',
      "    printf '%s\\n' \"$FAKE_LATEST_TAG\"",
      "    ;;",
      "  */releases/tags/*)",
      `    [ "\${endpoint##*/}" = "$FAKE_TAG" ] || exit 1`,
      '    case "$jq_filter" in',
      "      *SHA256SUMS*) printf '2\\n' ;;",
      '      *"$FAKE_ARCHIVE"*)',
      `        if [ "\${FAKE_DUPLICATE_ARCHIVE:-0}" = 1 ]; then`,
      "          printf '1\\n3\\n'",
      "        else",
      "          printf '1\\n'",
      "        fi",
      "        ;;",
      "    esac",
      "    ;;",
      "  */releases?per_page=100)",
      '    case "$jq_filter" in *".draft == true"*) ;; *) exit 2 ;; esac',
      `    [ "\${FAKE_RELEASE_DRAFT:-1}" = 1 ] || exit 0`,
      '    [ "$FAKE_RELEASE_ID_TAG" = "$FAKE_TAG" ] || exit 0',
      '    case "$jq_filter" in',
      '      *"$FAKE_ARCHIVE"*)',
      `        if [ "\${FAKE_DUPLICATE_ARCHIVE:-0}" = 1 ]; then printf '1\\n3\\n'; else printf '1\\n'; fi`,
      "        ;;",
      "      *SHA256SUMS*) printf '2\\n' ;;",
      "      *)",
      "        printf '%s\\n' \"$FAKE_RELEASE_ID\"",
      `        if [ "\${FAKE_DUPLICATE_RELEASE:-0}" = 1 ]; then printf '%s\\n' "$FAKE_RELEASE_ID"; fi`,
      "        ;;",
      "    esac",
      "    ;;",
      "  */releases/assets/1)",
      `    if [ "\${FAKE_GH_BLOCK_DOWNLOAD:-0}" = 1 ]; then`,
      '      : > "$FAKE_BLOCK_MARKER"',
      '      chmod 600 "$FAKE_BLOCK_MARKER"',
      "      trap 'exit 129' HUP",
      "      trap 'exit 130' INT",
      "      trap 'exit 143' TERM",
      '      while [ ! -e "$FAKE_BLOCK_RELEASE" ]; do /bin/sleep 0.02; done',
      "    fi",
      '    cat "$FAKE_RELEASES/$FAKE_TAG/$FAKE_ARCHIVE"',
      "    ;;",
      '  */releases/assets/2) cat "$FAKE_RELEASES/$FAKE_TAG/SHA256SUMS" ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
}

function runInstaller({
  installDir,
  platform,
  version,
  auth = true,
  duplicateArchiveAsset = false,
  duplicateDraftRelease = false,
  includeInstallDirOnPath = false,
  releaseId,
  releaseDraft = true,
  releaseIdTag,
  childShell = "/bin/sh",
  cwd = repoRoot,
  dataHome = dataDir,
  environment = {},
  umask,
  asynchronous = false,
  commandBinDirs = [],
  extraArguments = [],
}) {
  const tag = version ?? stableTag;
  const archive = `stn-${tag}-${platform.target}.tar.gz`;
  const commandPath = [...commandBinDirs, fakeBinDir, "/usr/bin", "/bin"];
  if (includeInstallDirOnPath) commandPath.push(absolutePath(installDir, cwd));
  const args = [];
  if (version !== undefined) args.push("--version", version);
  args.push(...extraArguments);
  args.push("--install-dir", installDir);
  const ghLog = join(ghLogsDir, `${++invocationCount}.log`);
  const env = applyEnvironmentOverrides(
    {
      HOME: homeDir,
      GH_HOST: "untrusted.example",
      PATH: commandPath.join(":"),
      TMPDIR: tempDir,
      XDG_DATA_HOME: dataHome,
      FAKE_ARCHIVE: archive,
      FAKE_DUPLICATE_ARCHIVE: duplicateArchiveAsset ? "1" : "0",
      FAKE_DUPLICATE_RELEASE: duplicateDraftRelease ? "1" : "0",
      FAKE_GH_AUTH: auth ? "1" : "0",
      FAKE_GH_LOG: ghLog,
      FAKE_LATEST_TAG: stableTag,
      FAKE_RELEASE_ID: releaseId ?? "42",
      FAKE_RELEASE_DRAFT: releaseDraft ? "1" : "0",
      FAKE_RELEASE_ID_TAG: releaseIdTag ?? tag,
      FAKE_RELEASES: releasesDir,
      FAKE_TAG: tag,
      FAKE_UNAME_M: platform.machine,
      FAKE_UNAME_S: platform.system,
    },
    environment,
  );
  if (releaseId !== undefined) env.STATION_INSTALL_RELEASE_ID = releaseId;
  const invocation = buildShellInvocation(childShell, args, umask);
  const options = { cwd, encoding: "utf8", env };

  if (!asynchronous) {
    return { ...spawnSync(invocation.command, invocation.args, options), ghLog };
  }

  const child = spawn(invocation.command, invocation.args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  let stdout = "";
  let stderr = "";
  let spawnError;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  const running = { child, ghLog, settled: false };
  running.completion = new Promise((resolveCompletion) => {
    child.on("close", (status, signal) => {
      activeChildren.delete(child);
      running.settled = true;
      resolveCompletion({ error: spawnError, ghLog, signal, status, stderr, stdout });
    });
  });
  return running;
}

function buildShellInvocation(childShell, installerArgs, umask) {
  if (umask === undefined) {
    return { command: childShell, args: [installer, ...installerArgs] };
  }
  return {
    command: childShell,
    args: [
      "-c",
      'umask "$1"; shift; exec "$@"',
      "station-install",
      umask,
      childShell,
      installer,
      ...installerArgs,
    ],
  };
}

function applyEnvironmentOverrides(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

function makeFailOnceShim(command, destination, slug) {
  const shimDir = join(root, `${slug}-shim`);
  const state = join(root, `${slug}-failed-once`);
  makeDirectory(shimDir);
  writeExecutable(
    join(shimDir, command),
    `#!/bin/sh
last=''
for argument do last=$argument; done
if [ "$last" = "$FAKE_FAIL_DESTINATION" ] && [ ! -e "$FAKE_SHIM_STATE" ]; then
  : > "$FAKE_SHIM_STATE"
  chmod 600 "$FAKE_SHIM_STATE"
  exit 71
fi
exec "$FAKE_REAL_COMMAND" "$@"
`,
  );
  return {
    directory: shimDir,
    environment: {
      FAKE_FAIL_DESTINATION: destination,
      FAKE_REAL_COMMAND: resolveCommand(command),
      FAKE_SHIM_STATE: state,
    },
  };
}

function makeBlockingShim(command, destination, marker) {
  const shimDir = join(root, `${invocationCount + 1}-blocking-${command}`);
  makeDirectory(shimDir);
  writeExecutable(
    join(shimDir, command),
    `#!/bin/sh
last=''
for argument do last=$argument; done
if [ "$last" = "$FAKE_BLOCK_DESTINATION" ]; then
  : > "$FAKE_BLOCK_MARKER"
  chmod 600 "$FAKE_BLOCK_MARKER"
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  while :; do /bin/sleep 0.02; done
fi
exec "$FAKE_REAL_COMMAND" "$@"
`,
  );
  return {
    directory: shimDir,
    environment: {
      FAKE_BLOCK_DESTINATION: destination,
      FAKE_BLOCK_MARKER: marker,
      FAKE_REAL_COMMAND: resolveCommand(command),
    },
  };
}

function makeLockAcquisitionShim(destination, marker, releaseFile) {
  const shimDir = join(root, "lock-acquisition-shim");
  makeDirectory(shimDir);
  writeExecutable(
    join(shimDir, "mkdir"),
    `#!/bin/sh
last=''
for argument do last=$argument; done
if [ "$last" = "$FAKE_LOCK_DESTINATION" ]; then
  "$FAKE_REAL_MKDIR" "$@" || exit
  : > "$FAKE_BLOCK_MARKER"
  chmod 600 "$FAKE_BLOCK_MARKER"
  while [ ! -e "$FAKE_BLOCK_RELEASE" ]; do /bin/sleep 0.02; done
  exit 0
fi
exec "$FAKE_REAL_MKDIR" "$@"
`,
  );
  return {
    directory: shimDir,
    environment: {
      FAKE_BLOCK_MARKER: marker,
      FAKE_BLOCK_RELEASE: releaseFile,
      FAKE_LOCK_DESTINATION: destination,
      FAKE_REAL_MKDIR: resolveCommand("mkdir"),
    },
  };
}

function resolveCommand(command) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  assertSuccess(result, `resolve ${command}`);
  return result.stdout.trim();
}

function seedInstallation({ installDir, dataHome, tag, withAliases = true }) {
  makeDirectory(installDir);
  const version = tag.slice(1);
  writeExecutable(
    join(installDir, "stn"),
    `#!/bin/sh
if [ "\${1:-}" = --version ]; then printf '%s\\n' '${version}'; else printf '%s\\n' 'Station ${tag} linux-x64'; fi
`,
  );
  if (withAliases) {
    symlinkSync("stn", join(installDir, "stn-ingress"));
    symlinkSync("stn", join(installDir, "stn-tmux-popup"));
  }
  const licenseDir = join(dataHome, "station");
  makeDirectory(licenseDir);
  writeText(join(licenseDir, "LICENSE"), `Station fixture license ${tag}\n`, 0o644);
}

function assertInstalled({ installDir, dataHome = dataDir, tag, target }) {
  const binary = join(installDir, "stn");
  const result = spawnSync(binary, [], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assertSuccess(result, `${target} installed binary`);
  assertEqual(result.stdout, `Station ${tag} ${target}\n`, `${target} installed version`);
  assertRuntimeVersion(installDir, tag, `${target} installed entrypoints`);
  assertLicense(dataHome, tag, `${target} installed license`);
  assertMode(binary, 0o755, `${target} executable mode`);
}

function assertRuntimeVersion(installDir, tag, label, { aliases = true } = {}) {
  const entrypoints = aliases ? ["stn", "stn-ingress", "stn-tmux-popup"] : ["stn"];
  for (const entrypoint of entrypoints) {
    const path = join(installDir, entrypoint);
    const result = spawnSync(path, ["--version"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    assertSuccess(result, `${label} ${entrypoint}`);
    assertEqual(result.stdout, `${tag.slice(1)}\n`, `${label} ${entrypoint} version`);
  }
  if (aliases) {
    assertEqual(readlinkSync(join(installDir, "stn-ingress")), "stn", `${label} ingress link`);
    assertEqual(readlinkSync(join(installDir, "stn-tmux-popup")), "stn", `${label} popup link`);
  } else {
    assert(!existsSync(join(installDir, "stn-ingress")), `${label} leaves ingress absent`);
    assert(!existsSync(join(installDir, "stn-tmux-popup")), `${label} leaves popup absent`);
  }
}

function assertLicense(dataHome, tag, label) {
  assertEqual(
    readFileSync(join(dataHome, "station", "LICENSE"), "utf8"),
    `Station fixture license ${tag}\n`,
    label,
  );
}

function assertNoInstallerResidue(installDir, dataHome) {
  const directories = [
    absolutePath(installDir, repoRoot),
    join(absolutePath(dataHome, repoRoot), "station"),
    tempDir,
  ];
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    const residue = readdirSync(directory).filter(
      (name) => name.startsWith(".station-install") || name.startsWith("station-install."),
    );
    assertEqual(residue, [], `installer residue in ${directory}`);
  }
}

function assertMode(path, expected, label) {
  assertEqual(statSync(path).mode & 0o777, expected, label);
}

function ghCalls(result) {
  if (!existsSync(result.ghLog)) return [];
  return readFileSync(result.ghLog, "utf8").trimEnd().split("\n");
}

function assertNoGhApiCalls(result, label) {
  assertEqual(
    ghCalls(result).filter((call) => call.startsWith("api ")),
    [],
    `${label} release API calls`,
  );
}

function spawnChecked(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assertSuccess(result, label);
  return result;
}

function makeDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeText(path, source, mode) {
  writeFileSync(path, source, { mode });
  chmodSync(path, mode);
}

function writeExecutable(path, source) {
  writeText(path, source, 0o755);
}

function absolutePath(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function waitForPath(path, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(20);
  }
  throw new Error(`${label}: ${path} did not appear within ${timeoutMs}ms`);
}

async function settleWithin(running, timeoutMs, label) {
  const timeout = Symbol("timeout");
  const result = await Promise.race([running.completion, delay(timeoutMs).then(() => timeout)]);
  if (result !== timeout) return result;
  signalProcessGroup(running.child, "SIGKILL");
  await running.completion;
  throw new Error(`${label} did not finish within ${timeoutMs}ms`);
}

function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function stopActiveChildren() {
  const children = [...activeChildren];
  for (const child of children) signalProcessGroup(child, "SIGKILL");
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) resolveExit();
          else child.once("close", resolveExit);
        }),
    ),
  );
}

function assertProcessGone(pid, label) {
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  throw new Error(`${label}: process ${pid} is still alive`);
}

function assertSignalStatus(result, signal, label) {
  if (result.status === signal.status || result.signal === signal.name) return;
  throw new Error(
    `${label}: expected status ${signal.status} or signal ${signal.name}, received ${result.status}/${result.signal}`,
  );
}

function assertSuccess(result, label) {
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
}

function assertNonzero(result, label) {
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) throw new Error(`${label} unexpectedly passed`);
}

function assertFailure(result, expected, label) {
  assertNonzero(result, label);
  assertIncludes(result.stderr, expected, label);
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(value)} to include ${JSON.stringify(expected)}`,
    );
  }
}

function assertNotIncludes(value, expected, label) {
  if (value.includes(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(value)} not to include ${JSON.stringify(expected)}`,
    );
  }
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assert(condition, label) {
  if (!condition) throw new Error(label);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
