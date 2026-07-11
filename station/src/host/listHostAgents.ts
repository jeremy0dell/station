import { createStationHostClient } from "@station/host";
import { toSafeError } from "@station/observability";
import { devHostSocketPath } from "./devPaths.js";

/**
 * Inspect live PTYs owned by a running host. Defaults to this worktree's dev
 * socket; use `--socket` or STATION_HOST_SOCKET_PATH for another host.
 */
function resolveSocketPath(argv: string[]): string {
  const flag = argv.indexOf("--socket");
  if (flag >= 0 && argv[flag + 1] !== undefined) {
    return argv[flag + 1] as string;
  }
  const fromEnv = process.env.STATION_HOST_SOCKET_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return devHostSocketPath();
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main(): Promise<void> {
  const socketPath = resolveSocketPath(process.argv.slice(2));
  const client = createStationHostClient({ socketPath, timeoutMs: 1500 });
  try {
    const ptys = await client.list();
    process.stdout.write(`station host: ${socketPath}\n`);
    if (ptys.length === 0) {
      process.stdout.write("  (reachable, but no agents are running)\n");
      return;
    }
    process.stdout.write(
      `  ${pad("ALIVE", 6)}${pad("PID", 8)}${pad("PTY", 8)}${pad("WORKTREE", 16)}${pad("SESSION", 16)}${pad("SIZE", 8)}HARNESS\n`,
    );
    for (const p of ptys) {
      process.stdout.write(
        `  ${pad(p.alive ? "yes" : "no", 6)}${pad(String(p.pid), 8)}${pad(p.ptyId, 8)}${pad(p.worktreeId, 16)}${pad(p.sessionId, 16)}${pad(`${p.cols}x${p.rows}`, 8)}${p.harnessProvider}\n`,
      );
    }
    process.stdout.write(`  ${ptys.filter((p) => p.alive).length} live / ${ptys.length} total\n`);
  } catch (error) {
    const safeError = toSafeError(error, {
      tag: "TerminalProviderError",
      code: "HOST_UNREACHABLE",
      message: `No station host is reachable at ${socketPath}.`,
      provider: "native",
    });
    process.stdout.write(
      `${safeError.code}: ${safeError.message}\n` +
        `  ${safeError.hint ?? "Start one with `bun run e2e:persist -- --hold`, or pass --socket <path>."}\n`,
    );
    process.exitCode = 1;
  } finally {
    client.dispose();
  }
}

void main();
