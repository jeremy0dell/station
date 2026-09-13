import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as timers from "node:timers/promises";
import { loadConfig } from "@station/config";
import type { BuildHarnessLaunchRequest } from "@station/contracts";
import { Terminal } from "@xterm/headless";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { resolveExecutionRuntime } from "../../../apps/cli/src/executionRuntime.js";
import { E2bExecutionProvider } from "../../../integrations/agent-execution/e2b/src/provider.js";
import { git } from "../../../integrations/agent-execution/e2b/src/source.js";
import { ExecutionStore } from "../../../integrations/agent-execution/e2b/src/state.js";
import { requestTerminalGrant } from "../../../integrations/agent-execution/e2b/src/terminalBroker.js";
import { TerminalServerFrameSchema } from "../../../integrations/agent-execution/e2b/src/terminalProtocol.js";
import { TerminalInputWindow } from "../../../integrations/agent-execution/e2b/src/terminalRelay.js";

it.skipIf(process.env.STATION_REAL_E2B !== "1")(
  "retains one authenticated cloud agent across attachment and provider replacement, then collects and destroys",
  async () => {
    const configPath = process.env.STATION_E2B_ACCEPTANCE_CONFIG;
    if (!configPath)
      throw new Error("Set STATION_E2B_ACCEPTANCE_CONFIG to the isolated development config.");
    const loaded = await loadConfig(configPath);
    const execution = loaded.config.execution?.e2b;
    if (execution === undefined) throw new Error("E2B is not configured.");
    const root = await mkdtemp(join(tmpdir(), "station-real-cloud-"));
    const repo = join(root, "source");
    await git(root, ["init", "-b", "main", repo]);
    await writeFile(join(repo, "fixture.txt"), "before\n");
    await git(repo, ["add", "."]);
    await git(repo, [
      "-c",
      "user.name=Station Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    ]);
    const sessionId = `ses_${randomUUID().replaceAll("-", "")}`;
    const options = {
      ...execution,
      timeoutMinutes: 60,
      maxSandboxes: 1,
      stateDir: join(root, "state"),
      bridgeDirectory: join(root, "bridge"),
      bridgeCommand: ["stn"] as const,
      resolveRuntime: () => resolveExecutionRuntime(execution),
    };
    let provider = new E2bExecutionProvider(options);
    const request: BuildHarnessLaunchRequest & { sessionId: string; harness: string } = {
      sessionId,
      harness: "codex",
      mode: "interactive",
      permissionMode: "standard",
      initialPrompt:
        "Change fixture.txt to contain exactly cloud-terminal-proof followed by a newline. Do not change other files. Then wait for further instructions.",
      project: {
        id: "cloud-test",
        label: "Cloud test",
        root: repo,
        defaults: {
          worktreeProvider: "worktrunk",
          terminal: "native",
          harness: "codex",
          layout: "agent-only",
        },
      },
      worktree: {
        id: "wt_test",
        provider: "worktrunk",
        projectId: "cloud-test",
        path: repo,
        branch: "main",
        isMain: false,
        isDirty: false,
        observedAt: new Date().toISOString(),
      },
    };
    const store = new ExecutionStore(join(options.stateDir, "executions/e2b"));
    const timings: number[] = [];
    let socket: WebSocket | undefined;
    let terminal: Terminal | undefined;
    let broker: Awaited<ReturnType<typeof requestTerminalGrant>> | undefined;
    const connect = async () => {
      const plan = await provider.attach(sessionId);
      const path = plan.args.at(-2);
      if (path === undefined) throw new Error("Missing broker path");
      broker = await requestTerminalGrant(path, sessionId, () => socket?.terminate());
      if (broker.response.type !== "grant") throw new Error("Grant failed.");
      const grant = broker.response.grant;
      const current = new WebSocket(grant.address, {
        headers: { "e2b-traffic-access-token": grant.trafficToken },
        maxPayload: 1024 * 1024,
      });
      socket = current;
      current.on("error", () => {});
      const first = once(current, "message");
      await once(current, "open");
      current.send(
        JSON.stringify({
          type: "attach",
          version: 1,
          ticket: grant.ticket,
          execution: grant.execution,
          identity: grant.identity,
        }),
      );
      const response = TerminalServerFrameSchema.parse(JSON.parse(String((await first)[0])));
      expect(response.type).toBe("attached");
      if (response.type !== "attached") throw new Error("Attachment failed.");
      return { socket: current, ack: response.ack };
    };
    try {
      const plan = await provider.launch(request);
      expect(plan.requiresPersistentTerminal).toBe(true);
      const first = await connect();
      const original = first.ack;
      await provider.dispose();
      provider = new E2bExecutionProvider(options);
      let output = JSON.stringify(original.replay);
      const sent = new Map<number, number>();
      let acceptedBytes = 0;
      let transportFailure: string | undefined;
      let submittedBytes = 0;
      const input = new TerminalInputWindow((operation) => {
        sent.set(operation.seq, performance.now());
        first.socket.send(JSON.stringify(operation));
      });
      const writeInput = (data: string) => {
        submittedBytes += Buffer.byteLength(data);
        input.input(data);
      };
      terminal = new Terminal({ cols: original.cols, rows: original.rows, scrollback: 1000 });
      terminal.onData(writeInput);
      for (const event of original.replay.events) {
        if (event.type === "data") terminal.write(event.data);
        else terminal.resize(event.cols, event.rows);
      }
      first.socket.on("message", (data) => {
        const frame = TerminalServerFrameSchema.parse(JSON.parse(String(data)));
        if (frame.type === "frame") {
          output = (output + JSON.stringify(frame.frame)).slice(-65536);
          if (frame.frame.type === "data") terminal?.write(frame.frame.data);
        }
        if (frame.type === "failure") transportFailure = frame.message;
        if (frame.type === "accepted") {
          const started = sent.get(frame.seq);
          if (started !== undefined) timings.push(performance.now() - started);
          acceptedBytes = frame.bytes;
          input.acknowledge(frame.seq, frame.bytes);
        }
      });
      // Only this test-created repository is trusted; production prompts remain interactive.
      for (let attempt = 0; !output.includes("Yes, continue") && attempt < 120; attempt++)
        await timers.setTimeout(250);
      expect(output).toContain("Yes, continue");
      writeInput("\r");
      let trustedHooks = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (!trustedHooks && output.includes("Hooks need review")) {
          writeInput("2\r");
          trustedHooks = true;
        }
        await provider.collect(sessionId);
        const record = await store.read(sessionId);
        if (
          record.resultDirectory !== undefined &&
          (await readFile(join(record.resultDirectory, "changes.patch"), "utf8")).includes(
            "cloud-terminal-proof",
          )
        )
          break;
        if (attempt === 59) throw new Error("Codex did not produce the expected fixture patch.");
        await timers.setTimeout(1000);
      }
      timings.length = 0;
      writeInput(`\x1b[200~${"x".repeat(1024 * 1024)}\x1b[201~`);
      const pasteEnd = submittedBytes;
      for (let attempt = 0; acceptedBytes < pasteEnd && attempt < 120; attempt++)
        await timers.setTimeout(250);
      expect(transportFailure).toBeUndefined();
      expect(first.socket.readyState).toBe(WebSocket.OPEN);
      expect(acceptedBytes).toBeGreaterThanOrEqual(pasteEnd);
      writeInput("\x15");
      terminal.resize(100, 30);
      input.resize(100, 30);
      await timers.setTimeout(1000);
      first.socket.terminate();
      broker?.close();
      const second = await connect();
      expect(second.ack.ptyId).toBe(original.ptyId);
      expect(second.ack.ptyInstanceId).toBe(original.ptyInstanceId);
      expect(second.ack.pid).toBe(original.pid);
      for (let attempt = 0; attempt < 60; attempt++) {
        await provider.collect(sessionId);
        const record = await store.read(sessionId);
        if (
          record.resultDirectory !== undefined &&
          (await readFile(join(record.resultDirectory, "changes.patch"), "utf8")).includes(
            "cloud-terminal-proof",
          )
        )
          break;
        if (attempt === 59) throw new Error("Codex did not produce the expected fixture patch.");
        await timers.setTimeout(1000);
      }
      await provider.destroy(sessionId);
      expect((await store.read(sessionId)).phase).toBe("destroyed");
      timings.sort((a, b) => a - b);
      await writeFile(
        join(root, "acceptance.json"),
        JSON.stringify({
          sessionId,
          transport: "protected-websocket",
          original: { ptyId: original.ptyId, instance: original.ptyInstanceId, pid: original.pid },
          acknowledgementLatencyMs: {
            median: timings[Math.floor(timings.length / 2)],
            p95: timings[Math.floor(timings.length * 0.95)],
          },
          pasteBytes: 1024 * 1024 + 12,
          queueHighWaterMarks: input.highWaterMarks,
          collected: true,
          destroyed: true,
        }),
        { mode: 0o600 },
      );
      console.log(`Cloud terminal evidence: ${root}/acceptance.json`);
    } finally {
      socket?.terminate();
      terminal?.dispose();
      broker?.close();
      try {
        await provider.destroy(sessionId);
      } finally {
        await provider.dispose();
      }
    }
  },
  600000,
);
