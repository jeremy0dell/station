#!/usr/bin/env node
import { open, rename, rm, writeFile } from "node:fs/promises";
import {
  enableCodexHooksFeature,
  parseTomlDocument,
  stringifyTomlDocument,
} from "../integrations/harness/codex/dist/hooks/hookConfigEditor.js";

const [configPath] = process.argv.slice(2);
if (configPath === undefined) {
  throw new Error("Usage: enable-devbox-codex-hooks.mjs <config-path>");
}

const configFile = await open(configPath, "a+", 0o600);
let before;
try {
  before = await configFile.readFile("utf8");
} finally {
  await configFile.close();
}

const after = stringifyTomlDocument(enableCodexHooksFeature(parseTomlDocument(before)));
if (after !== before) {
  const temporaryPath = `${configPath}.tmp.${process.pid}`;
  try {
    await writeFile(temporaryPath, after, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
