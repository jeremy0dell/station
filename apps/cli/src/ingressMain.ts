#!/usr/bin/env node
import { runProviderIngressMain } from "./ingress/command.js";
import { readStdinIfAvailable } from "./stdin.js";

/** Owns one raw-stdin read, renders the ingress result, and applies its exit code. */
export async function runCliIngressMain(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const stdin = (await readStdinIfAvailable()) ?? "";
  const options: Parameters<typeof runProviderIngressMain>[1] = {
    env: process.env,
    stdin,
  };
  const result = await runProviderIngressMain([...argv], options);
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.code;
}

if (import.meta.main) {
  void runCliIngressMain();
}
