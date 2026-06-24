#!/usr/bin/env node
import { runProviderIngressMain } from "./command.js";
import { readStdinIfAvailable } from "./stdin.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const stdin = await readStdinIfAvailable();
  const options: Parameters<typeof runProviderIngressMain>[1] = {
    env: process.env,
  };
  if (stdin !== undefined) {
    options.stdin = stdin;
  }
  runProviderIngressMain(process.argv.slice(2), options).then((result) => {
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.code;
  });
}
