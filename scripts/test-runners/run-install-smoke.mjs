#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const inheritedUmask = process.umask(0o077);
const runner = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const installer = join(repoRoot, "scripts", "install.sh");
const timeoutScaleText = process.env.STATION_INSTALL_SMOKE_TIMEOUT_SCALE ?? "1";
if (!/^(?:[1-9]|10)$/.test(timeoutScaleText)) {
  throw new Error("STATION_INSTALL_SMOKE_TIMEOUT_SCALE must be an integer from 1 through 10");
}
const timeoutScale = Number(timeoutScaleText);
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
const childTimeoutMs = 30_000 * timeoutScale;
const markerTimeoutMs = 10_000 * timeoutScale;
const overallTimeoutMs = 240_000 * timeoutScale;
const startedAt = Date.now();
const selfInterruptChild = process.argv.includes("--self-interrupt-child");
let invocationCount = 0;
let cleanupPromise;
let overallTimer;
let signalCleanupStarted = false;

const platforms = [
  { system: "Darwin", machine: "arm64", target: "darwin-arm64" },
  { system: "Darwin", machine: "x86_64", target: "darwin-x64" },
  { system: "Linux", machine: "aarch64", target: "linux-arm64" },
  { system: "Linux", machine: "x86_64", target: "linux-x64" },
];

for (const [signal, status] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    void cleanupHarness().finally(() => process.exit(status));
  });
}

overallTimer = setTimeout(() => {
  dumpHarnessState(`overall deadline exceeded after ${overallTimeoutMs}ms`);
  void cleanupHarness().finally(() => process.exit(1));
}, overallTimeoutMs);

try {
  if (selfInterruptChild) {
    await runSelfInterruptChild();
  } else {
    prepareFixtures();
    await scenarioPlatformInstalls();
    await scenarioDefaultHomeAndPathResolution();
    await scenarioFutureShellPathPersistence();
    await scenarioExplicitRollbackAndDraft();
    await scenarioStrictGhFlows();
    await scenarioAuthenticatedReleaseValidation();
    await scenarioGhFailuresAndRetries();
    await scenarioArtifactValidation();
    await scenarioStrictVersionValidation();
    await scenarioCliParsing();
    await scenarioHostileUmaskModes();
    await scenarioPathResolutionAndFilesystemFailures();
    await scenarioProbeDeadline();
    await scenarioProbeDiagnostics();
    scenarioProbeSecretIsolation();
    await scenarioDestinationLock();
    await scenarioSharedLicenseLock();
    await scenarioReplacedLockOwnership();
    await scenarioCommitFailures();
    await scenarioAmbiguousRuntimeCommit();
    await scenarioManagedPathReplacement();
    await scenarioContinuousReaders();
    await scenarioCaughtSignals();
    await scenarioGhSignalSupervision();
    await scenarioRepeatedSignalCleanup();
    await scenarioAliasCreationSignal();
    await scenarioSignalDuringLockAcquisition();
    await scenarioSigkillLeavesActionableLocks();
    await scenarioSelfInterruption();
    scenarioHelp();
    process.stdout.write("install smoke passed\n");
  }
} catch (error) {
  dumpHarnessState(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  await cleanupHarness();
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
  createRelease("v1.2.9", ["linux-x64"], { reportedVersion: "9.9.9" });
  createRelease("v1.2.10", ["linux-x64"], { probeMode: "flood" });
  createRelease("v1.2.11", ["linux-x64"], { probeMode: "diagnostic" });
  createRelease("v1.2.12", ["linux-x64"], { omitMember: "LICENSE" });
  createRelease("v1.2.13", ["linux-x64"], { duplicateMember: "stn" });
  createManualRelease("v1.2.14", "linux-x64", [
    tarFile("../stn", "untrusted traversal payload\n", 0o755),
    tarFile("LICENSE", "Station fixture license v1.2.14\n", 0o644),
    tarSymlink("stn-ingress", "stn"),
    tarSymlink("stn-tmux-popup", "stn"),
  ]);
  createManualRelease("v1.2.15", "linux-x64", [
    tarSymlink("stn", "missing-runtime"),
    tarFile("LICENSE", "Station fixture license v1.2.15\n", 0o644),
    tarSymlink("stn-ingress", "stn"),
    tarSymlink("stn-tmux-popup", "stn"),
  ]);
  createManualRelease("v1.2.16", "linux-x64", [
    tarFile("stn", releaseBinarySource("v1.2.16", "linux-x64"), 0o755),
    tarSymlink("LICENSE", "stn"),
    tarSymlink("stn-ingress", "stn"),
    tarSymlink("stn-tmux-popup", "stn"),
  ]);
  createRelease("v1.2.17", ["linux-x64"], { ingressTarget: "../stn" });
  createRelease("v1.2.18", ["linux-x64"], { unreadableArchive: true });
  createRelease("v1.2.19", ["linux-x64"], { checksumMode: "missing" });
  createRelease("v1.2.20", ["linux-x64"], { checksumMode: "duplicate" });
  createRelease("v1.2.21", ["linux-x64"], { checksumMode: "malformed" });
  createRelease("v1.2.22", ["linux-x64"], { probeMode: "hang" });
  createRelease("v1.2.23", ["linux-x64"], { popupTarget: "../stn" });
  createManualRelease("v1.2.24", "linux-x64", [
    tarFile("stn", releaseBinarySource("v1.2.24", "linux-x64"), 0o755),
    tarFile("LICENSE", "Station fixture license v1.2.24\n", 0o644),
    tarFile("stn-ingress", "not a symlink\n", 0o755),
    tarSymlink("stn-tmux-popup", "stn"),
  ]);
  createRelease("v1.2.25", ["linux-x64"], { probeMode: "stdout-flood" });
  createManualRelease("v1.2.26", "linux-x64", [
    tarFile("LICENSE", "Station fixture license v1.2.26\n", 0o644),
    tarHardlink("stn", "LICENSE"),
    tarSymlink("stn-ingress", "stn"),
    tarSymlink("stn-tmux-popup", "stn"),
  ]);
  createManualRelease("v1.2.27", "linux-x64", [
    tarFile("stn", releaseBinarySource("v1.2.27", "linux-x64"), 0o755),
    tarHardlink("LICENSE", "stn"),
    tarSymlink("stn-ingress", "stn"),
    tarSymlink("stn-tmux-popup", "stn"),
  ]);
  createRelease("v1.2.28", ["linux-x64"], { probeMode: "secret-check" });
}

function scenarioPlatformInstalls() {
  const shellWithoutShell = join(root, "shell-without-shell");
  writeExecutable(
    shellWithoutShell,
    '#!/bin/sh\ninstaller=$1\nshift\nunset SHELL\n. "$installer"\n',
  );
  for (const [index, platform] of platforms.entries()) {
    const installDir = join(root, `install-${platform.target}`);
    const result = runInstaller({
      installDir,
      platform,
      childShell: index === 0 ? shellWithoutShell : "/bin/sh",
    });
    assertSuccess(result, `${platform.target} latest install`);
    assertInstalled({ installDir, tag: stableTag, target: platform.target });
    assertPathRecovery(result, installDir, ["stn", "stn-ingress", "stn-tmux-popup"]);
    assertNoInstallerResidue(installDir, dataDir);
  }
}

function scenarioDefaultHomeAndPathResolution() {
  const cleanHome = join(root, "default-home");
  makeDirectory(cleanHome);
  const defaultInstallDir = join(cleanHome, ".local", "bin");
  const defaultDataHome = join(cleanHome, ".local", "share");
  const defaultInstall = runInstaller({
    platform: linuxX64(),
    home: cleanHome,
    unsetXdgDataHome: true,
    omitInstallDir: true,
  });
  assertSuccess(defaultInstall, "default clean-home install");
  assertInstalled({
    installDir: defaultInstallDir,
    dataHome: defaultDataHome,
    tag: stableTag,
    target: "linux-x64",
  });
  assertPathRecovery(defaultInstall, defaultInstallDir, ["stn", "stn-ingress", "stn-tmux-popup"]);
  for (const profile of [".profile", ".bashrc", ".zprofile", ".zshrc"]) {
    assert(!existsSync(join(cleanHome, profile)), `installer leaves ${profile} absent`);
  }

  const shadowedStnDir = join(root, "shadowed-stn-path");
  const shadowedStnInstall = join(root, "shadowed-stn-bin");
  makeDirectory(shadowedStnDir);
  writeExecutable(join(shadowedStnDir, "stn"), "#!/bin/sh\nprintf '%s\\n' '0.0.1'\n");
  const shadowedStn = runInstaller({
    installDir: shadowedStnInstall,
    platform: linuxX64(),
    pathEntries: [shadowedStnDir, shadowedStnInstall, fakeBinDir, "/usr/bin", "/bin"],
  });
  assertSuccess(shadowedStn, "older stn shadowing");
  assertPathRecovery(
    shadowedStn,
    shadowedStnInstall,
    ["stn"],
    [shadowedStnDir, shadowedStnInstall, fakeBinDir, "/usr/bin", "/bin"],
  );
  assertIncludes(shadowedStn.stdout, join(shadowedStnDir, "stn"), "shadowed stn diagnosis");

  const shadowedSiblingDir = join(root, "shadowed-sibling-path");
  const shadowedSiblingInstall = join(root, "shadowed-sibling-bin");
  makeDirectory(shadowedSiblingDir);
  writeExecutable(
    join(shadowedSiblingDir, "stn-ingress"),
    "#!/bin/sh\nprintf '%s\\n' 'shadow ingress'\n",
  );
  const shadowedSibling = runInstaller({
    installDir: shadowedSiblingInstall,
    platform: linuxX64(),
    pathEntries: [shadowedSiblingDir, shadowedSiblingInstall, fakeBinDir, "/usr/bin", "/bin"],
  });
  assertSuccess(shadowedSibling, "one shadowed sibling launcher");
  assertPathRecovery(
    shadowedSibling,
    shadowedSiblingInstall,
    ["stn-ingress"],
    [shadowedSiblingDir, shadowedSiblingInstall, fakeBinDir, "/usr/bin", "/bin"],
  );
  assertIncludes(
    shadowedSibling.stdout,
    join(shadowedSiblingDir, "stn-ingress"),
    "shadowed sibling diagnosis",
  );

  const correctInstallDir = join(root, "correct-path-bin");
  const correctPathHome = join(root, "correct-path-home");
  makeDirectory(correctPathHome);
  const correctPath = runInstaller({
    installDir: correctInstallDir,
    platform: linuxX64(),
    home: correctPathHome,
    pathEntries: [correctInstallDir, fakeBinDir, "/usr/bin", "/bin"],
    environment: { SHELL: "/bin/zsh" },
  });
  assertSuccess(correctPath, "all launchers on correct PATH");
  assertIncludes(correctPath.stdout, "Next: run stn setup", "correct PATH next step");
  assertNotIncludes(correctPath.stdout, "hash -r", "correct PATH omits recovery block");
  assertIncludes(
    correctPath.stdout,
    "Future-shell PATH was not changed",
    "temporary correct PATH still receives future-shell guidance",
  );
  assert(!existsSync(join(correctPathHome, ".zprofile")), "correct PATH leaves profile absent");
}

function scenarioFutureShellPathPersistence() {
  const installDir = join(root, "Station's custom bin");
  const zsh = join(fakeBinDir, "zsh");
  const shadowDir = join(root, "future-shell-shadow-bin");
  const currentPath = [shadowDir, fakeBinDir, "/usr/bin", "/bin"];
  const homebrewProfile = [
    "# Homebrew shell environment",
    'export HOMEBREW_PREFIX="/opt/homebrew"',
    "",
  ].join("\n");
  const expectedEntry = `export PATH=${shellWord(installDir)}\${PATH:+":$PATH"}`;
  makeDirectory(shadowDir);
  for (const launcher of ["stn", "stn-ingress", "stn-tmux-popup"]) {
    writeExecutable(join(shadowDir, launcher), "#!/bin/sh\nexit 99\n");
  }

  const consentHome = join(root, "future-shell-consent-home");
  const consentProfile = join(consentHome, ".zprofile");
  makeDirectory(consentHome);
  writeText(consentProfile, homebrewProfile, 0o640);
  const profileBefore = statSync(consentProfile);
  const consent = runInstaller({
    installDir,
    platform: linuxX64(),
    home: consentHome,
    pathEntries: currentPath,
    extraArguments: ["--persist-path"],
    environment: { SHELL: zsh },
  });
  assertSuccess(consent, "explicit future-shell PATH persistence");
  assertIncludes(
    consent.stdout,
    "Added Station to future zsh login shells",
    "explicit persistence confirmation",
  );
  const persistedProfile = readFileSync(consentProfile, "utf8");
  assert(persistedProfile.startsWith(homebrewProfile), "persistence preserves Homebrew setup");
  assertEqual(
    countExactLines(persistedProfile, expectedEntry),
    1,
    "explicit persistence adds one exact PATH entry",
  );
  const profileAfter = statSync(consentProfile);
  assertEqual(profileAfter.ino, profileBefore.ino, "persistence appends to the existing profile");
  assertEqual(
    profileAfter.mode & 0o777,
    profileBefore.mode & 0o777,
    "persistence preserves profile mode",
  );
  assertFutureShellLauncherResolution({
    home: consentHome,
    installDir,
    profile: consentProfile,
    shadowDir,
  });

  const idempotent = runInstaller({
    installDir,
    platform: linuxX64(),
    home: consentHome,
    pathEntries: currentPath,
    extraArguments: ["--persist-path"],
    environment: { SHELL: zsh },
  });
  assertSuccess(idempotent, "idempotent future-shell PATH persistence");
  assertIncludes(
    idempotent.stdout,
    "Future-shell PATH is already configured",
    "idempotent persistence confirmation",
  );
  assertEqual(
    readFileSync(consentProfile, "utf8"),
    persistedProfile,
    "repeated persistence leaves profile byte-identical",
  );

  const noConsentHome = join(root, "future-shell-no-consent-home");
  const noConsentProfile = join(noConsentHome, ".zprofile");
  makeDirectory(noConsentHome);
  writeText(noConsentProfile, homebrewProfile, 0o600);
  const noConsent = runInstaller({
    installDir,
    platform: linuxX64(),
    home: noConsentHome,
    pathEntries: currentPath,
    environment: { SHELL: zsh },
  });
  assertSuccess(noConsent, "future-shell PATH without consent");
  assertEqual(
    readFileSync(noConsentProfile, "utf8"),
    homebrewProfile,
    "no-flag install leaves profile unchanged",
  );
  const persistenceCommand = extractPathPersistenceCommand(noConsent.stdout);
  const commandResult = spawnSync(
    "/bin/sh",
    ["-c", persistenceCommand],
    syncOptions({ env: { HOME: noConsentHome, PATH: "/usr/bin:/bin" } }),
  );
  assertSuccess(commandResult, "printed future-shell PATH command");
  assertEqual(
    countExactLines(readFileSync(noConsentProfile, "utf8"), expectedEntry),
    1,
    "printed command adds one exact PATH entry",
  );
  assertFutureShellLauncherResolution({
    home: noConsentHome,
    installDir,
    profile: noConsentProfile,
    shadowDir,
  });

  const missingProfileHome = join(root, "future-shell-missing-profile-home");
  const missingProfile = join(missingProfileHome, ".zprofile");
  const missingProfileInstall = join(root, "future-shell-missing-profile-bin");
  makeDirectory(missingProfileHome);
  const created = runInstaller({
    installDir: missingProfileInstall,
    platform: linuxX64(),
    home: missingProfileHome,
    extraArguments: ["--persist-path"],
    environment: { SHELL: zsh },
  });
  assertSuccess(created, "future-shell PATH creates a missing zprofile");
  assertEqual(
    readFileSync(missingProfile, "utf8"),
    `export PATH=${shellWord(missingProfileInstall)}\${PATH:+":$PATH"}\n`,
    "new zprofile contains only the exact PATH entry",
  );
  assertMode(missingProfile, 0o600, "new zprofile mode");

  const partialAppendShell = join(root, "partial-profile-append-shell");
  writeExecutable(
    partialAppendShell,
    `#!/bin/sh
printf() {
  if [ "\${FAKE_PROFILE_APPEND_MODE:-}" != '' ] && [ "\${2-}" = "$FAKE_PROFILE_ENTRY" ]; then
    command printf '\\n%.20s' "$2"
    if [ "$FAKE_PROFILE_APPEND_MODE" = signal ]; then
      kill -TERM "$$"
      return 0
    fi
    return 1
  fi
  command printf "$@"
}
installer=$1
shift
. "$installer"
`,
  );
  for (const [mode, expectedStatus] of [
    ["failure", 1],
    ["signal", 143],
  ]) {
    const partialHome = join(root, `future-shell-partial-${mode}-home`);
    const partialProfile = join(partialHome, ".zprofile");
    const originalProfile = `# profile before ${mode}\n`;
    makeDirectory(partialHome);
    writeText(partialProfile, originalProfile, 0o640);
    const partial = runInstaller({
      installDir,
      platform: linuxX64(),
      home: partialHome,
      childShell: partialAppendShell,
      extraArguments: ["--persist-path"],
      environment: {
        FAKE_PROFILE_APPEND_MODE: mode,
        FAKE_PROFILE_ENTRY: expectedEntry,
        SHELL: zsh,
      },
    });
    assertExactStatus(partial, expectedStatus, `partial profile ${mode}`);
    assertEqual(
      readFileSync(partialProfile, "utf8"),
      originalProfile,
      `partial profile ${mode} restores the original bytes`,
    );
  }

  const customZdotHome = join(root, "future-shell-custom-zdot-home");
  const customZdotDir = join(customZdotHome, "custom-zdotdir");
  const customZdotProfile = join(customZdotDir, ".zprofile");
  makeDirectory(customZdotDir);
  writeText(
    join(customZdotHome, ".zshenv"),
    `[ "\${FAKE_ZSH_LOGIN:-}" != 1 ] || ZDOTDIR="$HOME/custom-zdotdir"\n`,
    0o600,
  );
  writeText(customZdotProfile, "# custom zprofile\n", 0o600);
  const customZdot = runInstaller({
    installDir,
    platform: linuxX64(),
    home: customZdotHome,
    extraArguments: ["--persist-path"],
    environment: { SHELL: zsh },
  });
  assertFailure(customZdot, "non-exported ZDOTDIR", "non-exported zsh ZDOTDIR");
  assertEqual(ghCalls(customZdot), [], "non-exported zsh ZDOTDIR makes no gh calls");
  assert(
    !existsSync(join(customZdotHome, ".zprofile")),
    "non-exported ZDOTDIR leaves HOME profile absent",
  );
  assertEqual(
    readFileSync(customZdotProfile, "utf8"),
    "# custom zprofile\n",
    "non-exported ZDOTDIR leaves the effective profile unchanged",
  );

  const colonHome = join(root, "future-shell-colon-home");
  const colonProfile = join(colonHome, ".zprofile");
  const colonProfileBefore = "# colon profile\n";
  makeDirectory(colonHome);
  writeText(colonProfile, colonProfileBefore, 0o600);
  const colon = runInstaller({
    installDir: join(root, "future-shell:colon-bin"),
    platform: linuxX64(),
    home: colonHome,
    extraArguments: ["--persist-path"],
    environment: { SHELL: zsh },
  });
  assertFailure(colon, "without colons or line breaks", "colon in persisted install directory");
  assertEqual(ghCalls(colon), [], "colon in persisted install directory makes no gh calls");
  assertEqual(
    readFileSync(colonProfile, "utf8"),
    colonProfileBefore,
    "colon in persisted install directory leaves the profile unchanged",
  );

  const legacyHome = join(root, "future-shell-legacy-home");
  const legacyProfile = join(legacyHome, ".zprofile");
  const legacyEntry = 'export PATH="$HOME/.local/bin:$PATH"\n';
  makeDirectory(legacyHome);
  writeText(legacyProfile, legacyEntry, 0o600);
  const legacy = runInstaller({
    platform: linuxX64(),
    home: legacyHome,
    omitInstallDir: true,
    extraArguments: ["--persist-path"],
    environment: { SHELL: zsh },
  });
  assertSuccess(legacy, "legacy documented PATH persistence");
  assertIncludes(
    legacy.stdout,
    "Future-shell PATH is already configured",
    "legacy documented PATH recognition",
  );
  assertEqual(
    readFileSync(legacyProfile, "utf8"),
    legacyEntry,
    "legacy documented PATH entry remains byte-identical",
  );
}

function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function countExactLines(value, expected) {
  return value.split("\n").filter((line) => line === expected).length;
}

function extractPathPersistenceCommand(stdout) {
  const marker = ", run:\n  ";
  const commandStart = stdout.indexOf(marker);
  assert(commandStart >= 0, "no-flag install prints a future-shell PATH command");
  const lineStart = commandStart + marker.length;
  const lineEnd = stdout.indexOf("\n", lineStart);
  assert(lineEnd > lineStart, "future-shell PATH command occupies one line");
  const command = stdout.slice(lineStart, lineEnd);
  assert(command.startsWith("if ! grep -F -x -q "), "future-shell PATH command is idempotent");
  return command;
}

function assertFutureShellLauncherResolution({ home, installDir, profile, shadowDir }) {
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      '. "$1"; for launcher in stn stn-ingress stn-tmux-popup; do command -v "$launcher" || exit; done',
      "station-future-shell",
      profile,
    ],
    syncOptions({ env: { HOME: home, PATH: `${shadowDir}:/usr/bin:/bin` } }),
  );
  assertSuccess(result, "minimal-PATH future shell launcher resolution");
  assertEqual(
    result.stdout,
    `${["stn", "stn-ingress", "stn-tmux-popup"]
      .map((launcher) => join(installDir, launcher))
      .join("\n")}\n`,
    "future shell prepends installed launchers ahead of shadows",
  );
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
  assertIncludes(rollback.stdout, "Next: run stn setup", "rollback PATH next step");
  assertNotIncludes(rollback.stdout, "hash -r", "rollback PATH recovery omission");

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

