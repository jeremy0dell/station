import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const stationBin = resolve(import.meta.dirname, "../../../..", "bin", "stn");
let root: string;
let runtimeBin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "station-source-cli-launcher-"));
  runtimeBin = join(root, "bin");
  await mkdir(runtimeBin);
  await Promise.all([writeRuntime("node"), writeRuntime("bun")]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("source CLI launcher", () => {
  it.each([
    ["direct dispatch", ["command", "dispatch", "--stdin"]],
    ["leading config", ["--config", "/tmp/station.toml", "command", "dispatch", "--stdin"]],
    ["interleaved config", ["command", "--config", "/tmp/station.toml", "dispatch"]],
  ])("uses Bun for %s", (_name, args) => {
    expect(runSourceLauncher(args)).toBe("bun");
  });

  it.each([
    ["another route", ["command", "get", "cmd_1"]],
    ["dispatch help", ["command", "dispatch", "--help"]],
    ["missing config", ["--config", "command", "dispatch"]],
    ["option-shaped config", ["--config", "--stdin", "command", "dispatch"]],
  ])("keeps Node for %s", (_name, args) => {
    expect(runSourceLauncher(args)).toBe("node");
  });
});

async function writeRuntime(name: "bun" | "node"): Promise<void> {
  const path = join(runtimeBin, name);
  await writeFile(path, `#!/bin/sh\nprintf '${name}\\n'\n`, "utf8");
  await chmod(path, 0o755);
}

function runSourceLauncher(args: readonly string[]): string {
  const result = spawnSync(stationBin, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [runtimeBin, "/usr/bin", "/bin"].join(delimiter),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
