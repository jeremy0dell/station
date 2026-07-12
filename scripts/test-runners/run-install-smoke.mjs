#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const installer = resolve("scripts/install.sh");
const root = mkdtempSync(join(tmpdir(), "station-install-smoke-"));
const releases = join(root, "releases");
const fakeBin = join(root, "bin");
const realXz = execFileSync("sh", ["-c", "command -v xz"], { encoding: "utf8" }).trim();

try {
  mkdirSync(releases);
  mkdirSync(fakeBin);
  writeFakeCommands();
  createRelease("v1.2.3", "darwin-arm64");
  createRelease("v1.2.3", "linux-x64");
  createRelease("v1.2.4", "linux-x64", { extra: true });
  createRelease("v1.2.5", "linux-x64", { truncate: true });
  createRelease("v1.2.6", "linux-x64", { corruptChecksum: true });

  symlinkSync(realXz, join(fakeBin, "xz"));
  assertInstall({ system: "Darwin", machine: "arm64", format: "xz" });
  assertInstall({ system: "Linux", machine: "x86_64", format: "xz" });
  rmSync(join(fakeBin, "xz"));
  assertInstall({ system: "Linux", machine: "x86_64", format: "gz" });

  const preserved = join(root, "preserved");
  mkdirSync(preserved);
  writeFileSync(join(preserved, "stn"), "old runtime\n", { mode: 0o755 });
  for (const version of ["v1.2.4", "v1.2.5", "v1.2.6"]) {
    const result = runInstaller({
      system: "Linux",
      machine: "x86_64",
      installDir: preserved,
      version,
    });
    if (result.status === 0) throw new Error(`${version} unexpectedly installed`);
    if (readFileSync(join(preserved, "stn"), "utf8") !== "old runtime\n") {
      throw new Error(`${version} changed the existing installation`);
    }
  }
  process.stdout.write("install smoke passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writeFakeCommands() {
  writeFileSync(
    join(fakeBin, "gh"),
    `#!/bin/sh
set -eu
if [ "$1 $2" = "auth status" ]; then exit 0; fi
if [ "$1" = api ]; then printf '%s\\n' v1.2.3; exit 0; fi
pattern=
directory=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pattern) pattern=$2; shift 2 ;;
    --dir) directory=$2; shift 2 ;;
    *) shift ;;
  esac
done
cp "$STATION_TEST_RELEASES/$pattern" "$directory/$pattern"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo "$STATION_TEST_SYSTEM";; -m) echo "$STATION_TEST_MACHINE";; esac\n',
    { mode: 0o755 },
  );
  writeFileSync(join(fakeBin, "sha256sum"), '#!/bin/sh\nshasum -a 256 "$1"\n', {
    mode: 0o755,
  });
}

function createRelease(version, target, options = {}) {
  const stage = join(root, `stage-${version}-${target}`);
  mkdirSync(stage);
  writeFileSync(join(stage, "stn"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  writeFileSync(join(stage, "LICENSE"), "Station test license\n", { mode: 0o644 });
  symlinkSync("stn", join(stage, "stn-ingress"));
  symlinkSync("stn", join(stage, "stn-tmux-popup"));
  if (options.extra) writeFileSync(join(stage, "unexpected"), "no\n");
  const tarPath = join(root, `${version}-${target}.tar`);
  const members = ["LICENSE", "stn", "stn-ingress", "stn-tmux-popup"];
  if (options.extra) members.push("unexpected");
  execFileSync("tar", ["-cf", tarPath, "-C", stage, ...members]);
  const tarBytes = readFileSync(tarPath);
  const base = `stn-${version}-${target}.tar`;
  writeFileSync(join(releases, `${base}.gz`), gzipSync(tarBytes));
  writeFileSync(join(releases, `${base}.xz`), execFileSync(realXz, ["-6", "-c", tarPath]));
  if (options.truncate) {
    const path = join(releases, `${base}.gz`);
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
  }
  const sums = ["gz", "xz"].map((format) => {
    const name = `${base}.${format}`;
    const hash = createHash("sha256")
      .update(readFileSync(join(releases, name)))
      .digest("hex");
    return `${options.corruptChecksum ? "0".repeat(64) : hash}  ${name}`;
  });
  writeFileSync(join(releases, `SHA256SUMS-${version}-${target}`), `${sums.join("\n")}\n`);
}

function runInstaller({ system, machine, installDir, version = "v1.2.3" }) {
  const target = `${system === "Darwin" ? "darwin" : "linux"}-${machine === "arm64" ? "arm64" : "x64"}`;
  cpSync(join(releases, `SHA256SUMS-${version}-${target}`), join(releases, "SHA256SUMS"));
  return spawnSync(installer, ["--version", version, "--install-dir", installDir], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(root, "home"),
      PATH: `${fakeBin}:/usr/bin:/bin`,
      STATION_TEST_MACHINE: machine,
      STATION_TEST_RELEASES: releases,
      STATION_TEST_SYSTEM: system,
    },
  });
}

function assertInstall({ system, machine, format }) {
  const installDir = join(root, `install-${system}-${machine}-${format}`);
  const result = runInstaller({ system, machine, installDir });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  if (readlinkSync(join(installDir, "stn-ingress")) !== "stn") throw new Error("bad ingress");
  if (readlinkSync(join(installDir, "stn-tmux-popup")) !== "stn") throw new Error("bad popup");
  chmodSync(join(installDir, "stn"), 0o755);
}