function scenarioStrictGhFlows() {
  const latest = runInstaller({
    installDir: join(root, "strict-gh-latest-bin"),
    platform: linuxX64(),
  });
  assertSuccess(latest, "strict gh latest flow");
  assertStrictGhFlow(latest, { tag: stableTag, target: "linux-x64", latest: true });

  const explicit = runInstaller({
    installDir: join(root, "strict-gh-explicit-bin"),
    platform: linuxX64(),
    version: rollbackTag,
  });
  assertSuccess(explicit, "strict gh explicit flow");
  assertStrictGhFlow(explicit, { tag: rollbackTag, target: "linux-x64" });

  const draft = runInstaller({
    installDir: join(root, "strict-gh-draft-bin"),
    platform: linuxX64(),
    version: rollbackTag,
    releaseId: "42",
  });
  assertSuccess(draft, "strict gh draft flow");
  assertStrictGhFlow(draft, { draftId: "42", tag: rollbackTag, target: "linux-x64" });
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

function scenarioGhFailuresAndRetries() {
  const noGhBin = join(root, "no-gh-bin");
  makeDirectory(noGhBin);
  symlinkSync(join(fakeBinDir, "uname"), join(noGhBin, "uname"));
  const missingGh = runInstaller({
    installDir: join(root, "missing-gh-install"),
    platform: linuxX64(),
    pathEntries: [noGhBin],
  });
  assertFailure(missingGh, "GitHub CLI is required", "missing gh");
  assertEqual(ghCalls(missingGh), [], "missing gh makes no gh calls");

  const installDir = join(root, "gh-failure-bin");
  const dataHome = join(root, "gh-failure-data");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
  const failures = [
    ["latest", {}, "latest release API failure"],
    ["release", { version: stableTag }, "release asset API failure"],
    ["release", { version: stableTag, releaseId: "42" }, "draft release API failure"],
    ["archive-download", { version: stableTag }, "archive download failure"],
    ["checksums-download", { version: stableTag }, "checksum download failure"],
    ["partial-archive", { version: stableTag }, "partial archive download"],
    ["partial-checksums", { version: stableTag }, "partial checksum download"],
  ];

  for (const [phase, options, label] of failures) {
    const result = runInstaller({
      installDir,
      platform: linuxX64(),
      dataHome,
      ...options,
      environment: { FAKE_GH_FAIL_PHASE: phase },
    });
    assertNonzero(result, label);
    assertRuntimeVersion(installDir, "v0.9.0", `${label} runtime preservation`);
    assertLicense(dataHome, "v0.9.0", `${label} license preservation`);
    assertNoInstallerResidue(installDir, dataHome);
  }

  for (const [environment, expected, label] of [
    [{ FAKE_ARCHIVE_ASSET_COUNT: "0" }, "exactly one", "missing archive asset"],
    [{ FAKE_ARCHIVE_ASSET_COUNT: "2" }, "exactly one", "duplicate archive asset"],
    [{ FAKE_CHECKSUM_ASSET_COUNT: "0" }, "exactly one", "missing checksum asset"],
    [{ FAKE_CHECKSUM_ASSET_COUNT: "2" }, "exactly one", "duplicate checksum asset"],
  ]) {
    const result = runInstaller({
      installDir,
      platform: linuxX64(),
      version: stableTag,
      dataHome,
      environment,
    });
    assertFailure(result, expected, label);
    assertRuntimeVersion(installDir, "v0.9.0", `${label} runtime preservation`);
    assertLicense(dataHome, "v0.9.0", `${label} license preservation`);
    assertNoInstallerResidue(installDir, dataHome);
  }

  const retry = runInstaller({ installDir, platform: linuxX64(), version: stableTag, dataHome });
  assertSuccess(retry, "retry after gh failures");
  assertInstalled({ installDir, dataHome, tag: stableTag, target: "linux-x64" });
}

function scenarioArtifactValidation() {
  const installDir = join(root, "artifact-validation-bin");
  const dataHome = join(root, "artifact-validation-data");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
  const failures = [
    ["v1.2.4", "checksum verification failed", "mismatched checksum"],
    ["v1.2.19", "exactly one checksum", "missing checksum"],
    ["v1.2.20", "exactly one checksum", "duplicate checksum"],
    ["v1.2.21", "invalid checksum", "malformed checksum"],
    ["v1.2.18", "not a readable gzip", "unreadable gzip"],
    ["v1.2.12", "exact Station release manifest", "missing archive member"],
    ["v1.2.5", "exact Station release manifest", "extra archive member"],
    ["v1.2.13", "exact Station release manifest", "duplicate archive member"],
    ["v1.2.14", "exact Station release manifest", "traversal-like archive member"],
    ["v1.2.15", "required Station member types", "wrong binary archive type"],
    ["v1.2.16", "required Station member types", "wrong license archive type"],
    ["v1.2.17", "symlink to 'stn'", "wrong launcher archive target"],
    ["v1.2.23", "symlink to 'stn'", "wrong popup launcher archive target"],
    ["v1.2.24", "required Station member types", "regular-file launcher archive type"],
    ["v1.2.26", "required Station member types", "hardlinked binary archive type"],
    ["v1.2.27", "required Station member types", "hardlinked license archive type"],
    ["v1.2.9", "reports an unexpected version", "wrong embedded version"],
  ];

  for (const [version, expected, label] of failures) {
    const result = runInstaller({ installDir, platform: linuxX64(), version, dataHome });
    assertFailure(result, expected, label);
    assertRuntimeVersion(installDir, "v0.9.0", `${label} runtime preservation`);
    assertLicense(dataHome, "v0.9.0", `${label} license preservation`);
    assertNoInstallerResidue(installDir, dataHome);
  }

  const noChecksumBin = makeNoChecksumBin();
  const noChecksum = runInstaller({
    installDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome,
    pathEntries: [noChecksumBin],
  });
  assertFailure(noChecksum, "sha256sum or shasum is required", "no checksum utility");
  assertRuntimeVersion(installDir, "v0.9.0", "no checksum utility runtime preservation");
  assertLicense(dataHome, "v0.9.0", "no checksum utility license preservation");
  assertNoInstallerResidue(installDir, dataHome);
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

function scenarioCliParsing() {
  const installDir = join(root, "cli-parsing-bin");
  const cases = [
    [["--version"], "--version requires a value", "missing version value"],
    [["--install-dir"], "--install-dir requires a path", "missing install-dir value"],
    [
      ["--version", stableTag, "--version", rollbackTag],
      "--version may be specified only once",
      "duplicate version flag",
    ],
    [
      ["--install-dir", installDir, "--install-dir", join(root, "other-bin")],
      "--install-dir may be specified only once",
      "duplicate install-dir flag",
    ],
    [
      ["--persist-path", "--persist-path"],
      "--persist-path may be specified only once",
      "duplicate persist-path flag",
    ],
    [["--install-dir", ""], "non-empty path", "empty install-dir path"],
    [["--unknown"], "unknown option", "unknown option"],
  ];

  for (const [argumentsOverride, expected, label] of cases) {
    const result = runInstaller({
      installDir,
      platform: linuxX64(),
      argumentsOverride,
    });
    assertFailure(result, expected, label);
    assertEqual(ghCalls(result), [], `${label} makes no gh calls`);
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

  const unusualCwd = join(root, "path with spaces'quote\nand newline");
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
  assertPathRecovery(unusual, unusualInstall, ["stn", "stn-ingress", "stn-tmux-popup"]);

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
  const newlineLinkRuntime = spawnSync(join(newlineLinkDir, "stn"), ["--version"], syncOptions());
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

async function scenarioProbeDiagnostics() {
  const installDir = join(root, "probe-diagnostics-bin");
  const dataHome = join(root, "probe-diagnostics-data");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });

  const flood = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.10",
    dataHome,
  });
  assertNonzero(flood, "probe output flood");
  assertIncludes(flood.stderr, "loader diagnostic", "probe output flood diagnostic");
  const diagnosticPrefix = "Compatibility probe stderr (up to 4096 sanitized bytes):\n";
  const diagnosticStart = flood.stderr.indexOf(diagnosticPrefix);
  const diagnosticEnd = flood.stderr.indexOf("\nStation install failed:", diagnosticStart);
  assert(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart, "probe diagnostic boundaries");
  const diagnosticPayload = flood.stderr.slice(
    diagnosticStart + diagnosticPrefix.length,
    diagnosticEnd,
  );
  assert(
    Buffer.byteLength(diagnosticPayload) <= 4_096,
    `probe diagnostic payload was not bounded: ${Buffer.byteLength(diagnosticPayload)} bytes`,
  );
  assertRuntimeVersion(installDir, "v0.9.0", "probe flood runtime preservation");
  assertLicense(dataHome, "v0.9.0", "probe flood license preservation");
  assertNoInstallerResidue(installDir, dataHome);

  const stdoutFlood = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.25",
    dataHome,
  });
  assertNonzero(stdoutFlood, "probe stdout flood");
  assert(
    stdoutFlood.error?.code !== "ETIMEDOUT",
    "probe stdout flood is stopped by the file limit",
  );
  assertRuntimeVersion(installDir, "v0.9.0", "probe stdout flood runtime preservation");
  assertLicense(dataHome, "v0.9.0", "probe stdout flood license preservation");
  assertNoInstallerResidue(installDir, dataHome);

  const diagnostic = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.11",
    dataHome,
  });
  assertNonzero(diagnostic, "sanitized loader diagnostic");
  assertIncludes(diagnostic.stderr, "loader", "sanitized loader diagnostic content");
  for (const control of ["\u001b", "\u0007", "\r"]) {
    assertNotIncludes(diagnostic.stderr, control, "sanitized loader diagnostic controls");
  }
  assertRuntimeVersion(installDir, "v0.9.0", "diagnostic runtime preservation");
  assertLicense(dataHome, "v0.9.0", "diagnostic license preservation");
  assertNoInstallerResidue(installDir, dataHome);

  const timerBin = join(root, "failed-watchdog-timer-bin");
  const probePid = join(root, "failed-watchdog-probe.pid");
  makeDirectory(timerBin);
  writeExecutable(
    join(timerBin, "sleep"),
    `#!/bin/sh
if [ "\${1:-}" = 10 ]; then
  while [ ! -e "$FAKE_PROBE_PID_FILE" ]; do /bin/sleep 0.01; done
  exit 71
fi
exec /bin/sleep "$@"
`,
  );
  const timerFailure = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.22",
    dataHome,
    commandBinDirs: [timerBin],
    environment: { FAKE_PROBE_PID_FILE: probePid },
    asynchronous: true,
  });
  await waitForPath(probePid, "timer-failure probe");
  const timerResult = await settleWithin(timerFailure, 5_000, "watchdog timer failure");
  assertNonzero(timerResult, "watchdog timer failure");
  assertIncludes(timerResult.stderr, "timer", "watchdog timer failure diagnosis");
  assertRuntimeVersion(installDir, "v0.9.0", "timer failure runtime preservation");
  assertLicense(dataHome, "v0.9.0", "timer failure license preservation");
  assertProcessGone(Number(readFileSync(probePid, "utf8")), "timer-failure probe child");
  assertNoInstallerResidue(installDir, dataHome);

  const markerlessClockBin = join(root, "markerless-watchdog-clock-bin");
  makeDirectory(markerlessClockBin);
  writeExecutable(
    join(markerlessClockBin, "sleep"),
    `#!/bin/sh
case "\${1:-}" in
  10|1) exec /bin/sleep 0.05 ;;
  *) exec /bin/sleep "$@" ;;
esac
`,
  );
  const markerlessTimeout = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.7",
    dataHome,
    asynchronous: true,
    commandBinDirs: [markerlessClockBin],
  });
  const markerlessResult = await settleWithin(
    markerlessTimeout,
    5_000,
    "markerless compatibility timeout",
  );
  assertFailure(markerlessResult, "did not respond", "markerless compatibility timeout");
  assertRuntimeVersion(installDir, "v0.9.0", "markerless timeout runtime preservation");
  assertLicense(dataHome, "v0.9.0", "markerless timeout license preservation");
  assertNoInstallerResidue(installDir, dataHome);
}

