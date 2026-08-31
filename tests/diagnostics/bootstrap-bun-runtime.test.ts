import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
}

describe("bootstrap exact Bun runtime", () => {
  it("delegates every workspace operation and nested bare Bun lookup to the selected version", () => {
    const fixture = mkdtempSync(join(tmpdir(), "station-bootstrap-exact-bun-"));
    try {
      const ambientBin = join(fixture, "ambient-bin");
      const runtimeBin = join(fixture, "runtime", "bun", "bin");
      const locatorBin = join(fixture, "runtime", "node_modules", ".bin");
      const exactBun = join(runtimeBin, "bun.exe");
      const locatorBun = join(locatorBin, "bun");
      const bunLog = join(fixture, "exact-bun.log");
      mkdirSync(ambientBin, { recursive: true });
      mkdirSync(runtimeBin, { recursive: true });
      mkdirSync(locatorBin, { recursive: true });
      symlinkSync(process.execPath, join(ambientBin, "node"));

      writeExecutable(join(ambientBin, "xcode-select"), [
        "#!/bin/sh",
        'if [ "$1" = "-p" ]; then printf \'/Library/Developer/CommandLineTools\\n\'; exit 0; fi',
        "exit 2",
      ]);
      writeExecutable(join(ambientBin, "brew"), [
        "#!/bin/sh",
        'if [ "$1" = "bundle" ]; then exit 0; fi',
        'if [ "$1" = "--prefix" ] && [ "$2" = "node@24" ]; then exit 1; fi',
        "exit 2",
      ]);
      writeExecutable(join(ambientBin, "npx"), [
        "#!/bin/sh",
        "set -eu",
        'if [ "$1" != "--yes" ] || [ "$2" != "bun@1.4.0" ]; then exit 64; fi',
        "shift 2",
        'PATH="$STATION_BOOTSTRAP_BUN_LOCATOR:$PATH"',
        "export PATH",
        'exec "$STATION_BOOTSTRAP_EXACT_BUN" "$@"',
      ]);
      writeExecutable(exactBun, [
        "#!/bin/sh",
        "set -eu",
        'if [ "$1" = "--version" ]; then printf \'1.4.0\\n\'; exit 0; fi',
        'nested_bun="$(command -v bun)"',
        'nested_version="$(bun --version)"',
        'printf \'%s\\t%s\\t%s\\t%s\\n\' "$0" "$*" "$nested_bun" "$nested_version" >> "$STATION_BOOTSTRAP_EXACT_BUN_LOG"',
      ]);
      symlinkSync(exactBun, locatorBun);

      const result = spawnSync(join(repoRoot, "scripts", "setup", "bootstrap.sh"), [], {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${ambientBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          STATION_BOOTSTRAP_BUN_LOCATOR: locatorBin,
          STATION_BOOTSTRAP_EXACT_BUN: exactBun,
          STATION_BOOTSTRAP_EXACT_BUN_LOG: bunLog,
        },
      });
      if (result.error !== undefined) throw result.error;

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(bunLog, "utf8").trim().split("\n")).toEqual(
        ["install", "run build", "run repair:node-pty", "run station:link"].map(
          (args) => `${exactBun}\t${args}\t${locatorBun}\t1.4.0`,
        ),
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
