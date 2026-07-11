#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const installer = join(repoRoot, "scripts", "install.sh");
const root = mkdtempSync(join(tmpdir(), "station-install-smoke-"));
const releasesDir = join(root, "releases");
const fakeBinDir = join(root, "bin");
const homeDir = join(root, "home");
const dataDir = join(root, "data");
const stableTag = "v1.2.3";
const rollbackTag = "v1.2.3-rc.1";

const platforms = [
  { system: "Darwin", machine: "arm64", target: "darwin-arm64" },
  { system: "Darwin", machine: "x86_64", target: "darwin-x64" },
  { system: "Linux", machine: "aarch64", target: "linux-arm64" },
  { system: "Linux", machine: "x86_64", target: "linux-x64" },
];

try {
  mkdirSync(releasesDir, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFakeCommands();

  createRelease(
    stableTag,
    platforms.map(({ target }) => target),
  );
  createRelease(rollbackTag, ["linux-x64"]);
  createRelease("v1.2.4", ["linux-x64"], { corruptChecksum: true });
  createRelease("v1.2.5", ["linux-x64"], { extraMember: "postinstall" });
  createRelease("v1.2.6", ["linux-x64"], { probeFailure: true });

  for (const platform of platforms) {
    const installDir = join(root, `install-${platform.target}`);
    const result = runInstaller({ installDir, platform });
    assertSuccess(result, `${platform.target} latest install`);
    assertInstalled({ installDir, tag: stableTag, target: platform.target });
    assertIncludes(result.stdout, `Add ${installDir} to PATH`, `${platform.target} PATH hint`);
  }

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
  assertNotIncludes(rollback.stdout, "Add ", "PATH hint when install directory is already present");

  const draftDir = join(root, "draft-bin");
  const draft = runInstaller({
    installDir: draftDir,
    platform: linuxX64(),
    version: rollbackTag,
    releaseId: "42",
  });
  assertSuccess(draft, "draft release ID install");
  assertInstalled({ installDir: draftDir, tag: rollbackTag, target: "linux-x64" });

  const preservedDir = join(root, "preserved-bin");
  mkdirSync(preservedDir, { recursive: true });
  const preservedBinary = join(preservedDir, "stn");
  writeFileSync(preservedBinary, "existing installation\n", { mode: 0o755 });

  const badChecksum = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: "v1.2.4",
  });
  assertFailure(badChecksum, "checksum verification failed", "checksum rejection");
  assertEqual(
    readFileSync(preservedBinary, "utf8"),
    "existing installation\n",
    "checksum preservation",
  );

  const malicious = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: "v1.2.5",
  });
  assertFailure(malicious, "exact Station release manifest", "unexpected archive member");
  assertEqual(
    readFileSync(preservedBinary, "utf8"),
    "existing installation\n",
    "manifest preservation",
  );

  const incompatible = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: "v1.2.6",
  });
  assertFailure(incompatible, "cannot run on this system", "binary compatibility probe");
  assertEqual(
    readFileSync(preservedBinary, "utf8"),
    "existing installation\n",
    "probe preservation",
  );

  const duplicateAsset = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: stableTag,
    duplicateArchiveAsset: true,
  });
  assertFailure(duplicateAsset, "exactly one", "duplicate asset rejection");

  const duplicateDraftAsset = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: stableTag,
    releaseId: "42",
    duplicateArchiveAsset: true,
  });
  assertFailure(duplicateDraftAsset, "exactly one", "duplicate draft asset rejection");

  const duplicateDraftRelease = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: stableTag,
    releaseId: "42",
    duplicateDraftRelease: true,
  });
  assertFailure(duplicateDraftRelease, "no single draft matched", "duplicate draft release");

  const mismatchedDraft = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: stableTag,
    releaseId: "42",
    releaseIdTag: rollbackTag,
  });
  assertFailure(mismatchedDraft, "no single draft matched", "draft tag mismatch");

  const publishedRelease = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: stableTag,
    releaseId: "42",
    releaseDraft: false,
  });
  assertFailure(publishedRelease, "no single draft matched", "published release ID refusal");

  const invalidDraftId = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: stableTag,
    releaseId: "draft-42",
  });
  assertFailure(invalidDraftId, "must be a numeric", "invalid draft release ID");

  const unauthenticated = runInstaller({
    auth: false,
    installDir: preservedDir,
    platform: linuxX64(),
  });
  assertFailure(unauthenticated, "gh auth login", "authentication failure");
  assertEqual(
    readFileSync(preservedBinary, "utf8"),
    "existing installation\n",
    "auth preservation",
  );

  const unsupported = runInstaller({
    installDir: preservedDir,
    platform: { system: "FreeBSD", machine: "x86_64", target: "unsupported" },
  });
  assertFailure(unsupported, "unsupported platform", "unsupported platform");

  const invalidVersion = runInstaller({
    installDir: preservedDir,
    platform: linuxX64(),
    version: "1.2.3",
  });
  assertFailure(invalidVersion, "v-prefixed SemVer", "invalid version");

  const help = spawnSync("/bin/sh", [installer, "--help"], { encoding: "utf8" });
  assertSuccess(help, "installer help");
  assertIncludes(help.stdout, "--install-dir", "installer help options");

  process.stdout.write("install smoke passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function linuxX64() {
  return platforms.find(({ target }) => target === "linux-x64");
}