function scenarioProbeSecretIsolation() {
  const installDir = join(root, "probe-secret-bin");
  const dataHome = join(root, "probe-secret-data");
  const result = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.28",
    releaseId: "42",
    dataHome,
    environment: {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret-actions-id",
      ACTIONS_RUNTIME_TOKEN: "secret-actions-runtime",
      GH_ENTERPRISE_TOKEN: "secret-gh-enterprise",
      GH_TOKEN: "secret-gh",
      GITHUB_ENTERPRISE_TOKEN: "secret-github-enterprise",
      GITHUB_TOKEN: "secret-github",
    },
  });
  assertSuccess(result, "probe credential isolation");
  assertInstalled({ installDir, dataHome, tag: "v1.2.28", target: "linux-x64" });
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
  const licenseLockPath = join(dataHome, "station", ".station-install.lock");
  await waitForPath(lockPath, "destination lock");
  await waitForPath(licenseLockPath, "license lock");
  const commandOwner = onlyLockOwner(lockPath, "destination lock owner").content;
  const licenseOwner = onlyLockOwner(licenseLockPath, "license lock owner").content;
  assertIncludes(commandOwner, `pid=${first.child.pid}\n`, "destination lock owner PID");
  assertIncludes(commandOwner, "requested=v1.2.8\n", "destination lock owner request");
  assertIncludes(commandOwner, "token=", "destination lock owner token");
  assertIncludes(licenseOwner, `pid=${first.child.pid}\n`, "license lock owner PID");
  assertIncludes(licenseOwner, "requested=v1.2.8\n", "license lock owner request");
  assertIncludes(licenseOwner, "token=", "license lock owner token");
  assert(commandOwner !== licenseOwner, "command and license locks use distinct ownership tokens");

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

async function scenarioSharedLicenseLock() {
  const dataHome = join(root, "shared-license-data");
  const firstInstallDir = join(root, "shared-license-first-bin");
  const secondInstallDir = join(root, "shared-license-second-bin");
  const probePid = join(root, "shared-license-probe.pid");
  const releaseFile = join(root, "shared-license-probe.release");
  seedInstallation({ installDir: firstInstallDir, dataHome, tag: "v0.9.0" });
  seedInstallation({ installDir: secondInstallDir, dataHome, tag: "v0.9.0" });

  const first = runInstaller({
    installDir: firstInstallDir,
    platform: linuxX64(),
    version: "v1.2.8",
    dataHome,
    environment: {
      FAKE_PROBE_PID_FILE: probePid,
      FAKE_PROBE_RELEASE_FILE: releaseFile,
    },
    asynchronous: true,
  });
  const commandLock = join(firstInstallDir, ".station-install.lock");
  const licenseLock = join(dataHome, "station", ".station-install.lock");
  await waitForPath(probePid, "shared-license first probe");
  await waitForPath(commandLock, "shared-license command lock");
  await waitForPath(licenseLock, "shared-license license lock");

  const second = runInstaller({
    installDir: secondInstallDir,
    platform: linuxX64(),
    dataHome,
  });
  assertFailure(second, licenseLock, "shared-license lock refusal");
  assertIncludes(second.stderr, String(first.child.pid), "shared-license lock owner PID");
  assert(
    !existsSync(join(secondInstallDir, ".station-install.lock")),
    "license refusal releases command lock",
  );
  assertNoGhApiCalls(second, "shared-license lock refusal");
  assertRuntimeVersion(secondInstallDir, "v0.9.0", "shared-license refused runtime");

  writeText(releaseFile, "release\n", 0o600);
  assertSuccess(
    await settleWithin(first, 5_000, "shared-license first installer"),
    "shared-license first",
  );
  assertInstalled({ installDir: firstInstallDir, dataHome, tag: "v1.2.8", target: "linux-x64" });

  const retry = runInstaller({
    installDir: secondInstallDir,
    platform: linuxX64(),
    version: rollbackTag,
    dataHome,
  });
  assertSuccess(retry, "shared-license retry");
  assertInstalled({
    installDir: secondInstallDir,
    dataHome,
    tag: rollbackTag,
    target: "linux-x64",
  });

  const coincidentDataHome = join(root, "coincident-lock-data");
  const coincidentInstallDir = join(coincidentDataHome, "station");
  const coincident = runInstaller({
    installDir: coincidentInstallDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome: coincidentDataHome,
  });
  assertSuccess(coincident, "coincident command and license lock");
  assertInstalled({
    installDir: coincidentInstallDir,
    dataHome: coincidentDataHome,
    tag: stableTag,
    target: "linux-x64",
  });
  assertNoInstallerResidue(coincidentInstallDir, coincidentDataHome);

  const orderInstallDir = join(root, "lock-order-bin");
  const orderDataHome = join(root, "lock-order-data");
  const orderLog = join(root, "lock-order.log");
  const orderShim = makeMkdirLoggingShim(orderLog);
  const ordered = runInstaller({
    installDir: orderInstallDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome: orderDataHome,
    commandBinDirs: [orderShim.directory],
    environment: orderShim.environment,
  });
  assertSuccess(ordered, "lock acquisition order");
  const lockOperations = readFileSync(orderLog, "utf8")
    .trimEnd()
    .split("\n")
    .filter((entry) => entry.endsWith("/.station-install.lock"));
  assertEqual(
    lockOperations,
    [
      `mkdir ${join(orderInstallDir, ".station-install.lock")}`,
      `mkdir ${join(orderDataHome, "station", ".station-install.lock")}`,
      `rmdir ${join(orderDataHome, "station", ".station-install.lock")}`,
      `rmdir ${join(orderInstallDir, ".station-install.lock")}`,
    ],
    "locks are acquired command-first and released license-first",
  );
}

