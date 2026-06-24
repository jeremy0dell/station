import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export async function writeFakeWorktrunkBin(root: string): Promise<string> {
  const binDir = join(root, "bin");
  const stateDir = join(root, "fake-worktrunk-state");
  const binPath = join(binDir, "fake-wt.mjs");
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(binPath, fakeWorktrunkSource(stateDir), { mode: 0o700 });
  await chmod(binPath, 0o700);
  return binPath;
}

function fakeWorktrunkSource(stateDir: string): string {
  return `#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const cwd = process.cwd();
const projectId = basename(cwd).replace(/[^a-zA-Z0-9._:-]+/g, "_") || "project";
const stateFile = join(${JSON.stringify(stateDir)}, projectId + ".json");

if (args.includes("--version")) {
  console.log("fake-wt 0.0.0");
  process.exit(0);
}

function current() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return { branch: "main", path: cwd };
  }
}

function write(record) {
  mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(record));
}

function emit(record = current()) {
  console.log(JSON.stringify([{ path: record.path, branch: record.branch, dirty: false }]));
}

if (args.includes("list")) {
  emit();
  process.exit(0);
}

if (args.includes("switch")) {
  const createIndex = args.indexOf("--create");
  const branch = createIndex >= 0 && args[createIndex + 1] ? args[createIndex + 1] : "manual-test";
  const path = join(${JSON.stringify(stateDir)}, projectId + "-" + branch.replace(/[^a-zA-Z0-9._:-]+/g, "_"));
  mkdirSync(path, { recursive: true });
  const record = { branch, path };
  write(record);
  emit(record);
  process.exit(0);
}

if (args.includes("remove")) {
  rmSync(stateFile, { force: true });
  console.log("{}");
  process.exit(0);
}

console.log("{}");
`;
}

export function fakeWorktrunkProjectRoot(root: string, id: string): string {
  return join(root, basename(id));
}
