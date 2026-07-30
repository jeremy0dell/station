import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexHookAdapter } from "@station/codex";
import {
  type ProviderHookEvent,
  ProviderHookEventSchema,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import type { HostTerminalNotification } from "@station/host";
import { afterEach, describe, expect, it } from "vitest";
import { createPtyTable, type PtyTable } from "../../../../station/src/host/ptyTable.js";
import { createStationVtScreen } from "../../../../station/src/terminal/vt/screen.js";

const execFileAsync = promisify(execFile);
const realCodexEnabled = process.env.STATION_REAL_CODEX === "1";
const describeRealCodex = realCodexEnabled ? describe : describe.skip;
const timeoutMs = 180_000;
let cleanupTasks: Array<() => Promise<void>> = [];

describeRealCodex("real Codex approval notifications", () => {
  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    await Promise.allSettled(tasks.reverse().map((task) => task()));
  });

  it(
    "emits OSC 9 from the open approval UI and maps it to typed attention",
    async () => {
      const codexBin = process.env.STATION_CODEX_BIN ?? "codex";
      await execFileAsync(codexBin, ["login", "status"], { timeout: 15_000 });

      const root = await mkdtemp(join(tmpdir(), "station-real-codex-approval-"));
      const worktreePath = join(root, "worktree");
      const outsidePath = join(root, "outside-sandbox.txt");
      await mkdir(worktreePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
      if (process.env.STATION_REAL_CODEX_KEEP_TEMP !== "1") {
        cleanupTasks.push(async () => rm(root, { recursive: true, force: true }));
      } else {
        process.stderr.write(`Keeping real Codex approval temp root: ${root}\n`);
      }

      const table = createPtyTable();
      cleanupTasks.push(async () => table.disposeAll());
      const { ptyId } = table.spawn({
        kind: "agent",
        terminalTargetId: "native:wt_real_codex_approval",
        worktreeId: "wt_real_codex_approval",
        projectId: "real_codex",
        sessionId: "ses_real_codex_approval",
        worktreePath,
        harnessProvider: "codex",
        command: codexBin,
        args: [
          "--cd",
          worktreePath,
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
          "--no-alt-screen",
          "--config",
          'approvals_reviewer="user"',
          "--config",
          'tui.notifications=["approval-requested"]',
          "--config",
          'tui.notification_method="osc9"',
          "--config",
          'tui.notification_condition="always"',
          `Run this shell command now: printf station-approval-probe > ${JSON.stringify(outsidePath)}`,
        ],
        cwd: worktreePath,
        cols: 100,
        rows: 30,
      });

      const notification = await waitForHostNotification(table, ptyId, timeoutMs - 20_000);
      expect(await pathExists(outsidePath)).toBe(false);

      const event = approvalHookEvent(worktreePath, notification);
      const compacted = codexHookAdapter.compactPayload?.(event);
      if (compacted === undefined) {
        throw new Error("Codex hook adapter did not expose payload compaction.");
      }
      const mapped = codexHookAdapter.toHarnessEventReport?.({
        event: compacted.event,
        payloadSummary: compacted.payloadSummary,
        fallbackReportId: () => "hook_real_codex_approval",
      });
      if (mapped?.ok !== true) {
        throw new Error("Codex hook adapter did not map the real approval notification.");
      }
      expect(mapped.report).toMatchObject({
        reportId: notification.id,
        observedAt: notification.observedAt,
        eventType: "StationApprovalPromptOpened",
        status: {
          value: "needs_attention",
          confidence: "high",
          attention: "tool_approval",
        },
        correlation: {
          projectId: "real_codex",
          worktreeId: "wt_real_codex_approval",
          sessionId: "ses_real_codex_approval",
          terminalTargetId: "native:wt_real_codex_approval",
        },
      });

      table.write(ptyId, "\x03");
      expect(await pathExists(outsidePath)).toBe(false);
    },
    timeoutMs,
  );
});

function approvalHookEvent(
  worktreePath: string,
  notification: HostTerminalNotification,
): ProviderHookEvent {
  return ProviderHookEventSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: notification.id,
    provider: "codex",
    kind: "harness",
    event: "StationApprovalPromptOpened",
    receivedAt: notification.observedAt,
    projectId: "real_codex",
    worktreeId: "wt_real_codex_approval",
    sessionId: "ses_real_codex_approval",
    payload: {
      hook_event_name: "StationApprovalPromptOpened",
      cwd: worktreePath,
      station_project_id: "real_codex",
      station_worktree_id: "wt_real_codex_approval",
      station_worktree_path: worktreePath,
      station_session_id: "ses_real_codex_approval",
      station_terminal_provider: "station",
      station_terminal_target_id: "native:wt_real_codex_approval",
    },
  });
}

async function waitForHostNotification(
  table: PtyTable,
  ptyId: string,
  waitMs: number,
): Promise<HostTerminalNotification> {
  const attachment = await table.attach(ptyId);
  const replay = attachment.ack.replay;
  const screen = createStationVtScreen({
    size: { cols: replay.initialCols, rows: replay.initialRows },
  });
  for (const event of replay.events) {
    if (event.type === "data") screen.feed(event.data);
    else screen.resize({ cols: event.cols, rows: event.rows });
  }
  if (replay.kind === "live-reset-recovery") screen.feed(replay.resetData);
  await screen.whenIdle();
  if (attachment.ack.latestNotification !== undefined) {
    screen.dispose();
    return attachment.ack.latestNotification;
  }

  const frames = attachment.frames[Symbol.asyncIterator]();
  const deadline = Date.now() + waitMs;
  let trustAccepted = false;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw approvalTimeout(screen);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        frames.next(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(approvalTimeout(screen)), remaining);
        }),
      ]).finally(() => clearTimeout(timeout));
      if (next.done) throw new Error("Host attachment ended before the Codex approval.");
      const frame = next.value;
      if (frame.type === "notification") {
        return {
          id: frame.id,
          kind: frame.kind,
          observedAt: frame.observedAt,
        };
      }
      if (frame.type === "exit") {
        throw new Error(
          `Codex exited before OSC 9 (exit ${frame.exitCode}).\nVisible terminal:\n${visibleTerminal(screen)}`,
        );
      }
      if (frame.type === "resize") {
        screen.resize({ cols: frame.cols, rows: frame.rows });
        continue;
      }
      if (frame.type !== "data") continue;
      screen.feed(frame.data);
      await screen.whenIdle();
      if (
        !trustAccepted &&
        visibleTerminal(screen).includes("Do you trust the contents of this directory?")
      ) {
        // The test created this isolated repository, so clear Codex's trust gate before its turn.
        trustAccepted = true;
        table.write(ptyId, "\r");
      }
    }
  } finally {
    await frames.return?.();
    screen.dispose();
  }
}

function approvalTimeout(screen: ReturnType<typeof createStationVtScreen>): Error {
  return new Error(
    `Timed out waiting for Host's Codex OSC 9 notification.\nVisible terminal:\n${visibleTerminal(screen)}`,
  );
}

function visibleTerminal(screen: ReturnType<typeof createStationVtScreen>): string {
  return Array.from({ length: screen.bufferStats().rows }, (_, row) => screen.rowText(row))
    .filter((row) => row.length > 0)
    .join("\n");
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