async function scenarioReplacedLockOwnership() {
  for (const kind of ["command", "license"]) {
    const installDir = join(root, `replaced-${kind}-lock-bin`);
    const contenderInstallDir =
      kind === "command" ? installDir : join(root, "replaced-license-lock-contender-bin");
    const dataHome = join(root, `replaced-${kind}-lock-data`);
    const probePid = join(root, `replaced-${kind}-lock-probe.pid`);
    const probeRelease = join(root, `replaced-${kind}-lock-probe.release`);
    const removeMarker = join(root, `replaced-${kind}-lock-remove.ready`);
    const removeRelease = join(root, `replaced-${kind}-lock-remove.release`);
    const removeShim = join(root, `replaced-${kind}-lock-remove-shim`);
    makeDirectory(removeShim);
    writeExecutable(
      join(removeShim, "rm"),
      `#!/bin/sh
case "\${2:-}" in
  */.station-install.lock/owner-*-${kind})
    : > "$FAKE_RM_BLOCK_MARKER"
    chmod 600 "$FAKE_RM_BLOCK_MARKER"
    while [ ! -e "$FAKE_RM_BLOCK_RELEASE" ]; do /bin/sleep 0.02; done
    ;;
esac
exec /bin/rm "$@"
`,
    );
    seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
    if (contenderInstallDir !== installDir) {
      seedInstallation({ installDir: contenderInstallDir, dataHome, tag: "v0.9.0" });
    }

    const first = runInstaller({
      installDir,
      platform: linuxX64(),
      version: "v1.2.8",
      dataHome,
      commandBinDirs: [removeShim],
      environment: {
        FAKE_PROBE_PID_FILE: probePid,
        FAKE_PROBE_RELEASE_FILE: probeRelease,
        FAKE_RM_BLOCK_MARKER: removeMarker,
        FAKE_RM_BLOCK_RELEASE: removeRelease,
      },
      asynchronous: true,
    });
    const commandLock = join(installDir, ".station-install.lock");
    const licenseLock = join(dataHome, "station", ".station-install.lock");
    await waitForPath(probePid, `${kind} replacement probe`);
    await waitForPath(commandLock, `${kind} replacement command lock`);
    await waitForPath(licenseLock, `${kind} replacement license lock`);

    const replacedLock = kind === "command" ? commandLock : licenseLock;
    const replacementOwner = `pid=424242\nrequested=v9.9.9\ntoken=replacement-${kind}\n`;
    const replacementOwnerPath = join(replacedLock, `owner-replacement-${kind}`);

    writeText(probeRelease, "release\n", 0o600);
    await waitForPath(removeMarker, `${kind} owner removal`);
    rmSync(replacedLock, { recursive: true });
    mkdirSync(replacedLock, { mode: 0o700 });
    writeText(replacementOwnerPath, replacementOwner, 0o600);

    writeText(removeRelease, "release\n", 0o600);
    const firstResult = await settleWithin(first, 5_000, `${kind} replacement owner`);
    assertSuccess(firstResult, `${kind} replacement owner install`);
    assertIncludes(firstResult.stderr, "changed ownership", `${kind} replacement warning`);
    assertEqual(
      readFileSync(replacementOwnerPath, "utf8"),
      replacementOwner,
      `${kind} replacement lock survives prior owner cleanup`,
    );

    const contender = runInstaller({
      installDir: contenderInstallDir,
      platform: linuxX64(),
      version: rollbackTag,
      dataHome,
    });
    assertFailure(contender, replacedLock, `${kind} replacement lock refusal`);
    assertIncludes(contender.stderr, "424242", `${kind} replacement owner PID`);
    assertNoGhApiCalls(contender, `${kind} replacement lock refusal`);

    rmSync(replacedLock, { recursive: true });
    assertInstalled({ installDir, dataHome, tag: "v1.2.8", target: "linux-x64" });
    assertNoInstallerResidue(installDir, dataHome);
    if (contenderInstallDir !== installDir) {
      assertNoInstallerResidue(contenderInstallDir, dataHome);
    }
  }
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
    if (testCase.label === "runtime commit") {
      assertIncludes(failed.stderr, "was unchanged", "failed activation rollback report");
    }
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

  for (const testCase of cases) {
    const slug = `first-install-${testCase.label.replaceAll(" ", "-")}`;
    const installDir = join(root, `${slug}-bin`);
    const dataHome = join(root, `${slug}-data`);
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
    assertNonzero(failed, `${testCase.label} first-install failure injection`);
    for (const entrypoint of ["stn", "stn-ingress", "stn-tmux-popup"]) {
      assert(
        !existsSync(join(installDir, entrypoint)) && !isSymlink(join(installDir, entrypoint)),
        `${testCase.label} first-install leaves ${entrypoint} absent`,
      );
    }
    assert(
      !existsSync(join(dataHome, "station", "LICENSE")),
      `${testCase.label} first-install leaves license absent`,
    );
    assertNoInstallerResidue(installDir, dataHome);
  }
}

function scenarioAmbiguousRuntimeCommit() {
  const installDir = join(root, "ambiguous-runtime-bin");
  const dataHome = join(root, "ambiguous-runtime-data");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
  const shim = makeMoveThenFailShim(join(installDir, "stn"));
  const ambiguous = runInstaller({
    installDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome,
    commandBinDirs: [shim.directory],
    environment: shim.environment,
  });
  assertNonzero(ambiguous, "rename-performed-then-error");
  assertInstalled({ installDir, dataHome, tag: stableTag, target: "linux-x64" });
  assertIncludes(ambiguous.stderr, join(installDir, "stn"), "ambiguous activation inspection path");
  assertIncludes(ambiguous.stderr, "--version", "ambiguous activation inspection command");
  assertNotIncludes(ambiguous.stderr, "was unchanged", "ambiguous activation truthfulness");
  assertNoInstallerResidue(installDir, dataHome);

  const aliasInstallDir = join(root, "ambiguous-alias-bin");
  const aliasDataHome = join(root, "ambiguous-alias-data");
  const aliasShim = makeLinkThenFailShim(join(aliasInstallDir, "stn-ingress"));
  const aliasFailure = runInstaller({
    installDir: aliasInstallDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome: aliasDataHome,
    commandBinDirs: [aliasShim.directory],
    environment: aliasShim.environment,
  });
  assertNonzero(aliasFailure, "link-performed-then-error");
  assertEqual(
    readlinkSync(join(aliasInstallDir, "stn-ingress")),
    "stn",
    "unconfirmed alias is not removed",
  );
  assert(!existsSync(join(aliasInstallDir, "stn")), "link ambiguity leaves runtime absent");
  assert(
    !existsSync(join(aliasDataHome, "station", "LICENSE")),
    "link ambiguity leaves license absent",
  );
  assertNoInstallerResidue(aliasInstallDir, aliasDataHome);

  const warningInstallDir = join(root, "cleanup-warning-bin");
  const warningDataHome = join(root, "cleanup-warning-data");
  const warningShim = makeCleanupWarningShim(tempDir);
  const warning = runInstaller({
    installDir: warningInstallDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome: warningDataHome,
    commandBinDirs: [warningShim.directory],
    environment: warningShim.environment,
  });
  assertSuccess(warning, "post-commit cleanup warning");
  assertIncludes(warning.stderr, "warning", "post-commit cleanup warning output");
  assertInstalled({
    installDir: warningInstallDir,
    dataHome: warningDataHome,
    tag: stableTag,
    target: "linux-x64",
  });
  for (const name of readdirSync(tempDir)) {
    if (name.startsWith("station-install."))
      rmSync(join(tempDir, name), { recursive: true, force: true });
  }
}

async function scenarioManagedPathReplacement() {
  const installDir = join(root, "revalidated-launcher-bin");
  const dataHome = join(root, "revalidated-launcher-data");
  const marker = join(root, "revalidated-launcher.ready");
  const releaseFile = join(root, "revalidated-launcher.release");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
  const running = runInstaller({
    installDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome,
    asynchronous: true,
    environment: {
      FAKE_GH_BLOCK_DOWNLOAD: "1",
      FAKE_BLOCK_MARKER: marker,
      FAKE_BLOCK_RELEASE: releaseFile,
    },
  });
  await waitForPath(marker, "managed-path revalidation point");
  unlinkSync(join(installDir, "stn-ingress"));
  symlinkSync("external-stn", join(installDir, "stn-ingress"));
  writeText(releaseFile, "release\n", 0o600);
  const result = await settleWithin(running, 5_000, "managed-path revalidation");
  assertFailure(result, "launcher", "managed-path revalidation");
  assertEqual(
    readlinkSync(join(installDir, "stn-ingress")),
    "external-stn",
    "externally replaced launcher remains untouched",
  );
  assertRuntimeVersion(installDir, "v0.9.0", "managed-path runtime preservation", {
    aliases: false,
    assertAliasesAbsent: false,
  });
  assertEqual(readlinkSync(join(installDir, "stn-tmux-popup")), "stn", "unmodified popup remains");
  assertLicense(dataHome, "v0.9.0", "managed-path license preservation");
  assertNoInstallerResidue(installDir, dataHome);

  for (const resource of ["popup", "binary", "license"]) {
    const replacementInstallDir = join(root, `revalidated-${resource}-bin`);
    const replacementDataHome = join(root, `revalidated-${resource}-data`);
    const replacementMarker = join(root, `revalidated-${resource}.ready`);
    const replacementRelease = join(root, `revalidated-${resource}.release`);
    seedInstallation({
      installDir: replacementInstallDir,
      dataHome: replacementDataHome,
      tag: "v0.9.0",
    });
    const replacementRunning = runInstaller({
      installDir: replacementInstallDir,
      platform: linuxX64(),
      version: stableTag,
      dataHome: replacementDataHome,
      asynchronous: true,
      environment: {
        FAKE_GH_BLOCK_PHASE: "archive-download",
        FAKE_BLOCK_MARKER: replacementMarker,
        FAKE_BLOCK_RELEASE: replacementRelease,
      },
    });
    await waitForPath(replacementMarker, `${resource} revalidation point`);
    const replacementPath =
      resource === "popup"
        ? join(replacementInstallDir, "stn-tmux-popup")
        : resource === "binary"
          ? join(replacementInstallDir, "stn")
          : join(replacementDataHome, "station", "LICENSE");
    rmSync(replacementPath, { recursive: true, force: true });
    if (resource === "popup") symlinkSync("external-stn", replacementPath);
    else makeDirectory(replacementPath);
    writeText(replacementRelease, "release\n", 0o600);
    const replacementResult = await settleWithin(
      replacementRunning,
      5_000,
      `${resource} managed-path revalidation`,
    );
    assertFailure(
      replacementResult,
      resource === "popup" ? "launcher" : resource,
      `${resource} revalidation`,
    );
    if (resource === "popup") {
      assertEqual(
        readlinkSync(replacementPath),
        "external-stn",
        "external popup remains untouched",
      );
      assertRuntimeVersion(
        replacementInstallDir,
        "v0.9.0",
        "popup replacement runtime preservation",
        { aliases: false, assertAliasesAbsent: false },
      );
      assertEqual(
        readlinkSync(join(replacementInstallDir, "stn-ingress")),
        "stn",
        "popup replacement leaves ingress",
      );
      assertLicense(replacementDataHome, "v0.9.0", "popup replacement license preservation");
    } else if (resource === "binary") {
      assert(
        statSync(replacementPath).isDirectory(),
        "external binary directory remains untouched",
      );
      assertLicense(replacementDataHome, "v0.9.0", "binary replacement license preservation");
    } else {
      assert(
        statSync(replacementPath).isDirectory(),
        "external license directory remains untouched",
      );
      assertRuntimeVersion(
        replacementInstallDir,
        "v0.9.0",
        "license replacement runtime preservation",
      );
    }
    assertNoInstallerResidue(replacementInstallDir, replacementDataHome);
  }

  const cleanupInstallDir = join(root, "cleanup-replaced-launcher-bin");
  const cleanupDataHome = join(root, "cleanup-replaced-launcher-data");
  const cleanupMarker = join(root, "cleanup-replaced-launcher.ready");
  seedInstallation({
    installDir: cleanupInstallDir,
    dataHome: cleanupDataHome,
    tag: "v0.9.0",
    withAliases: false,
  });
  const blocking = makeBlockingShim("mv", join(cleanupInstallDir, "stn"), cleanupMarker);
  const cleanupRunning = runInstaller({
    installDir: cleanupInstallDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome: cleanupDataHome,
    asynchronous: true,
    commandBinDirs: [blocking.directory],
    environment: blocking.environment,
  });
  await waitForPath(cleanupMarker, "external replacement cleanup point");
  unlinkSync(join(cleanupInstallDir, "stn-ingress"));
  writeText(join(cleanupInstallDir, "stn-ingress"), "external replacement\n", 0o600);
  signalProcessGroup(cleanupRunning.child, "SIGTERM");
  const cleanupResult = await settleWithin(cleanupRunning, 5_000, "external replacement cleanup");
  assertExactStatus(cleanupResult, 143, "external replacement cleanup");
  assertEqual(
    readFileSync(join(cleanupInstallDir, "stn-ingress"), "utf8"),
    "external replacement\n",
    "cleanup preserves externally replaced launcher",
  );
  assert(
    !existsSync(join(cleanupInstallDir, "stn-tmux-popup")),
    "cleanup removes owned popup alias",
  );
  assertRuntimeVersion(cleanupInstallDir, "v0.9.0", "cleanup replacement runtime", {
    aliases: false,
    assertAliasesAbsent: false,
  });
  assertLicense(cleanupDataHome, "v0.9.0", "cleanup replacement license rollback");
  assertIncludes(cleanupResult.stderr, "changed during cleanup", "cleanup replacement warning");
  assertNoInstallerResidue(cleanupInstallDir, cleanupDataHome);
}

