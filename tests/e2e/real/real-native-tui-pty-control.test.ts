import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SafeErrorSchema } from "@station/contracts";
import { createStationHostClient, type HostPtyAttachExpectation } from "@station/host";
import { beforeAll, describe, expect, it } from "vitest";
import { createHostAttachedTerminal } from "../../../station/src/terminal/pty/hostAttachedTerminal.js";
import type { StationTerminalProcess } from "../../../station/src/terminal/types.js";

const describeReal = process.env.STATION_REAL_E2E === "1" ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const stationRoot = fileURLToPath(new URL("../../../station/", import.meta.url));
const hostEntry = fileURLToPath(new URL("../../../station/src/host/hostMain.ts", import.meta.url));

describeReal("real Station Host attachment control", () => {
  beforeAll(async () => {
    await execFileAsync(process.env.STATION_BUN ?? "bun", ["run", "build:ctty-helper"], {
      cwd: stationRoot,
      timeout: 30_000,
    });
  });

  it.each([
    "bridge",
    "bun",
  ] as const)("serializes independently sized renderers with the %s PTY implementation", async (implementation) => {
    const root = await mkdtemp(join(tmpdir(), `station-pty-control-${implementation}-`));
    const socketPath = join(root, "station-host.sock");
    const host = spawn(
      process.env.STATION_BUN ?? "bun",
      [hostEntry, "--socket", socketPath, "--state-dir", root],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, STATION_PTY_IMPL: implementation },
      },
    );
    let hostStderr = "";
    host.stderr?.on("data", (data: Buffer) => {
      hostStderr += data.toString("utf8");
    });

    const control = createStationHostClient({ socketPath, timeoutMs: 2_000 });
    let first: StationTerminalProcess | undefined;
    let second: StationTerminalProcess | undefined;
    let ptyId: string | undefined;
    try {
      await waitFor(async () => {
        try {
          return (await control.health()).ok;
        } catch {
          return false;
        }
      });

      const identity = {
        kind: "agent" as const,
        terminalTargetId: `native:control-${implementation}`,
        worktreeId: `control-${implementation}`,
        projectId: "control",
        sessionId: `control-${implementation}`,
        worktreePath: root,
        harnessProvider: "scripted",
      };
      const spawned = await control.spawn({
        ...identity,
        command: "/bin/sh",
        args: [
          "-c",
          'printf \'ready\\n\'; while IFS= read -r line; do set -- $(stty size); printf \'seen:%s:%sx%s\\n\' "$line" "$2" "$1"; done',
        ],
        cwd: root,
        cols: 80,
        rows: 24,
      });
      ptyId = spawned.ptyId;
      const expectation: HostPtyAttachExpectation = { ...identity, ...spawned };
      const firstOutput: string[] = [];
      const secondOutput: string[] = [];

      second = createHostAttachedTerminal({
        hostSocketPath: socketPath,
        ptyRef: expectation,
        size: { cols: 60, rows: 15 },
      });
      second.onData((data) => secondOutput.push(data));
      await waitFor(() => sameSize(second?.ackedSize, { cols: 60, rows: 15 }));

      first = createHostAttachedTerminal({
        hostSocketPath: socketPath,
        ptyRef: expectation,
        size: { cols: 100, rows: 30 },
      });
      first.onData((data) => firstOutput.push(data));
      await waitFor(() => sameSize(first?.ackedSize, { cols: 100, rows: 30 }));

      first.write("A\n");
      await waitFor(() => includes(firstOutput, "seen:A:100x30"));
      await waitFor(() => includes(secondOutput, "seen:A:100x30"));

      second.resize({ cols: 40, rows: 10 });
      second.resize({ cols: 50, rows: 12 });
      second.resize({ cols: 60, rows: 15 });
      first.write("A2\n");
      await waitFor(() => includes(firstOutput, "seen:A2:100x30"));
      await waitFor(() => includes(secondOutput, "seen:A2:100x30"));

      second.write("B\n");
      await waitFor(() => includes(firstOutput, "seen:B:60x15"));
      await waitFor(() => includes(secondOutput, "seen:B:60x15"));

      first.resize({ cols: 120, rows: 40 });
      first.resize({ cols: 90, rows: 20 });
      second.write("B2\n");
      await waitFor(() => includes(firstOutput, "seen:B2:60x15"));
      await waitFor(() => includes(secondOutput, "seen:B2:60x15"));

      expect(markers(firstOutput)).toEqual(markers(secondOutput));
    } catch (error) {
      throw new Error(`${errorMessage(error)}\nHost stderr:\n${hostStderr}`, { cause: error });
    } finally {
      first?.dispose();
      second?.dispose();
      if (ptyId !== undefined) {
        await control.close(ptyId).catch(() => undefined);
      }
      control.dispose();
      await stopProcess(host);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function errorMessage(error: unknown): string {
  const safeError = SafeErrorSchema.safeParse(error);
  if (safeError.success) {
    return `${safeError.data.code}: ${safeError.data.message}`;
  }
  return error instanceof Error ? error.message : "Unknown PTY control failure.";
}

function includes(output: string[], marker: string): boolean {
  return output.join("").includes(marker);
}

function markers(output: string[]): string[] {
  return output.join("").match(/seen:[AB][2]?:\d+x\d+/g) ?? [];
}

function sameSize(
  actual: { cols: number; rows: number } | undefined,
  expected: { cols: number; rows: number },
): boolean {
  return actual?.cols === expected.cols && actual.rows === expected.rows;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for PTY control evidence.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (await Promise.race([exited.then(() => true), wait(2_000).then(() => false)])) {
    return;
  }
  child.kill("SIGKILL");
  await exited;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
