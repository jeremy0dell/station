import type {
  HarnessEventReport,
  HarnessEventReportReceipt,
  ProviderHookEvent,
  ProviderHookReceipt,
} from "@station/contracts";
import { runProviderIngressCommand } from "@station/provider-hooks";
import { describe, expect, it } from "vitest";
import {
  listHookSpoolFiles,
  readHarnessEventReportSpoolRecord,
} from "../../../../tests/support/spool";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";

describe("provider hook ingress command", () => {
  it("delivers Worktrunk lifecycle hooks through observer.ingestProviderHookEvent", async () => {
    const fixture = await createTempState();
    let observedPayload: unknown;
    let observedSocketPath = "";

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "worktrunk", "post-create"],
      {
        stdin: JSON.stringify({ branch: "feature/run-cli" }),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_worktrunk_1",
        clientFactory: (socketPath) => {
          observedSocketPath = socketPath;
          const ingest = async (event: ProviderHookEvent): Promise<ProviderHookReceipt> => {
            observedPayload = event.payload;
            return {
              schemaVersion: "0.6.0",
              hookId: event.hookId ?? "hook_worktrunk_1",
              provider: event.provider,
              event: event.event,
              accepted: true,
              status: "ingested",
              receivedAt: event.receivedAt,
              reconciled: false,
            };
          };
          return {
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt).toMatchObject({
      status: "ingested",
      provider: "worktrunk",
      event: "post-create",
    });
    expect(observedSocketPath).toBe(fixture.socketPath);
    expect(observedPayload).toEqual({ branch: "feature/run-cli" });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("resolves observer delivery and spool paths from --config without explicit path flags", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedSocketPath = "";
    let observedSpoolDir = "";

    const receipt = await runProviderIngressCommand(
      ["--config", configPath, "--no-auto-start", "worktrunk", "post-create"],
      {
        stdin: JSON.stringify({ branch: "feature/config-only" }),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_worktrunk_config_only",
        clientFactory: (socketPath) => {
          observedSocketPath = socketPath;
          const ingest = async (): Promise<ProviderHookReceipt> => {
            throw new Error("offline");
          };
          return {
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
        writeSpool: async ({ spoolDir, event, error, clock }) => {
          observedSpoolDir = spoolDir;
          return {
            schemaVersion: "0.6.0",
            hookId: event.hookId ?? "hook_worktrunk_config_only",
            provider: event.provider,
            event: event.event,
            accepted: true,
            status: "spooled",
            receivedAt: event.receivedAt,
            spooledAt: clock === undefined ? now : clock.now().toISOString(),
            ...(error === undefined ? {} : { error }),
          };
        },
      },
    );

    expect(receipt).toMatchObject({
      status: "spooled",
      provider: "worktrunk",
      event: "post-create",
    });
    expect(observedSocketPath).toBe(fixture.socketPath);
    expect(observedSpoolDir).toBe(fixture.hookSpoolDir);
  });

  it("delivers Crush PreToolUse hooks through observer.ingestProviderHookEvent", async () => {
    const fixture = await createTempState();
    let observedEvent: ProviderHookEvent | undefined;

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "crush"],
      {
        stdin: JSON.stringify(crushPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_crush_1",
        clientFactory: () => {
          const ingest = async (event: ProviderHookEvent): Promise<ProviderHookReceipt> => {
            observedEvent = event;
            return {
              schemaVersion: "0.6.0",
              hookId: event.hookId ?? "hook_crush_1",
              provider: event.provider,
              event: event.event,
              accepted: true,
              status: "ingested",
              receivedAt: event.receivedAt,
              reconciled: false,
            };
          };
          return {
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt).toMatchObject({
      status: "ingested",
      provider: "crush",
      event: "PreToolUse",
    });
    expect(observedEvent).toMatchObject({
      provider: "crush",
      kind: "harness",
      event: "PreToolUse",
      payload: {
        event: "PreToolUse",
        session_id: "crush_session_1",
        cwd: "/tmp/station/web/task",
        tool_name: "bash",
        tool_input: { command: "pnpm test" },
        station_project_id: "web",
        station_worktree_id: "wt_web_task",
        station_session_id: "ses_web_task",
        station_terminal_target_id: "tmux:station:@1:%2",
      },
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("delivers compact Codex payloads through observer.harnessEvent.report", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedReport: HarnessEventReport | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "codex",
      ],
      {
        stdin: JSON.stringify(codexPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_codex_1",
        clientFactory: () =>
          ({
            reportHarnessEvent: async (report): Promise<HarnessEventReportReceipt> => {
              observedReport = report;
              return {
                schemaVersion: "0.6.0",
                reportId: report.reportId,
                provider: report.provider,
                eventType: report.eventType,
                accepted: true,
                status: "accepted",
                receivedAt: report.observedAt,
                projected: false,
                scheduledReconcile: true,
              };
            },
          }) as never,
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedReport).toMatchObject({
      provider: "codex",
      eventType: "PreToolUse",
      correlation: {
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        cwd: "/tmp/station/web/task",
      },
      diagnostics: {
        compacted: true,
        omittedFieldNames: ["tool_input"],
      },
      providerData: {
        hookEventName: "PreToolUse",
        toolName: "Bash",
      },
    });
    expect(JSON.stringify(observedReport)).not.toContain("pnpm test");
  });

  it("delivers compact Claude payloads through observer.harnessEvent.report", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedReport: HarnessEventReport | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "claude",
      ],
      {
        stdin: JSON.stringify(claudePayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_claude_1",
        clientFactory: () =>
          ({
            reportHarnessEvent: async (report): Promise<HarnessEventReportReceipt> => {
              observedReport = report;
              return {
                schemaVersion: "0.6.0",
                reportId: report.reportId,
                provider: report.provider,
                eventType: report.eventType,
                accepted: true,
                status: "accepted",
                receivedAt: report.observedAt,
                projected: false,
                scheduledReconcile: true,
              };
            },
          }) as never,
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedReport).toMatchObject({
      provider: "claude",
      eventType: "PreToolUse",
      status: {
        value: "working",
        confidence: "medium",
      },
      correlation: {
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        harnessRunId: "claude:tmux:station:@1:%2",
        nativeSessionId: "claude_session_1",
        cwd: "/tmp/station/web/task",
      },
      diagnostics: {
        compacted: true,
        omittedFieldNames: ["tool_input"],
      },
      providerData: {
        hookEventName: "PreToolUse",
        toolName: "Bash",
      },
    });
    expect(JSON.stringify(observedReport)).not.toContain("pnpm test");
  });

  it("ignores Claude events outside the rule-derived allow-list", async () => {
    const fixture = await createTempState();

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "claude"],
      {
        stdin: JSON.stringify({
          ...claudePayload(),
          hook_event_name: "SubagentStop",
        }),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_claude_drop_1",
      },
    );

    expect(receipt).toMatchObject({
      status: "ignored",
      provider: "claude",
      event: "SubagentStop",
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("ignores Claude events without station ownership env", async () => {
    const fixture = await createTempState();

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "claude"],
      {
        stdin: JSON.stringify(claudePayload()),
        env: {},
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_claude_unowned_1",
      },
    );

    expect(receipt).toMatchObject({
      status: "ignored",
      provider: "claude",
      event: "PreToolUse",
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("delivers compact Cursor payloads through observer.harnessEvent.report", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedReport: HarnessEventReport | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "cursor",
      ],
      {
        stdin: JSON.stringify(cursorPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_cursor_1",
        clientFactory: () =>
          ({
            reportHarnessEvent: async (report): Promise<HarnessEventReportReceipt> => {
              observedReport = report;
              return {
                schemaVersion: "0.6.0",
                reportId: report.reportId,
                provider: report.provider,
                eventType: report.eventType,
                accepted: true,
                status: "accepted",
                receivedAt: report.observedAt,
                projected: false,
                scheduledReconcile: true,
              };
            },
          }) as never,
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedReport).toMatchObject({
      provider: "cursor",
      eventType: "beforeShellExecution",
      correlation: {
        harnessRunId: "cursor:tmux:station:@1:%2",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        nativeSessionId: "cursor_session_1",
        cwd: "/tmp/station/web/task",
      },
      diagnostics: {
        compacted: true,
        omittedFieldNames: ["command", "tool_input", "user_email"],
      },
      providerData: {
        hookEventName: "beforeShellExecution",
        toolName: "shell",
      },
    });
    expect(JSON.stringify(observedReport)).not.toContain("pnpm test");
    expect(JSON.stringify(observedReport)).not.toContain("person@example.com");
  });

  it("uses stable Codex report ids when no explicit hook id is provided", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedReport: HarnessEventReport | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "codex",
      ],
      {
        stdin: JSON.stringify(codexPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        clientFactory: () =>
          ({
            reportHarnessEvent: async (report): Promise<HarnessEventReportReceipt> => {
              observedReport = report;
              return {
                schemaVersion: "0.6.0",
                reportId: report.reportId,
                provider: report.provider,
                eventType: report.eventType,
                accepted: true,
                status: "accepted",
                receivedAt: report.observedAt,
                projected: false,
                scheduledReconcile: true,
              };
            },
          }) as never,
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedReport?.reportId).toBe(
      "codex:codex_session_1:PreToolUse:turn_1:tool%3Acall_test",
    );
  });

  it("passes the delivery timeout to the observer protocol client", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedTimeoutMs: number | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "--delivery-timeout-ms",
        "4321",
        "codex",
      ],
      {
        stdin: JSON.stringify(codexPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_codex_timeout",
        clientFactory: (_socketPath, options) => {
          observedTimeoutMs = options.timeoutMs;
          return {
            reportHarnessEvent: async (report): Promise<HarnessEventReportReceipt> => ({
              schemaVersion: "0.6.0",
              reportId: report.reportId,
              provider: report.provider,
              eventType: report.eventType,
              accepted: true,
              status: "accepted",
              receivedAt: report.observedAt,
              projected: false,
              scheduledReconcile: true,
            }),
          } as never;
        },
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedTimeoutMs).toBe(4321);
  });

  it("spools compact Codex reports when online delivery is unavailable", async () => {
    const fixture = await createTempState();

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "--no-auto-start", "codex"],
      {
        stdin: JSON.stringify(codexPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_codex_spooled",
        clientFactory: () =>
          ({
            reportHarnessEvent: async () => {
              throw new Error("offline");
            },
          }) as never,
      },
    );

    expect(receipt).toMatchObject({
      status: "spooled",
      provider: "codex",
      event: "PreToolUse",
    });
    const files = await listHookSpoolFiles(fixture.hookSpoolDir);
    expect(files).toHaveLength(1);
    const record = await readHarnessEventReportSpoolRecord(fixture.hookSpoolDir, files[0] ?? "");
    expect(record.report).toMatchObject({
      reportId: "report_codex_spooled",
      provider: "codex",
      eventType: "PreToolUse",
      diagnostics: {
        compacted: true,
        omittedFieldNames: ["tool_input"],
      },
    });
    expect(JSON.stringify(record)).not.toContain("pnpm test");
  });

  it("rejects malformed provider payloads before delivery or spool writes", async () => {
    const fixture = await createTempState();
    let delivered = false;

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "codex"],
      {
        stdin: "{ invalid json",
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        clientFactory: () =>
          ({
            reportHarnessEvent: async () => {
              delivered = true;
              throw new Error("should not deliver invalid payloads");
            },
          }) as never,
      },
    );

    expect(receipt).toMatchObject({
      status: "rejected",
      error: {
        code: "HOOK_PAYLOAD_INVALID",
      },
    });
    expect(delivered).toBe(false);
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });
});

function codexPayload() {
  return {
    session_id: "codex_session_1",
    transcript_path: null,
    cwd: "/tmp/station/web/task",
    hook_event_name: "PreToolUse",
    model: "gpt-5.4-codex",
    permission_mode: "default",
    turn_id: "turn_1",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_use_id: "call_test",
  };
}

function claudePayload() {
  return {
    session_id: "claude_session_1",
    transcript_path: "/home/user/.claude/projects/-tmp-station-web-task/claude_session_1.jsonl",
    cwd: "/tmp/station/web/task",
    hook_event_name: "PreToolUse",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_use_id: "toolu_test",
  };
}

function cursorPayload() {
  return {
    hook_event_name: "beforeShellExecution",
    session_id: "cursor_session_1",
    conversation_id: "conversation_1",
    workspace_roots: ["/tmp/station/web/task"],
    model: "cursor-model",
    cursor_version: "2026.06.02-8c11d9f",
    tool_name: "shell",
    command: "pnpm test",
    tool_input: { command: "pnpm test" },
    user_email: "person@example.com",
  };
}

function crushPayload() {
  return {
    event: "PreToolUse",
    session_id: "crush_session_1",
    cwd: "/tmp/station/web/task",
    tool_name: "bash",
    tool_input: { command: "pnpm test" },
  };
}

function stationEnv(): Record<string, string> {
  return {
    STATION_PROJECT_ID: "web",
    STATION_WORKTREE_ID: "wt_web_task",
    STATION_WORKTREE_PATH: "/tmp/station/web/task",
    STATION_SESSION_ID: "ses_web_task",
    STATION_TERMINAL_PROVIDER: "tmux",
    STATION_TERMINAL_TARGET_ID: "tmux:station:@1:%2",
  };
}