async function scenarioContinuousReaders() {
  const installDir = join(root, "continuous-readers-bin");
  const dataHome = join(root, "continuous-readers-data");
  const probePid = join(root, "continuous-readers-probe.pid");
  const releaseFile = join(root, "continuous-readers-probe.release");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
  const running = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.8",
    dataHome,
    asynchronous: true,
    environment: {
      FAKE_PROBE_PID_FILE: probePid,
      FAKE_PROBE_RELEASE_FILE: releaseFile,
    },
  });
  await waitForPath(probePid, "continuous reader probe");
  const reader = startVersionReaders(installDir);
  await reader.waitForVersion("0.9.0");
  writeText(releaseFile, "release\n", 0o600);
  assertSuccess(
    await settleWithin(running, 5_000, "continuous reader installer"),
    "continuous reader install",
  );
  await reader.waitForVersion("1.2.8");
  const observations = await reader.stop();
  for (const entrypoint of ["stn", "stn-ingress", "stn-tmux-popup"]) {
    const versions = observations.get(entrypoint);
    assert(versions.includes("0.9.0"), `${entrypoint} readers observed the old version`);
    assert(versions.includes("1.2.8"), `${entrypoint} readers observed the new version`);
    assertEqual(
      [...new Set(versions)].sort(),
      ["0.9.0", "1.2.8"],
      `${entrypoint} readers observed only complete versions`,
    );
  }
  assertInstalled({ installDir, dataHome, tag: "v1.2.8", target: "linux-x64" });
  assertNoInstallerResidue(installDir, dataHome);
}

async function scenarioCaughtSignals() {
  const signals = [
    { name: "SIGHUP", status: 129 },
    { name: "SIGINT", status: 130 },
    { name: "SIGTERM", status: 143 },
  ];

  for (const delivery of ["group", "parent"]) {
    for (const signal of signals) {
      await runSignalScenario("download", signal, delivery);
    }
  }
  for (const phase of ["probe", "finalization"]) {
    for (const signal of signals) {
      await runSignalScenario(phase, signal, "group");
    }
  }
}

async function scenarioGhSignalSupervision() {
  const phases = [
    { name: "auth", version: stableTag },
    { name: "latest" },
    { name: "published-archive-asset", version: stableTag },
    { name: "published-checksum-asset", version: stableTag },
    { name: "archive-download", version: stableTag },
    { name: "checksum-download", version: stableTag },
    { draft: true, name: "draft-release", version: rollbackTag },
    { draft: true, name: "draft-archive-asset", version: rollbackTag },
    { draft: true, name: "draft-checksum-asset", version: rollbackTag },
  ];

  for (const phase of phases) {
    const installDir = join(root, `gh-${phase.name}-signal-bin`);
    const dataHome = join(root, `gh-${phase.name}-signal-data`);
    const marker = join(root, `gh-${phase.name}-signal.ready`);
    const childPidFile = join(root, `gh-${phase.name}-signal.pid`);
    const releaseFile = join(root, `gh-${phase.name}-signal.release`);
    seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
    const running = runInstaller({
      installDir,
      platform: linuxX64(),
      version: phase.version,
      releaseId: phase.draft ? "42" : undefined,
      dataHome,
      asynchronous: true,
      environment: {
        FAKE_GH_BLOCK_PHASE: phase.name,
        FAKE_BLOCK_MARKER: marker,
        FAKE_BLOCK_PID_FILE: childPidFile,
        FAKE_BLOCK_RELEASE: releaseFile,
      },
    });
    await waitForPath(marker, `${phase.name} signal injection point`);
    await waitForPath(childPidFile, `${phase.name} child PID`);
    running.child.kill("SIGTERM");
    const result = await settleWithin(running, 5_000, `${phase.name} signal cleanup`);
    assertExactStatus(result, 143, `${phase.name} parent-only SIGTERM`);
    assertProcessGone(Number(readFileSync(childPidFile, "utf8")), `${phase.name} gh child`);
    assertRuntimeVersion(installDir, "v0.9.0", `${phase.name} runtime preservation`);
    assertLicense(dataHome, "v0.9.0", `${phase.name} license preservation`);
    assertNoInstallerResidue(installDir, dataHome);
  }
}

async function scenarioRepeatedSignalCleanup() {
  const installDir = join(root, "repeated-signal-bin");
  const dataHome = join(root, "repeated-signal-data");
  const marker = join(root, "repeated-signal.ready");
  const childPidFile = join(root, "repeated-signal.pid");
  const releaseFile = join(root, "repeated-signal.release");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
  const running = runInstaller({
    installDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome,
    asynchronous: true,
    environment: {
      FAKE_GH_BLOCK_PHASE: "archive-download",
      FAKE_BLOCK_MARKER: marker,
      FAKE_BLOCK_PID_FILE: childPidFile,
      FAKE_BLOCK_RELEASE: releaseFile,
    },
  });
  await waitForPath(marker, "repeated signal injection point");
  await waitForPath(childPidFile, "repeated signal child PID");
  running.child.kill("SIGTERM");
  await delay(25);
  if (!running.settled) running.child.kill("SIGINT");
  const result = await settleWithin(running, 5_000, "repeated signal cleanup");
  assertExactStatus(result, 143, "first signal controls cleanup status");
  assertProcessGone(Number(readFileSync(childPidFile, "utf8")), "repeated signal gh child");
  assertRuntimeVersion(installDir, "v0.9.0", "repeated signal runtime preservation");
  assertLicense(dataHome, "v0.9.0", "repeated signal license preservation");
  assertNoInstallerResidue(installDir, dataHome);
}

async function scenarioAliasCreationSignal() {
  const installDir = join(root, "alias-signal-bin");
  const dataHome = join(root, "alias-signal-data");
  const marker = join(root, "alias-signal.ready");
  const releaseFile = join(root, "alias-signal.release");
  const shim = makeLinkThenBlockShim(join(installDir, "stn-ingress"), marker, releaseFile);
  const running = runInstaller({
    installDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome,
    asynchronous: true,
    commandBinDirs: [shim.directory],
    environment: shim.environment,
  });
  await waitForPath(marker, "alias creation signal point");
  signalProcessGroup(running.child, "SIGTERM");
  writeText(releaseFile, "release\n", 0o600);
  const result = await settleWithin(running, 5_000, "alias creation signal cleanup");
  assertExactStatus(result, 143, "alias creation signal status");
  for (const path of [
    join(installDir, "stn"),
    join(installDir, "stn-ingress"),
    join(installDir, "stn-tmux-popup"),
    join(dataHome, "station", "LICENSE"),
  ]) {
    assert(!existsSync(path), `alias signal cleanup removes ${path}`);
  }
  assertNoInstallerResidue(installDir, dataHome);

  const replacedInstallDir = join(root, "alias-signal-replaced-bin");
  const replacedDataHome = join(root, "alias-signal-replaced-data");
  const replacedMarker = join(root, "alias-signal-replaced.ready");
  const replacedRelease = join(root, "alias-signal-replaced.release");
  const replacedPath = join(replacedInstallDir, "stn-ingress");
  const replacedShim = makeLinkThenBlockShim(replacedPath, replacedMarker, replacedRelease);
  const replacedRunning = runInstaller({
    installDir: replacedInstallDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome: replacedDataHome,
    asynchronous: true,
    commandBinDirs: [replacedShim.directory],
    environment: replacedShim.environment,
  });
  await waitForPath(replacedMarker, "same-target alias replacement point");
  unlinkSync(replacedPath);
  symlinkSync("stn", replacedPath);
  signalProcessGroup(replacedRunning.child, "SIGTERM");
  writeText(replacedRelease, "release\n", 0o600);
  const replacedResult = await settleWithin(
    replacedRunning,
    5_000,
    "same-target alias replacement cleanup",
  );
  assertExactStatus(replacedResult, 143, "same-target alias replacement signal status");
  assertEqual(readlinkSync(replacedPath), "stn", "same-target external alias remains untouched");
  assertIncludes(
    replacedResult.stderr,
    "changed during cleanup",
    "same-target external alias warning",
  );
  for (const path of [
    join(replacedInstallDir, "stn"),
    join(replacedInstallDir, "stn-tmux-popup"),
    join(replacedDataHome, "station", "LICENSE"),
  ]) {
    assert(!existsSync(path), `same-target alias cleanup leaves ${path} absent`);
  }
  assertNoInstallerResidue(replacedInstallDir, replacedDataHome);
}

async function runSignalScenario(phase, signal, delivery) {
  const slug = `${phase}-${delivery}-${signal.name.toLowerCase()}`;
  const installDir = join(root, `${slug}-bin`);
  const dataHome = join(root, `${slug}-data`);
  const marker = join(root, `${slug}.ready`);
  const childPidFile = join(root, `${slug}.child-pid`);
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
      FAKE_BLOCK_PID_FILE: childPidFile,
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
  if (phase === "download") {
    await waitForPath(childPidFile, `${phase} ${signal.name} child PID`);
  }
  if (delivery === "group") signalProcessGroup(running.child, signal.name);
  else running.child.kill(signal.name);
  const result = await settleWithin(running, 5_000, `${phase} ${signal.name}`);
  assertExactStatus(result, signal.status, `${phase} ${delivery} ${signal.name}`);
  assertRuntimeVersion(installDir, "v0.9.0", `${phase} ${signal.name} runtime coherence`);
  assertLicense(dataHome, "v0.9.0", `${phase} ${signal.name} license rollback`);
  if (phase === "download") {
    assertProcessGone(Number(readFileSync(childPidFile, "utf8")), `${phase} ${delivery} gh child`);
  }
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
  assertExactStatus(result, 143, "signal during lock acquisition");
  assertRuntimeVersion(installDir, "v0.9.0", "lock acquisition signal runtime coherence");
  assertLicense(dataHome, "v0.9.0", "lock acquisition signal license preservation");
  assertNoInstallerResidue(installDir, dataHome);
}

async function scenarioSigkillLeavesActionableLocks() {
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
  const licenseLockPath = join(dataHome, "station", ".station-install.lock");
  await waitForPath(lockPath, "SIGKILL-owned lock");
  await waitForPath(licenseLockPath, "SIGKILL-owned license lock");
  signalProcessGroup(killed.child, "SIGKILL");
  const killedResult = await settleWithin(killed, 5_000, "SIGKILL installer");
  assertEqual(killedResult.signal, "SIGKILL", "SIGKILL installer signal");
  assert(existsSync(lockPath), "SIGKILL leaves the owned destination lock");
  assert(existsSync(licenseLockPath), "SIGKILL leaves the owned license lock");
  assertRuntimeVersion(installDir, "v0.9.0", "SIGKILL runtime coherence");
  assertProcessGone(Number(readFileSync(probePid, "utf8")), "SIGKILL probe child");

  const refused = runInstaller({ installDir, platform: linuxX64(), dataHome });
  assertFailure(refused, lockPath, "stale lock refusal");
  assertIncludes(refused.stderr, String(killed.child.pid), "stale lock owner PID");
  assertIncludes(refused.stderr, "alive", "stale lock dead-PID inspection UX");
  assertIncludes(refused.stderr, "Wait", "stale lock wait UX");
  assertIncludes(refused.stderr, "manually", "stale lock manual recovery UX");
  assertIncludes(refused.stderr, "retry", "stale lock retry UX");
  assertNoGhApiCalls(refused, "stale lock refusal");

  rmSync(lockPath, { recursive: true });
  const licenseRefused = runInstaller({ installDir, platform: linuxX64(), dataHome });
  assertFailure(licenseRefused, licenseLockPath, "stale license lock refusal");
  assertIncludes(licenseRefused.stderr, String(killed.child.pid), "stale license lock owner PID");
  assertIncludes(licenseRefused.stderr, "alive", "stale license lock dead-PID inspection UX");
  assertIncludes(licenseRefused.stderr, "Wait", "stale license lock wait UX");
  assertIncludes(licenseRefused.stderr, "manually", "stale license lock manual recovery UX");
  assertIncludes(licenseRefused.stderr, "retry", "stale license lock retry UX");
  assert(!existsSync(lockPath), "stale license refusal releases newly acquired command lock");
  assertNoGhApiCalls(licenseRefused, "stale license lock refusal");

  rmSync(licenseLockPath, { recursive: true });
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

  const committedInstallDir = join(root, "sigkill-after-commit-bin");
  const committedDataHome = join(root, "sigkill-after-commit-data");
  const committedMarker = join(root, "sigkill-after-commit.ready");
  seedInstallation({ installDir: committedInstallDir, dataHome: committedDataHome, tag: "v0.9.0" });
  const committedShim = makeMoveThenBlockShim(join(committedInstallDir, "stn"), committedMarker);
  const committed = runInstaller({
    installDir: committedInstallDir,
    platform: linuxX64(),
    version: stableTag,
    dataHome: committedDataHome,
    asynchronous: true,
    commandBinDirs: [committedShim.directory],
    environment: committedShim.environment,
  });
  const committedLock = join(committedInstallDir, ".station-install.lock");
  const committedLicenseLock = join(committedDataHome, "station", ".station-install.lock");
  await waitForPath(committedMarker, "SIGKILL after runtime commit");
  await waitForPath(committedLock, "SIGKILL after-commit command lock");
  await waitForPath(committedLicenseLock, "SIGKILL after-commit license lock");
  signalProcessGroup(committed.child, "SIGKILL");
  const committedResult = await settleWithin(committed, 5_000, "SIGKILL after runtime commit");
  assertEqual(committedResult.signal, "SIGKILL", "SIGKILL after-commit installer signal");
  assertInstalled({
    installDir: committedInstallDir,
    dataHome: committedDataHome,
    tag: stableTag,
    target: "linux-x64",
  });
  assert(existsSync(committedLock), "SIGKILL after commit leaves command lock");
  assert(existsSync(committedLicenseLock), "SIGKILL after commit leaves license lock");

  const committedRefused = runInstaller({
    installDir: committedInstallDir,
    platform: linuxX64(),
    dataHome: committedDataHome,
  });
  assertFailure(committedRefused, committedLock, "after-commit stale command lock refusal");
  rmSync(committedLock, { recursive: true });
  const committedLicenseRefused = runInstaller({
    installDir: committedInstallDir,
    platform: linuxX64(),
    dataHome: committedDataHome,
  });
  assertFailure(
    committedLicenseRefused,
    committedLicenseLock,
    "after-commit stale license lock refusal",
  );
  assert(!existsSync(committedLock), "after-commit license refusal releases command lock");
  rmSync(committedLicenseLock, { recursive: true });
  const committedRetry = runInstaller({
    installDir: committedInstallDir,
    platform: linuxX64(),
    version: rollbackTag,
    dataHome: committedDataHome,
  });
  assertSuccess(committedRetry, "after-commit stale-lock recovery retry");
  assertInstalled({
    installDir: committedInstallDir,
    dataHome: committedDataHome,
    tag: rollbackTag,
    target: "linux-x64",
  });
}

