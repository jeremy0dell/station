#!/usr/bin/env node
import { runCliMain } from "./cliProcess.js";

export { runCli } from "./cliExecution.js";
export { runCliMain, shouldSuppressCliProcessOutput } from "./cliProcess.js";
export type { CliRunOptions, CliRunResult } from "./cliTypes.js";

if (import.meta.main) {
  void runCliMain();
}