function createRelease(tag, targets, options = {}) {
  const releaseDir = join(releasesDir, tag);
  mkdirSync(releaseDir, { recursive: true });
  const checksums = [];

  for (const target of targets) {
    const version = tag.slice(1);
    const archiveName = `stn-v${version}-${target}.tar.gz`;
    const archivePath = join(releaseDir, archiveName);
    const payloadDir = join(root, `payload-${version}-${target}`);
    mkdirSync(payloadDir, { recursive: true });
    const binarySource = options.probeFailure
      ? "#!/bin/sh\nexit 126\n"
      : `#!/bin/sh
if [ "\${1:-}" = --version ]; then
  printf '%s\\n' '${version}'
else
  printf '%s\\n' 'Station ${tag} ${target}'
fi
`;
    writeFileSync(join(payloadDir, "stn"), binarySource, { mode: 0o755 });
    symlinkSync("stn", join(payloadDir, "stn-ingress"));
    symlinkSync("stn", join(payloadDir, "stn-tmux-popup"));
    writeFileSync(join(payloadDir, "LICENSE"), `Station fixture license ${tag}\n`);

    const members = ["stn", "stn-ingress", "stn-tmux-popup", "LICENSE"];
    if (options.extraMember !== undefined) {
      writeFileSync(join(payloadDir, options.extraMember), "unapproved archive payload\n", {
        mode: 0o755,
      });
      members.push(options.extraMember);
    }
    spawnChecked("tar", ["-czf", archivePath, "-C", payloadDir, ...members], "fixture archive");
    const hash = options.corruptChecksum
      ? "0".repeat(64)
      : createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    checksums.push(`${hash}  ${archiveName}`);
  }

  writeFileSync(join(releaseDir, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`);
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
      '  */releases/assets/1) cat "$FAKE_RELEASES/$FAKE_TAG/$FAKE_ARCHIVE" ;;',
      '  */releases/assets/2) cat "$FAKE_RELEASES/$FAKE_TAG/SHA256SUMS" ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
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
}) {
  const tag = version ?? stableTag;
  const archive = `stn-${tag}-${platform.target}.tar.gz`;
  const path = [fakeBinDir, "/usr/bin", "/bin"];
  if (includeInstallDirOnPath) path.push(installDir);
  const args = [];
  if (version !== undefined) args.push("--version", version);
  args.push("--install-dir", installDir);
  const env = {
    HOME: homeDir,
    GH_HOST: "untrusted.example",
    PATH: path.join(":"),
    TMPDIR: join(root, "tmp"),
    XDG_DATA_HOME: dataDir,
    FAKE_ARCHIVE: archive,
    FAKE_DUPLICATE_ARCHIVE: duplicateArchiveAsset ? "1" : "0",
    FAKE_DUPLICATE_RELEASE: duplicateDraftRelease ? "1" : "0",
    FAKE_GH_AUTH: auth ? "1" : "0",
    FAKE_LATEST_TAG: stableTag,
    FAKE_RELEASE_ID: releaseId ?? "42",
    FAKE_RELEASE_DRAFT: releaseDraft ? "1" : "0",
    FAKE_RELEASE_ID_TAG: releaseIdTag ?? tag,
    FAKE_RELEASES: releasesDir,
    FAKE_TAG: tag,
    FAKE_UNAME_M: platform.machine,
    FAKE_UNAME_S: platform.system,
  };
  if (releaseId !== undefined) env.STATION_INSTALL_RELEASE_ID = releaseId;
  return spawnSync("/bin/sh", [installer, ...args], { encoding: "utf8", env });
}

function assertInstalled({ installDir, tag, target }) {
  const binary = join(installDir, "stn");
  const result = spawnSync(binary, [], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assertSuccess(result, `${target} installed binary`);
  assertEqual(result.stdout, `Station ${tag} ${target}\n`, `${target} installed version`);
  assertEqual(readlinkSync(join(installDir, "stn-ingress")), "stn", `${target} ingress link`);
  assertEqual(readlinkSync(join(installDir, "stn-tmux-popup")), "stn", `${target} popup link`);
  assertEqual(
    readFileSync(join(dataDir, "station", "LICENSE"), "utf8"),
    `Station fixture license ${tag}\n`,
    `${target} installed license`,
  );
  const access = spawnSync("/bin/sh", ["-c", 'test -x "$1"', "sh", binary]);
  assertEqual(access.status, 0, `${target} executable mode`);
}

function spawnChecked(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assertSuccess(result, label);
  return result;
}

function assertSuccess(result, label) {
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
}

function assertFailure(result, expected, label) {
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) throw new Error(`${label} unexpectedly passed`);
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
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}