async function runSelfInterruptChild() {
  const rootFile = process.env.STATION_SMOKE_SELF_ROOT_FILE;
  const readyFile = process.env.STATION_SMOKE_SELF_READY_FILE;
  const installerPidFile = process.env.STATION_SMOKE_SELF_INSTALLER_PID_FILE;
  const probePidCopy = process.env.STATION_SMOKE_SELF_PROBE_PID_FILE;
  if (!rootFile || !readyFile || !installerPidFile || !probePidCopy) {
    throw new Error("self-interruption child requires marker paths");
  }
  writeText(rootFile, `${root}\n`, 0o600);
  prepareFixtures();
  const installDir = join(root, "self-interruption-bin");
  const dataHome = join(root, "self-interruption-data");
  const probePid = join(root, "self-interruption-probe.pid");
  const releaseFile = join(root, "self-interruption-probe.release");
  seedInstallation({ installDir, dataHome, tag: "v0.9.0" });
  const running = runInstaller({
    installDir,
    platform: linuxX64(),
    version: "v1.2.8",
    dataHome,
    asynchronous: true,
    environment: {
      FAKE_PROBE_PID_FILE: probePid,
      FAKE_PROBE_RELEASE_FILE: releaseFile,
    },
  });
  await waitForPath(probePid, "self-interruption probe");
  writeText(installerPidFile, `${running.child.pid}\n`, 0o600);
  writeText(probePidCopy, readFileSync(probePid, "utf8"), 0o600);
  writeText(readyFile, "ready\n", 0o600);
  await new Promise(() => {});
}

