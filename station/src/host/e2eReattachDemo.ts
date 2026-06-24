import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStationHostClient, type HostAttachment, type HostFrame } from "@station/host";
import { devHostSocketPath, devStateDir } from "./devPaths.js";

/**
 * Manual persistent-agent demo: start a detached host, spawn a PTY, reattach,
 * prove same pid/scrollback. `--hold` leaves it running; `--dev` uses the stable
 * worktree-local socket.
 */
const HOST_ENTRY = fileURLToPath(new URL("./hostMain.ts", import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const log = (text = "") => process.stdout.write(`${text}\n`);

async function main(): Promise<void> {
  const stateDir = process.argv.includes("--dev")
    ? devStateDir()
    : await mkdtemp(join(tmpdir(), "station-station-e2e-"));
  const socketPath = process.argv.includes("--dev")
    ? devHostSocketPath()
    : join(stateDir, "station-host.sock");
  await mkdir(dirname(socketPath), { recursive: true });

  log(`▶ starting station-station-host (detached) at ${socketPath}`);
  const host = spawn("bun", [HOST_ENTRY, "--socket", socketPath, "--state-dir", stateDir], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit"], // surface host crashes on stderr
  });
  host.unref();

  const control = createStationHostClient({ socketPath, timeoutMs: 1000 });
  if (!(await waitForHealth(control))) {
    log("✗ host did not become healthy — is `bun` on PATH? did node-pty repair run?");
    host.kill("SIGTERM");
    process.exitCode = 1;
    return;
  }
  log("  host healthy ✓\n");

  log("▶ spawning a real agent PTY (a shell that prints a tick every second)");
  const spawned = await control.spawn({
    terminalTargetId: "native:demo",
    worktreeId: "demo",
    projectId: "demo",
    sessionId: "ses_demo",
    worktreePath: stateDir,
    harnessProvider: "scripted",
    command: "/bin/sh",
    args: ["-c", 'i=0; while true; do i=$((i+1)); echo "tick $i"; sleep 1; done'],
    cwd: stateDir,
    cols: 80,
    rows: 24,
  });
  log(`  ptyId=${spawned.ptyId}\n`);

  log("── client #1 attaches and watches ~3s ──");
  const client1 = createStationHostClient({ socketPath });
  const attach1 = await client1.attach(spawned.ptyId);
  await readFramesFor(attach1, 3000, (data) => process.stdout.write(`  [c1] ${data}`));
  // host.list returns authoritative pid: the PTY's child after bridge is ready. spawn/attach may briefly report bridge pid.
  const livePid = (await control.list())[0]?.pid;
  log(`  live agent pid=${livePid}`);
  client1.dispose();
  log("── client #1 closed (UI closed) — the host keeps the agent running ──\n");

  log("(no client attached; the agent keeps ticking inside the host…)");
  await sleep(3000);
  const aliveList = await control.list();
  log(`  host.list → pid=${aliveList[0]?.pid} alive=${aliveList[0]?.alive}\n`);

  log("── client #2 reattaches (reopen) ──");
  const client2 = createStationHostClient({ socketPath });
  const attach2 = await client2.attach(spawned.ptyId);
  const samePid = attach2.ack.pid === livePid;
  log(`  pid=${attach2.ack.pid} — same agent as before (pid ${livePid})? ${samePid ? "YES ✓" : "NO ✗"}`);
  log(`  replayed scrollback (ticks emitted while detached):`);
  log(`    ${attach2.ack.scrollback.join("").trim().replace(/\n/g, " | ")}`);
  await readFramesFor(attach2, 3000, (data) => process.stdout.write(`  [c2] ${data}`));
  client2.dispose();
  log("");

  if (process.argv.includes("--hold")) {
    // Leave the host + agent running so you can inspect it from another terminal.
    log("── holding (agent still running) ──");
    log(
      process.argv.includes("--dev")
        ? "  inspect it:   bun run host:list"
        : `  inspect it:   bun run host:list -- --socket ${socketPath}`,
    );
    log("  press Ctrl-C here to stop the host\n");
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
  } else {
    log("── guarded close (host.close{confirm}) ──");
    log(`  host.close → ${JSON.stringify(await control.close(spawned.ptyId))}`);
    log(`  host.list → ${JSON.stringify(await control.list())}\n`);
  }

  control.dispose();
  host.kill("SIGTERM");
  log(
    samePid
      ? "✔ PASS — the agent survived the client disconnect and reattached with its scrollback + same pid."
      : "✗ FAIL — pid changed across reattach.",
  );
  if (!samePid) process.exitCode = 1;
}

async function waitForHealth(client: ReturnType<typeof createStationHostClient>): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await client.health();
      return true;
    } catch {
      await sleep(100);
    }
  }
  return false;
}

async function readFramesFor(
  attachment: HostAttachment,
  ms: number,
  onData: (data: string) => void,
): Promise<void> {
  const iterator = attachment.frames[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now())),
      );
      const next: IteratorResult<HostFrame> | "timeout" = await Promise.race([
        iterator.next(),
        timeout,
      ]);
      if (next === "timeout" || next.done) {
        break;
      }
      if (next.value.type === "data") {
        onData(next.value.data);
      } else if (next.value.type === "exit") {
        break;
      }
    }
  } finally {
    await iterator.return?.();
  }
}

void main();
