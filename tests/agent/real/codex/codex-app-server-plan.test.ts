import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type CodexAppServerObservationContext,
  codexAppServerEventToHarnessEventObservation,
} from "@station/codex";
import type { HarnessEventObservation } from "@station/contracts";
import { afterEach, describe, expect, it } from "vitest";

const realCodexEnabled = process.env.STATION_REAL_CODEX === "1";
const describeRealCodex = realCodexEnabled ? describe : describe.skip;

const now = "2026-06-17T12:00:00.000Z";
const appServerTimeoutMs = 180_000;
let cleanupTasks: Array<() => Promise<void>> = [];

describeRealCodex("real Codex app-server plan mode", () => {
  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    for (const task of tasks.reverse()) {
      await task().catch(() => undefined);
    }
  });

  it(
    "streams a real completed plan item that maps to needs_attention",
    async () => {
      const codexBin = process.env.STATION_CODEX_BIN ?? "codex";
      const root = await mkdtemp(join(tmpdir(), "station-real-codex-app-server-"));
      const worktreePath = join(root, "worktree");
      await mkdir(worktreePath, { recursive: true });
      // README documents STATION_REAL_CODEX_KEEP_TEMP=1 to retain temp roots for debugging.
      if (process.env.STATION_REAL_CODEX_KEEP_TEMP !== "1") {
        cleanupTasks.push(async () => {
          await rm(root, { recursive: true, force: true });
        });
      }

      const server = startCodexAppServer({
        codexBin,
        cwd: worktreePath,
        context: {
          observedAt: now,
          projectId: "web",
          worktreeId: "wt_real_codex_app_server",
          sessionId: "ses_real_codex_app_server",
          cwd: worktreePath,
        },
      });
      cleanupTasks.push(async () => {
        await server.close();
      });

      await server.request("initialize", {
        clientInfo: {
          name: "station_real_codex_app_server_test",
          title: "STATION Real Codex App Server Test",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      server.notify("initialized", {});

      const model = process.env.STATION_REAL_CODEX_MODEL ?? (await server.defaultModel());
      const threadId = threadIdFromResponse(
        await server.request("thread/start", {
          cwd: worktreePath,
          model,
          approvalPolicy: "never",
          serviceName: "station_real_codex_app_server_test",
        }),
      );

      await server.request("turn/start", {
        threadId,
        cwd: worktreePath,
        input: [
          {
            type: "text",
            text: "Create a short implementation plan for verifying this empty temp repo. Do not edit files.",
            text_elements: [],
          },
        ],
        collaborationMode: {
          mode: "plan",
          settings: {
            model,
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      });

      const planObservation = await server.waitForPlanObservation();

      expect(server.methods()).toEqual(expect.arrayContaining(["turn/started", "item/completed"]));
      expect(planObservation).toMatchObject({
        provider: "codex",
        sessionId: "ses_real_codex_app_server",
        worktreeId: "wt_real_codex_app_server",
        nativeSessionId: threadId,
        harnessRunId: `codex:app-server:${threadId}`,
        rawEventType: "item/completed",
        status: {
          value: "needs_attention",
          confidence: "high",
          reason: "Codex proposed a plan.",
          attention: "plan_approval",
        },
        providerData: {
          transport: "app-server",
          appServerMethod: "item/completed",
          codexThreadId: threadId,
          itemType: "plan",
        },
      });
    },
    appServerTimeoutMs,
  );
});

type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
};

function startCodexAppServer(input: {
  codexBin: string;
  cwd: string;
  context: CodexAppServerObservationContext;
}) {
  const child = spawn(input.codexBin, ["app-server"], {
    cwd: input.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderrChunks: string[] = [];
  const methods: string[] = [];
  const observations: HarnessEventObservation[] = [];
  const pending = new Map<string | number, PendingRequest>();
  const planWaiters: Array<(observation: HarnessEventObservation) => void> = [];
  const planRejecters: Array<(reason: unknown) => void> = [];
  let requestId = 0;
  let closed = false;
  let planObserved = false;
  let turnCompletedWithoutPlanError: Error | undefined;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    handleLine(line);
  });
  child.on("exit", (code, signal) => {
    const error = new Error(
      `codex app-server exited before the test completed (code=${String(code)}, signal=${String(
        signal,
      )}).\n${stderr()}`,
    );
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    for (const reject of planRejecters.splice(0)) {
      reject(error);
    }
    planWaiters.length = 0;
  });

  function handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (cause) {
      throw new Error(`codex app-server emitted invalid JSON: ${line}`, { cause });
    }

    if (typeof message.method === "string") {
      methods.push(message.method);
      const mapped = codexAppServerEventToHarnessEventObservation(message, input.context);
      observations.push(...mapped);
      const planObservation = mapped.find(
        (observation) =>
          observation.status?.value === "needs_attention" &&
          observation.status.reason === "Codex proposed a plan.",
      );
      if (planObservation !== undefined) {
        planObserved = true;
        for (const resolve of planWaiters.splice(0)) {
          resolve(planObservation);
        }
        planRejecters.length = 0;
      } else if (message.method === "turn/completed" && !planObserved) {
        const summary = methods.join(", ");
        const error = new Error(
          `Codex turn completed without a plan observation. Methods: ${summary}.\n${stderr()}`,
        );
        turnCompletedWithoutPlanError = error;
        for (const reject of planRejecters.splice(0)) {
          reject(error);
        }
        planWaiters.length = 0;
      }
      return;
    }

    if (message.id === undefined) {
      return;
    }
    const request = pending.get(message.id);
    if (request === undefined) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error !== undefined) {
      request.reject(
        new Error(
          `codex app-server request ${String(message.id)} failed: ${
            message.error.message ?? "unknown error"
          }.\n${stderr()}`,
        ),
      );
      return;
    }
    request.resolve(message.result);
  }

  function request(method: string, params: unknown): Promise<unknown> {
    const id = ++requestId;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(`Timed out waiting for codex app-server ${method} response.\n${stderr()}`),
        );
      }, 60_000);
      pending.set(id, { resolve, reject, timeout });
      writeMessage(child, payload);
    });
  }

  function notify(method: string, params: unknown): void {
    writeMessage(child, { method, params });
  }

  async function defaultModel(): Promise<string> {
    const result = await request("model/list", {
      limit: 20,
      includeHidden: false,
    });
    const models = modelListFromResponse(result);
    return models.find((model) => model.isDefault)?.model ?? models[0]?.model ?? "gpt-5.4";
  }

  function waitForPlanObservation(): Promise<HarnessEventObservation> {
    const existing = observations.find(
      (observation) =>
        observation.status?.value === "needs_attention" &&
        observation.status.reason === "Codex proposed a plan.",
    );
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    if (turnCompletedWithoutPlanError !== undefined) {
      return Promise.reject(turnCompletedWithoutPlanError);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const summary = methods.length === 0 ? "(no methods received)" : methods.join(", ");
        reject(
          new Error(
            `Timed out waiting for a real Codex app-server plan observation. Methods: ${summary}.\n${stderr()}`,
          ),
        );
      }, appServerTimeoutMs - 10_000);
      planWaiters.push((observation) => {
        clearTimeout(timeout);
        resolve(observation);
      });
      planRejecters.push((reason) => {
        clearTimeout(timeout);
        reject(reason);
      });
    });
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("codex app-server test server closed."));
    }
    pending.clear();
    lines.close();
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForExit(child, 2_000).catch(() => {
        child.kill("SIGKILL");
      });
    }
  }

  function stderr(): string {
    return stderrChunks.join("").trim();
  }

  return {
    request,
    notify,
    defaultModel,
    waitForPlanObservation,
    methods: () => methods,
    close,
  };
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function threadIdFromResponse(response: unknown): string {
  if (
    typeof response === "object" &&
    response !== null &&
    "thread" in response &&
    typeof response.thread === "object" &&
    response.thread !== null &&
    "id" in response.thread &&
    typeof response.thread.id === "string"
  ) {
    return response.thread.id;
  }
  throw new Error("codex app-server thread/start response did not include thread.id.");
}

function modelListFromResponse(response: unknown): Array<{ model: string; isDefault: boolean }> {
  if (
    typeof response !== "object" ||
    response === null ||
    !("data" in response) ||
    !Array.isArray(response.data)
  ) {
    throw new Error("codex app-server model/list response did not include data.");
  }
  return response.data
    .map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("model" in item) ||
        typeof item.model !== "string"
      ) {
        return undefined;
      }
      return {
        model: item.model,
        isDefault: "isDefault" in item && item.isDefault === true,
      };
    })
    .filter((item): item is { model: string; isDefault: boolean } => item !== undefined);
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for codex app-server to exit."));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