async function scenarioSelfInterruption() {
  const childRootFile = join(root, "self-interruption-child-root");
  const readyFile = join(root, "self-interruption-child.ready");
  const installerPidFile = join(root, "self-interruption-installer.pid");
  const probePidFile = join(root, "self-interruption-probe.pid");
  const child = spawn(process.execPath, [runner, "--self-interrupt-child"], {
    detached: true,
    env: {
      ...process.env,
      STATION_SMOKE_SELF_ROOT_FILE: childRootFile,
      STATION_SMOKE_SELF_READY_FILE: readyFile,
      STATION_SMOKE_SELF_INSTALLER_PID_FILE: installerPidFile,
      STATION_SMOKE_SELF_PROBE_PID_FILE: probePidFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running = trackChild(child, { label: "self-interruption runner" });
  await waitForPath(readyFile, "self-interruption child readiness", markerTimeoutMs);
  const childRoot = readFileSync(childRootFile, "utf8").trim();
  const installerPid = Number(readFileSync(installerPidFile, "utf8"));
  const probePid = Number(readFileSync(probePidFile, "utf8"));
  assert(existsSync(childRoot), "self-interruption child temp root exists before signal");
  child.kill("SIGTERM");
  const result = await settleWithin(running, 10_000, "self-interruption runner");
  assertExactStatus(result, 143, "self-interruption runner status");
  assert(!existsSync(childRoot), "self-interruption removes the child temp root");
  assertProcessGone(installerPid, "self-interruption installer child");
  assertProcessGone(probePid, "self-interruption probe child");
}

function scenarioHelp() {
  const help = spawnSync("/bin/sh", [installer, "--help"], syncOptions());
  assertSuccess(help, "installer help");
  assertIncludes(help.stdout, "--install-dir", "installer help options");
  assertIncludes(help.stdout, "--persist-path", "installer persistence help option");
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
    writeReleaseBinary(join(payloadDir, "stn"), {
      tag,
      target,
      mode: options.probeMode,
      reportedVersion: options.reportedVersion,
    });
    symlinkSync(options.ingressTarget ?? "stn", join(payloadDir, "stn-ingress"));
    symlinkSync(options.popupTarget ?? "stn", join(payloadDir, "stn-tmux-popup"));
    writeText(join(payloadDir, "LICENSE"), `Station fixture license ${tag}\n`, 0o644);

    const members = ["stn", "stn-ingress", "stn-tmux-popup", "LICENSE"].filter(
      (member) => member !== options.omitMember,
    );
    if (options.extraMember !== undefined) {
      writeText(join(payloadDir, options.extraMember), "unapproved archive payload\n", 0o755);
      members.push(options.extraMember);
    }
    if (options.duplicateMember !== undefined) members.push(options.duplicateMember);
    if (options.unreadableArchive) {
      writeText(archivePath, "not a gzip-compressed tar archive\n", 0o600);
    } else {
      spawnChecked("tar", ["-czf", archivePath, "-C", payloadDir, ...members], "fixture archive");
    }
    chmodSync(archivePath, 0o600);
    const hash = options.corruptChecksum
      ? "0".repeat(64)
      : createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    if (options.checksumMode !== "missing") {
      checksums.push(
        options.checksumMode === "malformed"
          ? `not-a-sha256  ${archiveName}`
          : `${hash}  ${archiveName}`,
      );
    }
    if (options.checksumMode === "duplicate") checksums.push(`${hash} *${archiveName}`);
  }

  writeText(join(releaseDir, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`, 0o600);
}

function createManualRelease(tag, target, entries) {
  const releaseDir = join(releasesDir, tag);
  makeDirectory(releaseDir);
  const archiveName = `stn-${tag}-${target}.tar.gz`;
  const archivePath = join(releaseDir, archiveName);
  writeFileSync(archivePath, gzipSync(writeTar(entries)), { mode: 0o600 });
  const hash = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  writeText(join(releaseDir, "SHA256SUMS"), `${hash}  ${archiveName}\n`, 0o600);
}

function tarFile(name, content, mode) {
  return { content: Buffer.from(content), mode, name, type: "0" };
}

function tarSymlink(name, target) {
  return { content: Buffer.alloc(0), mode: 0o777, name, target, type: "2" };
}

function tarHardlink(name, target) {
  return { content: Buffer.alloc(0), mode: 0o644, name, target, type: "1" };
}

function writeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.type === "0" ? entry.content.length : 0);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, "ascii");
    if (entry.target !== undefined) writeTarString(header, 157, 100, entry.target);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header);
    if (entry.type === "0") {
      blocks.push(entry.content);
      const remainder = entry.content.length % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeTarString(buffer, offset, length, value) {
  const encoded = Buffer.from(value);
  assert(encoded.length < length, `tar field ${value} fits in ${length} bytes`);
  encoded.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function writeReleaseBinary(path, options) {
  writeExecutable(path, releaseBinarySource(options.tag, options.target, options));
}

function releaseBinarySource(tag, target, { mode, reportedVersion } = {}) {
  const version = reportedVersion ?? tag.slice(1);
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
  if (mode === "flood") {
    versionBody = [
      "i=0",
      'while [ "$i" -lt 20000 ]; do',
      "  printf 'loader diagnostic \\033[31munsafe\\007\\r\\n' >&2",
      "  printf 'untrusted stdout flood payload\\n'",
      "  i=$((i + 1))",
      "done",
      "exit 126",
    ].join("\n  ");
  }
  if (mode === "stdout-flood") {
    versionBody = "while :; do printf 'untrusted stdout flood payload\\n'; done";
  }
  if (mode === "diagnostic") {
    versionBody = "printf 'loader \\033[31mdiagnostic\\007\\r\\n' >&2; exit 126";
  }
  if (mode === "secret-check") {
    versionBody = [
      `test -z "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}\${GH_ENTERPRISE_TOKEN:-}\${GITHUB_ENTERPRISE_TOKEN:-}"`,
      `test -z "\${ACTIONS_RUNTIME_TOKEN:-}\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}\${STATION_INSTALL_RELEASE_ID:-}"`,
      `printf '%s\\n' '${version}'`,
    ].join("\n  ");
  }

  return `#!/bin/sh
if [ "\${1:-}" = --version ]; then
  ${versionBody}
else
  printf '%s\\n' 'Station ${tag} ${target}'
fi
`;
}

function writeFakeCommands() {
  writeExecutable(
    join(fakeBinDir, "zsh"),
    `#!/bin/sh
set -eu
[ "\${1:-}" = -l ] || exit 2
FAKE_ZSH_LOGIN=1
shift
[ "\${1:-}" = -c ] || exit 2
[ ! -f "$HOME/.zshenv" ] || . "$HOME/.zshenv"
shift
eval "$1"
`,
  );
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
      "{",
      "  printf 'CALL\\n'",
      "  for argument do printf 'ARG=%s\\n' \"$argument\"; done",
      "  printf 'END\\n'",
      '} >> "$FAKE_GH_ARGV_LOG"',
      'chmod 600 "$FAKE_GH_LOG"',
      'chmod 600 "$FAKE_GH_ARGV_LOG"',
      '[ "$GH_HOST" = github.com ] || exit 3',
      "block_phase() {",
      "  phase=$1",
      `  if [ "\${FAKE_GH_BLOCK_PHASE:-}" != "$phase" ]; then`,
      `    if [ "$phase" != archive-download ] || [ "\${FAKE_GH_BLOCK_DOWNLOAD:-0}" != 1 ]; then return 0; fi`,
      "  fi",
      '  : > "$FAKE_BLOCK_MARKER"',
      '  chmod 600 "$FAKE_BLOCK_MARKER"',
      `  if [ -n "\${FAKE_BLOCK_PID_FILE:-}" ]; then printf "%s\\n" "$$" > "$FAKE_BLOCK_PID_FILE"; chmod 600 "$FAKE_BLOCK_PID_FILE"; fi`,
      "  trap 'exit 129' HUP",
      "  trap 'exit 130' INT",
      "  trap 'exit 143' TERM",
      '  while [ ! -e "$FAKE_BLOCK_RELEASE" ]; do /bin/sleep 0.02; done',
      "}",
      `if [ "\${1:-}" = auth ]; then`,
      '  [ "$#" -eq 4 ]',
      '  [ "$1" = auth ]',
      '  [ "$2" = status ]',
      '  [ "$3" = --hostname ]',
      '  [ "$4" = github.com ]',
      "  block_phase auth",
      `  [ "\${FAKE_GH_AUTH:-1}" = 1 ]`,
      "  exit",
      "fi",
      `[ "\${1:-}" = api ] || exit 2`,
      "shift",
      'endpoint=""',
      'jq_filter=""',
      'accept_header=""',
      "paginate=0",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -H) [ "$#" -ge 2 ]; accept_header=$2; shift 2 ;;',
      "    --paginate) paginate=1; shift ;;",
      '    --jq) [ "$#" -ge 2 ]; jq_filter=$2; shift 2 ;;',
      "    -*) exit 2 ;;",
      '    *) [ -z "$endpoint" ]; endpoint=$1; shift ;;',
      "  esac",
      "done",
      'case "$endpoint" in',
      '  "repos/jeremy0dell/station/releases/latest")',
      '    [ "$paginate" -eq 0 ] && [ -z "$accept_header" ]',
      '    [ "$jq_filter" = .tag_name ] || exit 2',
      `    [ "\${FAKE_GH_FAIL_PHASE:-}" != latest ] || exit 74`,
      "    block_phase latest",
      "    printf '%s\\n' \"$FAKE_LATEST_TAG\"",
      "    ;;",
      '  "repos/jeremy0dell/station/releases/tags/$FAKE_TAG")',
      '    [ "$paginate" -eq 0 ] && [ -z "$accept_header" ]',
      `    [ "\${FAKE_GH_FAIL_PHASE:-}" != release ] || exit 74`,
      '    archive_filter=".assets[] | select(.name == \\"$FAKE_ARCHIVE\\") | .id"',
      '    checksum_filter=".assets[] | select(.name == \\"SHA256SUMS\\") | .id"',
      '    if [ "$jq_filter" = "$archive_filter" ]; then',
      "      block_phase published-archive-asset",
      `      count=\${FAKE_ARCHIVE_ASSET_COUNT:-1}`,
      `      [ "\${FAKE_DUPLICATE_ARCHIVE:-0}" = 0 ] || count=2`,
      '      case "$count" in 0) ;; 1) printf "1\\n" ;; 2) printf "1\\n3\\n" ;; *) exit 2 ;; esac',
      '    elif [ "$jq_filter" = "$checksum_filter" ]; then',
      "      block_phase published-checksum-asset",
      `      count=\${FAKE_CHECKSUM_ASSET_COUNT:-1}`,
      '      case "$count" in 0) ;; 1) printf "2\\n" ;; 2) printf "2\\n4\\n" ;; *) exit 2 ;; esac',
      "    else",
      "      exit 2",
      "    fi",
      "    ;;",
      '  "repos/jeremy0dell/station/releases/$FAKE_RELEASE_ID")',
      '    [ "$paginate" -eq 0 ]',
      '    [ "$accept_header" = "X-GitHub-Api-Version: 2022-11-28" ]',
      `    [ "\${FAKE_GH_FAIL_PHASE:-}" != release ] || exit 74`,
      `    [ "\${FAKE_RELEASE_DRAFT:-1}" = 1 ] || exit 0`,
      '    [ "$FAKE_RELEASE_ID_TAG" = "$FAKE_TAG" ] || exit 0',
      '    draft_match="select(.draft == true and .id == $FAKE_RELEASE_ID and .tag_name == \\"$FAKE_TAG\\")"',
      '    if [ "$jq_filter" = "$draft_match | .id" ]; then',
      "        block_phase draft-release",
      "        printf '%s\\n' \"$FAKE_RELEASE_ID\"",
      '    elif [ "$jq_filter" = "$draft_match | .assets[] | select(.name == \\"$FAKE_ARCHIVE\\") | .id" ]; then',
      "      block_phase draft-archive-asset",
      `      count=\${FAKE_ARCHIVE_ASSET_COUNT:-1}`,
      `      [ "\${FAKE_DUPLICATE_ARCHIVE:-0}" = 0 ] || count=2`,
      '      case "$count" in 0) ;; 1) printf "1\\n" ;; 2) printf "1\\n3\\n" ;; *) exit 2 ;; esac',
      '    elif [ "$jq_filter" = "$draft_match | .assets[] | select(.name == \\"SHA256SUMS\\") | .id" ]; then',
      "      block_phase draft-checksum-asset",
      `      count=\${FAKE_CHECKSUM_ASSET_COUNT:-1}`,
      '      case "$count" in 0) ;; 1) printf "2\\n" ;; 2) printf "2\\n4\\n" ;; *) exit 2 ;; esac',
      "    else",
      "      exit 2",
      "    fi",
      "    ;;",
      '  "repos/jeremy0dell/station/releases/assets/1")',
      '    [ "$paginate" -eq 0 ] && [ -z "$jq_filter" ]',
      '    [ "$accept_header" = "Accept: application/octet-stream" ]',
      `    case "\${FAKE_GH_FAIL_PHASE:-}" in`,
      "      archive-download) exit 74 ;;",
      "      partial-archive) printf 'partial archive'; exit 74 ;;",
      "    esac",
      "    block_phase archive-download",
      '    cat "$FAKE_RELEASES/$FAKE_TAG/$FAKE_ARCHIVE"',
      "    ;;",
      '  "repos/jeremy0dell/station/releases/assets/2")',
      '    [ "$paginate" -eq 0 ] && [ -z "$jq_filter" ]',
      '    [ "$accept_header" = "Accept: application/octet-stream" ]',
      `    case "\${FAKE_GH_FAIL_PHASE:-}" in`,
      "      checksums-download) exit 74 ;;",
      "      partial-checksums) printf 'partial checksum'; exit 74 ;;",
      "    esac",
      "    block_phase checksum-download",
      '    cat "$FAKE_RELEASES/$FAKE_TAG/SHA256SUMS"',
      "    ;;",
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
  includeInstallDirOnPath = false,
  releaseId,
  releaseDraft = true,
  releaseIdTag,
  childShell = "/bin/sh",
  cwd = repoRoot,
  dataHome = dataDir,
  home = homeDir,
  unsetXdgDataHome = false,
  omitInstallDir = false,
  environment = {},
  umask,
  asynchronous = false,
  commandBinDirs = [],
  pathEntries,
  extraArguments = [],
  argumentsOverride,
}) {
  const tag = version ?? stableTag;
  const archive = `stn-${tag}-${platform.target}.tar.gz`;
  const commandPath = pathEntries ?? [...commandBinDirs, fakeBinDir, "/usr/bin", "/bin"];
  if (includeInstallDirOnPath) commandPath.push(absolutePath(installDir, cwd));
  const args = argumentsOverride === undefined ? [] : [...argumentsOverride];
  if (argumentsOverride === undefined) {
    if (version !== undefined) args.push("--version", version);
    args.push(...extraArguments);
    if (!omitInstallDir) args.push("--install-dir", installDir);
  }
  const ghLog = join(ghLogsDir, `${++invocationCount}.log`);
  const ghArgvLog = join(ghLogsDir, `${invocationCount}.argv.log`);
  const env = applyEnvironmentOverrides(
    {
      HOME: home,
      GH_HOST: "untrusted.example",
      PATH: commandPath.join(":"),
      TMPDIR: tempDir,
      XDG_DATA_HOME: unsetXdgDataHome ? undefined : dataHome,
      FAKE_ARCHIVE: archive,
      FAKE_DUPLICATE_ARCHIVE: duplicateArchiveAsset ? "1" : "0",
      FAKE_GH_AUTH: auth ? "1" : "0",
      FAKE_GH_ARGV_LOG: ghArgvLog,
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
  const options = { cwd, env };

  if (!asynchronous) {
    const supervisorPidFile = join(tempDir, `sync-installer-${invocationCount}.pid`);
    const stdoutFile = join(tempDir, `sync-installer-${invocationCount}.stdout`);
    const stderrFile = join(tempDir, `sync-installer-${invocationCount}.stderr`);
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        'printf "%s\\n" "$$" > "$1"; exec > "$2" 2> "$3"; shift 3; exec "$@"',
        "station-install-supervisor",
        supervisorPidFile,
        stdoutFile,
        stderrFile,
        invocation.command,
        ...invocation.args,
      ],
      syncOptions({ ...options, detached: true }),
    );
    if (result.error?.code === "ETIMEDOUT") {
      dumpHarnessState(`installer child timed out after ${childTimeoutMs}ms`);
      if (existsSync(supervisorPidFile)) {
        const supervisorPid = Number(readFileSync(supervisorPidFile, "utf8"));
        if (Number.isInteger(supervisorPid)) {
          try {
            process.kill(-supervisorPid, "SIGKILL");
          } catch {}
        }
      }
    }
    const stdout = existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf8") : "";
    const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, "utf8") : "";
    if (result.error?.code === "ETIMEDOUT") {
      process.stderr.write(
        `timed_out_phase=${env.FAKE_GH_FAIL_PHASE ?? "none"}\n` +
          `timed_out_stdout=${JSON.stringify(stdout.slice(-4096))}\n` +
          `timed_out_stderr=${JSON.stringify(stderr.slice(-4096))}\n`,
      );
    }
    for (const path of [supervisorPidFile, stdoutFile, stderrFile]) rmSync(path, { force: true });
    return { ...result, ghArgvLog, ghLog, stderr, stdout };
  }

  const child = spawn(invocation.command, invocation.args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return trackChild(child, { ghArgvLog, ghLog, label: `installer ${tag}` });
}

function trackChild(child, { ghArgvLog, ghLog, label }) {
  activeChildren.add(child);
  let stdout = "";
  let stderr = "";
  let spawnError;
  let timedOut = false;
  const appendBounded = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  const timeoutMs = Math.min(childTimeoutMs, remainingOverallTime());
  const timeout = setTimeout(() => {
    timedOut = true;
    dumpHarnessState(`${label} exceeded ${timeoutMs}ms`);
    signalProcessGroup(child, "SIGKILL");
  }, timeoutMs);
  const running = { child, ghArgvLog, ghLog, label, settled: false };
  running.completion = new Promise((resolveCompletion) => {
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      activeChildren.delete(child);
      running.settled = true;
      if (timedOut && spawnError === undefined) {
        spawnError = Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), {
          code: "ETIMEDOUT",
        });
      }
      resolveCompletion({
        error: spawnError,
        ghArgvLog,
        ghLog,
        signal,
        status,
        stderr,
        stdout,
      });
    });
  });
  return running;
}

function syncOptions(overrides = {}) {
  const requestedTimeout = overrides.timeout ?? childTimeoutMs;
  return {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1024 * 1024,
    ...overrides,
    timeout: Math.max(1, Math.min(requestedTimeout, remainingOverallTime())),
  };
}

function remainingOverallTime() {
  const remaining = overallTimeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new Error(`install smoke exceeded ${overallTimeoutMs}ms overall`);
  return remaining;
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
  const result = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) result[key] = value;
  }
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
source=''
for argument do source=$last; last=$argument; done
destination=$last
if [ "$FAKE_COMMAND" = ln ] && [ -d "$last" ]; then destination=$last/\${source##*/}; fi
if [ "$destination" = "$FAKE_FAIL_DESTINATION" ] && [ ! -e "$FAKE_SHIM_STATE" ]; then
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
      FAKE_COMMAND: command,
      FAKE_FAIL_DESTINATION: destination,
      FAKE_REAL_COMMAND: resolveCommand(command),
      FAKE_SHIM_STATE: state,
    },
  };
}

function makeMoveThenFailShim(destination) {
  const shimDir = join(root, "move-then-fail-shim");
  const state = join(root, "move-then-fail.state");
  makeDirectory(shimDir);
  writeExecutable(
    join(shimDir, "mv"),
    `#!/bin/sh
last=''
for argument do last=$argument; done
if [ "$last" = "$FAKE_FAIL_DESTINATION" ] && [ ! -e "$FAKE_SHIM_STATE" ]; then
  "$FAKE_REAL_COMMAND" "$@" || exit
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
      FAKE_REAL_COMMAND: resolveCommand("mv"),
      FAKE_SHIM_STATE: state,
    },
  };
}

function makeLinkThenFailShim(destination) {
  const shimDir = join(root, "link-then-fail-shim");
  const state = join(root, "link-then-fail.state");
  makeDirectory(shimDir);
  writeExecutable(
    join(shimDir, "ln"),
    `#!/bin/sh
last=''
source=''
for argument do source=$last; last=$argument; done
destination=$last
if [ -d "$last" ]; then destination=$last/\${source##*/}; fi
if [ "$destination" = "$FAKE_FAIL_DESTINATION" ] && [ ! -e "$FAKE_SHIM_STATE" ]; then
  "$FAKE_REAL_COMMAND" "$@" || exit
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
      FAKE_REAL_COMMAND: resolveCommand("ln"),
      FAKE_SHIM_STATE: state,
    },
  };
}

function makeLinkThenBlockShim(destination, marker, releaseFile) {
  const shimDir = join(root, "link-then-block-shim");
  makeDirectory(shimDir);
  writeExecutable(
    join(shimDir, "ln"),
    `#!/bin/sh
last=''
source=''
for argument do source=$last; last=$argument; done
destination=$last
if [ -d "$last" ]; then destination=$last/\${source##*/}; fi
if [ "$destination" = "$FAKE_BLOCK_DESTINATION" ]; then
  "$FAKE_REAL_COMMAND" "$@" || exit
  : > "$FAKE_BLOCK_MARKER"
  chmod 600 "$FAKE_BLOCK_MARKER"
  while [ ! -e "$FAKE_BLOCK_RELEASE" ]; do /bin/sleep 0.02; done
  exit 0
fi
exec "$FAKE_REAL_COMMAND" "$@"
`,
  );
  return {
    directory: shimDir,
    environment: {
      FAKE_BLOCK_DESTINATION: destination,
      FAKE_BLOCK_MARKER: marker,
      FAKE_BLOCK_RELEASE: releaseFile,
      FAKE_REAL_COMMAND: resolveCommand("ln"),
    },
  };
}

function makeCleanupWarningShim(prefix) {
  const shimDir = join(root, "cleanup-warning-shim");
  makeDirectory(shimDir);
  writeExecutable(
    join(shimDir, "rm"),
    `#!/bin/sh
last=''
for argument do last=$argument; done
case "$last" in
  "$FAKE_FAIL_PREFIX"/station-install.*) exit 71 ;;
esac
exec "$FAKE_REAL_COMMAND" "$@"
`,
  );
  return {
    directory: shimDir,
    environment: {
      FAKE_FAIL_PREFIX: prefix,
      FAKE_REAL_COMMAND: resolveCommand("rm"),
    },
  };
}

function makeMoveThenBlockShim(destination, marker) {
  const shimDir = join(root, "move-then-block-shim");
  makeDirectory(shimDir);
  writeExecutable(
    join(shimDir, "mv"),
    `#!/bin/sh
last=''
for argument do last=$argument; done
if [ "$last" = "$FAKE_BLOCK_DESTINATION" ]; then
  "$FAKE_REAL_COMMAND" "$@" || exit
  : > "$FAKE_BLOCK_MARKER"
  chmod 600 "$FAKE_BLOCK_MARKER"
  trap '' HUP INT TERM
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
      FAKE_REAL_COMMAND: resolveCommand("mv"),
    },
  };
}

function makeMkdirLoggingShim(logPath) {
  const shimDir = join(root, "mkdir-logging-shim");
  makeDirectory(shimDir);
  writeExecutable(
    join(shimDir, "mkdir"),
    `#!/bin/sh
last=''
for argument do last=$argument; done
printf 'mkdir %s\n' "$last" >> "$FAKE_LOCK_LOG"
exec "$FAKE_REAL_MKDIR" "$@"
`,
  );
  writeExecutable(
    join(shimDir, "rmdir"),
    `#!/bin/sh
last=''
for argument do last=$argument; done
printf 'rmdir %s\n' "$last" >> "$FAKE_LOCK_LOG"
exec "$FAKE_REAL_RMDIR" "$@"
`,
  );
  return {
    directory: shimDir,
    environment: {
      FAKE_LOCK_LOG: logPath,
      FAKE_REAL_MKDIR: resolveCommand("mkdir"),
      FAKE_REAL_RMDIR: resolveCommand("rmdir"),
    },
  };
}

function makeNoChecksumBin() {
  const directory = join(root, "no-checksum-bin");
  makeDirectory(directory);
  for (const command of [
    "awk",
    "cat",
    "chmod",
    "cp",
    "grep",
    "ls",
    "mkdir",
    "mktemp",
    "mv",
    "readlink",
    "rm",
    "rmdir",
    "sort",
    "tar",
  ]) {
    symlinkSync(resolveCommand(command), join(directory, command));
  }
  symlinkSync(join(fakeBinDir, "gh"), join(directory, "gh"));
  symlinkSync(join(fakeBinDir, "uname"), join(directory, "uname"));
  return directory;
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
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], syncOptions());
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
  const result = spawnSync(binary, [], syncOptions({ env: { PATH: "/usr/bin:/bin" } }));
  assertSuccess(result, `${target} installed binary`);
  assertEqual(result.stdout, `Station ${tag} ${target}\n`, `${target} installed version`);
  assertRuntimeVersion(installDir, tag, `${target} installed entrypoints`);
  assertLicense(dataHome, tag, `${target} installed license`);
  assertMode(binary, 0o755, `${target} executable mode`);
}

