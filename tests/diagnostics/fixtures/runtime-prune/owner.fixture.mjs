import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runOwnedDisposableRuntime } from "../../../../scripts/runtime-owner.mjs";

const InputSchema = z
  .object({
    stateDir: z.string().min(1),
    cleanupRoot: z.string().min(1),
    mode: z.enum(["normal", "term-resistant"]),
  })
  .strict();

const [stateDir, cleanupRoot, mode] = process.argv.slice(2);
const input = InputSchema.parse({ stateDir, cleanupRoot, mode });
const canonicalCleanupRoot = await realpath(input.cleanupRoot);
const cleanupIdentity = await stat(canonicalCleanupRoot);
const childSource =
  input.mode === "term-resistant"
    ? "for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => {}); setInterval(() => {}, 1000)"
    : "setInterval(() => {}, 1000)";

await runOwnedDisposableRuntime({
  role: "binary-smoke",
  checkoutRoot: process.cwd(),
  stateDir: input.stateDir,
  socketRoots: [join(canonicalCleanupRoot, "run")],
  persistenceRoots: [canonicalCleanupRoot],
  cleanupRoots: [
    {
      path: canonicalCleanupRoot,
      device: String(cleanupIdentity.dev),
      inode: String(cleanupIdentity.ino),
    },
  ],
  survivorPolicy: "preserve-persistent-station-runtime",
  terminalKey: "runtime-prune-fixture",
  correlation: {
    traceId: "trc_runtime_prune_fixture",
    spanId: "spn_runtime_prune_fixture",
  },
  launch: {
    cwd: process.cwd(),
    steps: [{ command: process.execPath, args: ["-e", childSource] }],
  },
});