function assertRuntimeVersion(
  installDir,
  tag,
  label,
  { aliases = true, assertAliasesAbsent = !aliases } = {},
) {
  const entrypoints = aliases ? ["stn", "stn-ingress", "stn-tmux-popup"] : ["stn"];
  for (const entrypoint of entrypoints) {
    const path = join(installDir, entrypoint);
    const result = spawnSync(path, ["--version"], syncOptions({ env: { PATH: "/usr/bin:/bin" } }));
    assertSuccess(result, `${label} ${entrypoint}`);
    assertEqual(result.stdout, `${tag.slice(1)}\n`, `${label} ${entrypoint} version`);
  }
  if (aliases) {
    assertEqual(readlinkSync(join(installDir, "stn-ingress")), "stn", `${label} ingress link`);
    assertEqual(readlinkSync(join(installDir, "stn-tmux-popup")), "stn", `${label} popup link`);
  } else if (assertAliasesAbsent) {
    assert(!existsSync(join(installDir, "stn-ingress")), `${label} leaves ingress absent`);
    assert(!existsSync(join(installDir, "stn-tmux-popup")), `${label} leaves popup absent`);
  }
}

function assertPathRecovery(
  result,
  installDir,
  mismatches,
  initialPath = [fakeBinDir, "/usr/bin", "/bin"],
) {
  for (const launcher of mismatches) {
    assertIncludes(result.stdout, `PATH mismatch: ${launcher} `, `${launcher} PATH mismatch`);
  }
  for (const launcher of ["stn", "stn-ingress", "stn-tmux-popup"]) {
    if (!mismatches.includes(launcher)) {
      assertNotIncludes(result.stdout, `PATH mismatch: ${launcher} `, `${launcher} PATH match`);
    }
  }
  assertIncludes(result.stdout, "export PATH", "PATH recovery export");
  assertIncludes(result.stdout, "hash -r", "PATH recovery command cache reset");
  assertIncludes(result.stdout, "stn setup", "PATH recovery setup command");
  assertIncludes(result.stdout, "Absolute fallback:", "PATH recovery absolute fallback");

  const blockStart = result.stdout.indexOf("  PATH=");
  const blockEnd = result.stdout.indexOf("Absolute fallback:", blockStart);
  assert(blockStart >= 0 && blockEnd > blockStart, "PATH recovery block boundaries");
  const recoveryBlock = result.stdout
    .slice(blockStart + 2, blockEnd)
    .replace(/\n {2}(export PATH|hash -r|stn setup)\n/g, "\n$1\n");
  const reportDir = join(root, `path-recovery-${++invocationCount}`);
  makeDirectory(reportDir);
  const verification = spawnSync(
    "/bin/sh",
    [
      "-c",
      `${recoveryBlock}\nfor command in stn stn-ingress stn-tmux-popup; do command -v "$command" > "$PATH_REPORT_DIR/$command" || exit; done`,
    ],
    syncOptions({
      env: {
        HOME: homeDir,
        PATH: initialPath.join(":"),
        PATH_REPORT_DIR: reportDir,
      },
    }),
  );
  assertSuccess(verification, "PATH recovery block execution");
  for (const launcher of ["stn", "stn-ingress", "stn-tmux-popup"]) {
    assertEqual(
      readFileSync(join(reportDir, launcher), "utf8"),
      `${join(installDir, launcher)}\n`,
      `${launcher} recovery block resolution`,
    );
  }

  const fallbackCommand = result.stdout.slice(blockEnd + "Absolute fallback:".length).trim();
  const fallback = spawnSync(
    "/bin/sh",
    ["-c", fallbackCommand],
    syncOptions({ env: { HOME: homeDir, PATH: initialPath.join(":") } }),
  );
  assertSuccess(fallback, "absolute PATH fallback execution");
}

function startVersionReaders(installDir) {
  const observations = new Map(
    ["stn", "stn-ingress", "stn-tmux-popup"].map((entrypoint) => [entrypoint, []]),
  );
  let stopping = false;
  const loop = (async () => {
    while (!stopping) {
      for (const [entrypoint, versions] of observations) {
        const result = spawnSync(
          join(installDir, entrypoint),
          ["--version"],
          syncOptions({ env: { PATH: "/usr/bin:/bin" }, timeout: 2_000 }),
        );
        versions.push(
          result.status === 0 ? result.stdout.trim() : `failure:${result.status}:${result.signal}`,
        );
      }
      await delay(5);
    }
  })();
  return {
    async waitForVersion(version) {
      const deadline = Date.now() + markerTimeoutMs;
      while (Date.now() < deadline) {
        if ([...observations.values()].every((versions) => versions.includes(version))) return;
        await delay(5);
      }
      throw new Error(`continuous readers did not all observe ${version}`);
    },
    async stop() {
      stopping = true;
      await loop;
      return observations;
    },
  };
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

function onlyLockOwner(lockPath, label) {
  const owners = readdirSync(lockPath).filter(
    (name) => name === "owner" || name.startsWith("owner-"),
  );
  assertEqual(owners.length, 1, `${label} count`);
  const path = join(lockPath, owners[0]);
  return { content: readFileSync(path, "utf8"), path };
}

function assertMode(path, expected, label) {
  assertEqual(statSync(path).mode & 0o777, expected, label);
}

function ghCalls(result) {
  if (!existsSync(result.ghLog)) return [];
  return readFileSync(result.ghLog, "utf8").trimEnd().split("\n");
}

function ghInvocations(result) {
  if (!result.ghArgvLog || !existsSync(result.ghArgvLog)) return [];
  const invocations = [];
  let current;
  for (const line of readFileSync(result.ghArgvLog, "utf8").trimEnd().split("\n")) {
    if (line === "CALL") {
      assert(current === undefined, "fake gh argv log does not nest calls");
      current = [];
    } else if (line === "END") {
      assert(current !== undefined, "fake gh argv log ends a call after CALL");
      invocations.push(current);
      current = undefined;
    } else if (line.startsWith("ARG=")) {
      assert(current !== undefined, "fake gh argv log records arguments inside a call");
      current.push(line.slice(4));
    } else if (line !== "") {
      throw new Error(`unexpected fake gh argv log line: ${line}`);
    }
  }
  assert(current === undefined, "fake gh argv log closes every call");
  return invocations;
}

function assertStrictGhFlow(result, { draftId, latest = false, tag, target }) {
  const repository = "repos/jeremy0dell/station";
  const archiveName = `stn-${tag}-${target}.tar.gz`;
  const tagEndpoint = `${repository}/releases/tags/${tag}`;
  const archiveFilter = `.assets[] | select(.name == "${archiveName}") | .id`;
  const checksumFilter = '.assets[] | select(.name == "SHA256SUMS") | .id';
  const expected = [["auth", "status", "--hostname", "github.com"]];
  if (latest) expected.push(["api", `${repository}/releases/latest`, "--jq", ".tag_name"]);
  if (draftId === undefined) {
    expected.push(["api", tagEndpoint, "--jq", archiveFilter]);
    expected.push(["api", tagEndpoint, "--jq", checksumFilter]);
  } else {
    const endpoint = `${repository}/releases/${draftId}`;
    const match = `select(.draft == true and .id == ${draftId} and .tag_name == "${tag}")`;
    const prefix = ["api", "-H", "X-GitHub-Api-Version: 2022-11-28", endpoint, "--jq"];
    expected.push([...prefix, `${match} | .id`]);
    expected.push([...prefix, `${match} | .assets[] | select(.name == "${archiveName}") | .id`]);
    expected.push([...prefix, `${match} | .assets[] | select(.name == "SHA256SUMS") | .id`]);
  }
  expected.push([
    "api",
    "-H",
    "Accept: application/octet-stream",
    `${repository}/releases/assets/1`,
  ]);
  expected.push([
    "api",
    "-H",
    "Accept: application/octet-stream",
    `${repository}/releases/assets/2`,
  ]);
  assertEqual(ghInvocations(result), expected, `${tag} strict gh argv flow`);
}

function assertNoGhApiCalls(result, label) {
  assertEqual(
    ghCalls(result).filter((call) => call.startsWith("api ")),
    [],
    `${label} release API calls`,
  );
}

function spawnChecked(command, args, label) {
  const result = spawnSync(command, args, syncOptions());
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

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function waitForPath(path, label, timeoutMs = markerTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(20);
  }
  dumpHarnessState(`${label} marker timeout`);
  throw new Error(`${label}: ${path} did not appear within ${timeoutMs}ms`);
}

async function settleWithin(running, timeoutMs, label) {
  const timeout = Symbol("timeout");
  const result = await Promise.race([running.completion, delay(timeoutMs).then(() => timeout)]);
  if (result !== timeout) return result;
  dumpHarnessState(`${label} settlement timeout`);
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
  const exits = children.map(
    (child) =>
      new Promise((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) resolveExit();
        else child.once("close", resolveExit);
      }),
  );
  for (const child of children) signalProcessGroup(child, "SIGTERM");
  await Promise.race([Promise.all(exits), delay(1_000)]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) signalProcessGroup(child, "SIGKILL");
  }
  await Promise.all(exits);
}

function cleanupHarness() {
  if (cleanupPromise !== undefined) return cleanupPromise;
  cleanupPromise = (async () => {
    if (overallTimer !== undefined) clearTimeout(overallTimer);
    await stopActiveChildren();
    if (existsSync(root)) {
      try {
        chmodSync(root, 0o700);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
    process.umask(inheritedUmask);
  })();
  return cleanupPromise;
}

function dumpHarnessState(reason) {
  const paths = [];
  const visit = (directory, depth) => {
    if (depth > 3 || paths.length >= 120 || !existsSync(directory)) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      paths.push(path.slice(root.length + 1));
      if (entry.isDirectory()) visit(path, depth + 1);
      if (paths.length >= 120) return;
    }
  };
  visit(root, 0);
  const children = [...activeChildren].map((child) => ({
    exitCode: child.exitCode,
    pid: child.pid,
    signalCode: child.signalCode,
  }));
  process.stderr.write(
    `\ninstall smoke diagnostic: ${reason}\nelapsed_ms=${Date.now() - startedAt}\nroot=${root}\nchildren=${JSON.stringify(children)}\npaths=${JSON.stringify(paths)}\n`,
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

function assertExactStatus(result, status, label) {
  if (result.status === status && result.signal === null) return;
  throw new Error(
    `${label}: expected status ${status} and no signal, received ${result.status}/${result.signal}`,
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
