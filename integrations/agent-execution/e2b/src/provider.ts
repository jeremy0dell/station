import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentExecutionProvider,
  AgentExecutionView,
  BuildHarnessLaunchRequest,
  HarnessLaunchPlan,
  ObservedStatus,
} from "@station/contracts";
import { CreateSessionCommandSchema, SessionViewSchema } from "@station/contracts";
import { Sandbox, type SandboxInfo, type SandboxOpts } from "e2b";
import { z } from "zod";
import { createExecutionBridge, type RemoteAttachment } from "./bridge.js";
import {
  CONFIG,
  collectScript,
  installRuntime,
  materializeSource,
  REMOTE_ENV,
  type RemoteHarnessSettings,
  ROOT,
  RuntimeSessionSchema,
  runtimeConfig,
} from "./remote.js";
import { MAX_TRANSFER_BYTES, shellQuote, sourceArchive } from "./source.js";
import {
  durableFile,
  type ExecutionRecord,
  ExecutionStore,
  executionError,
  privateDirectory,
} from "./state.js";

export type E2bProviderOptions = {
  stateDir: string;
  bridgeDirectory: string;
  bridgeCommand: readonly [string, ...string[]];
  template: string;
  apiKeyEnv: string;
  timeoutMinutes: number;
  maxSandboxes: number;
  setupCommand?: string | undefined;
  harnessEnv: Record<string, Record<string, string>>;
  harnessSettings?: Record<string, RemoteHarnessSettings>;
  environment?: NodeJS.ProcessEnv;
  sdk?: typeof Sandbox;
};
type LaunchRequest = BuildHarnessLaunchRequest & { sessionId: string; harness: string };

/**
 * ADAPTER
 *
 * Runs an ordinary Station runtime in one E2B sandbox per canonical local session. Durable
 * launch attempts precede cloud effects; reconnect never launches an agent and destruction
 * retains a verified final patch before releasing compute. The Observer owns this adapter.
 */
export class E2bExecutionProvider implements AgentExecutionProvider {
  readonly id = "e2b";
  private readonly store: ExecutionStore;
  private readonly sdk: typeof Sandbox;
  private readonly environment: NodeJS.ProcessEnv;
  private bridge: Awaited<ReturnType<typeof createExecutionBridge>> | undefined;
  private mutations: Promise<void> = Promise.resolve();
  private readonly revoked = new Set<string>();
  private readonly connections = new Map<string, Sandbox>();

  constructor(private readonly options: E2bProviderOptions) {
    this.store = new ExecutionStore(join(options.stateDir, "executions/e2b"));
    this.sdk = options.sdk ?? Sandbox;
    this.environment = options.environment ?? process.env;
  }

  async preflight(harness: string): Promise<void> {
    z.string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .parse(harness);
    this.key();
    this.agentEnvironment(harness);
    const records = await this.store.list();
    if (
      records.filter((record) => record.phase !== "destroyed").length >= this.options.maxSandboxes
    ) {
      throw executionError(
        "EXECUTION_CAPACITY",
        "Close an existing cloud session before creating another sandbox.",
      );
    }
  }

  launch(request: LaunchRequest): Promise<HarnessLaunchPlan> {
    return this.serial(async () => {
      await this.preflight(request.harness ?? request.project.defaults.harness);
      const harness = request.harness ?? request.project.defaults.harness;
      const source = await sourceArchive(request.worktree.path);
      const record: ExecutionRecord = {
        version: 1,
        sessionId: request.sessionId,
        token: randomUUID(),
        projectId: request.project.id,
        worktreeId: request.worktree.id,
        worktreePath: request.worktree.path,
        harness,
        template: this.options.template,
        expiresAt: new Date(Date.now() + this.options.timeoutMinutes * 60_000).toISOString(),
        phase: "creating",
        baseCommit: source.baseCommit,
        baseTree: source.baseTree,
      };
      await this.store.write(record, true);
      try {
        const options: SandboxOpts = {
          apiKey: this.key(),
          metadata: this.metadata(record),
          timeoutMs: this.remaining(record),
          requestTimeoutMs: 30_000,
          secure: true,
          network: { allowPublicTraffic: false },
          lifecycle: { onTimeout: "kill", autoResume: false },
        };
        const sandbox = await this.sdk.create(record.template, options);
        record.sandboxId = sandbox.sandboxId;
        record.phase = "preparing";
        await this.store.write(record);
        this.connections.set(record.sessionId, sandbox);
        await this.run(sandbox, installRuntime, 180_000);
        if (this.options.setupCommand !== undefined)
          await this.run(sandbox, this.options.setupCommand, 180_000);
        await sandbox.files.write(`${ROOT}/source.tar`, new Uint8Array(source.archive).buffer);
        await this.run(sandbox, materializeSource(record));
        await sandbox.files.write(
          CONFIG,
          runtimeConfig(harness, {
            ...this.options.harnessSettings?.[harness],
            ...(request.permissionMode === undefined
              ? {}
              : { permissionMode: request.permissionMode }),
          }),
        );
        record.phase = "launching";
        await this.store.write(record);
        const command = CreateSessionCommandSchema.parse({
          type: "session.create",
          payload: {
            projectId: "cloud",
            branch: "agent",
            placement: { intent: "detached" },
            terminal: { provider: "tmux", layout: "agent-only" },
            harness: {
              provider: harness,
              mode: request.mode,
              profile: request.profile,
              approvalPolicy: request.approvalPolicy,
              sandboxMode: request.sandboxMode,
            },
            ...(request.initialPrompt === undefined
              ? {}
              : { initialPrompt: request.initialPrompt }),
          },
        });
        await sandbox.files.write(`${ROOT}/launch.json`, JSON.stringify(command));
        await this.run(
          sandbox,
          `stn --config '${CONFIG}' command dispatch --stdin --wait --timeout-ms 120000 < '${ROOT}/launch.json' > '${ROOT}/launch-result.json'`,
          150_000,
          this.agentEnvironment(harness),
        );
        await this.recoverRemoteSession(record, sandbox, true);
        if (record.remoteSessionId === undefined)
          throw executionError(
            "EXECUTION_LAUNCH_UNCERTAIN",
            "Remote session creation did not return a discoverable session.",
          );
        record.phase = "running";
        await this.store.write(record);
        return this.launchPlan(record);
      } catch {
        throw executionError(
          "TERMINAL_CLEANUP_UNCERTAIN",
          `Cloud launch is incomplete (${record.phase}). Session ${record.sessionId} was retained for inspection and cleanup; no replacement agent will be launched.`,
        );
      }
    });
  }

  attach(sessionId: string): Promise<HarnessLaunchPlan> {
    return this.serial(() => this.attachRecord(sessionId));
  }

  private async attachRecord(sessionId: string): Promise<HarnessLaunchPlan> {
    const record = await this.store.read(sessionId);
    if (record.phase !== "running" && record.phase !== "launching")
      throw executionError(
        "EXECUTION_NOT_RUNNING",
        "This cloud session cannot be attached. Inspect or close it instead.",
      );
    const sandbox = await this.connection(record);
    await this.recoverRemoteSession(record, sandbox, true);
    if (record.remoteSessionId === undefined)
      throw executionError(
        "EXECUTION_LAUNCH_UNCERTAIN",
        "The original remote launch is still uncertain. No new agent was started.",
      );
    this.revoked.delete(sessionId);
    return this.launchPlan(record);
  }

  observe(sessionId: string): Promise<{ execution: AgentExecutionView; status: ObservedStatus }> {
    return this.serial(() => this.observeRecord(sessionId));
  }

  private async observeRecord(
    sessionId: string,
  ): Promise<{ execution: AgentExecutionView; status: ObservedStatus }> {
    const record = await this.store.read(sessionId);
    const execution: AgentExecutionView = {
      provider: this.id,
      state:
        record.phase === "destroyed"
          ? "destroyed"
          : record.phase === "stopped"
            ? "stopped"
            : "starting",
      expiresAt: record.expiresAt,
    };
    if (record.resultDirectory !== undefined) execution.resultDirectory = record.resultDirectory;
    const status: ObservedStatus = {
      value: "unknown",
      confidence: "low",
      source: "reconcile",
      reason: "Cloud execution has not been observed.",
      updatedAt: new Date().toISOString(),
    };
    if (record.phase === "destroyed" || record.phase === "stopped") {
      status.value = "exited";
      status.confidence = "high";
      status.reason = "The remote agent was explicitly stopped.";
      return { execution, status };
    }
    try {
      const sandbox = await this.connection(record);
      if (record.phase === "launching") await this.recoverRemoteSession(record, sandbox, true);
      if (record.remoteSessionId === undefined) return { execution, status };
      const output = await this.run(sandbox, `stn --config '${CONFIG}' snapshot --json`, 10_000);
      const snapshot = z
        .object({ sessions: z.array(SessionViewSchema) })
        .passthrough()
        .parse(JSON.parse(output));
      const remote = snapshot.sessions.find(
        (session) =>
          session.id === record.remoteSessionId && session.harness.provider === record.harness,
      );
      if (remote === undefined) throw new Error("Remote session missing");
      execution.state = "running";
      return { execution, status: remote.status };
    } catch {
      execution.state = "unavailable";
      status.reason = "Cloud connection unavailable; agent exit is unconfirmed.";
      return { execution, status };
    }
  }

  collect(sessionId: string): Promise<void> {
    return this.serial(async () => {
      await this.collectRecord(await this.store.read(sessionId));
    });
  }

  stop(sessionId: string): Promise<void> {
    this.revoke(sessionId);
    return this.serial(async () => {
      await this.stopRecord(await this.store.read(sessionId));
    });
  }

  destroy(sessionId: string, options: { discardResults?: boolean } = {}): Promise<void> {
    this.revoke(sessionId);
    return this.serial(async () => {
      const record = (await this.store.list()).find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (record === undefined || record.phase === "destroyed") return;
      this.bridge?.revoke(sessionId);
      // A lost create response is resolved only by exact metadata, never by issuing another create.
      const matches = await this.inventory(record);
      if (matches.length > 1)
        throw executionError(
          "EXECUTION_IDENTITY_CONFLICT",
          "Multiple sandboxes claim this execution; cleanup requires inspection.",
        );
      const found = matches[0];
      if (found !== undefined) {
        if (record.sandboxId !== undefined && record.sandboxId !== found.sandboxId)
          throw executionError("EXECUTION_IDENTITY_CONFLICT", "The sandbox identity changed.");
        record.sandboxId = found.sandboxId;
        await this.store.write(record);
        if (
          options.discardResults !== true &&
          (record.phase === "running" ||
            record.phase === "launching" ||
            record.phase === "stopping" ||
            record.phase === "stopped")
        ) {
          await this.stopRecord(record);
          await this.collectRecord(record);
        }
        record.phase = "destroying";
        await this.store.write(record);
        await this.sdk.kill(found.sandboxId, { apiKey: this.key(), requestTimeoutMs: 30_000 });
      } else if (
        record.phase === "creating" &&
        Date.now() < Date.parse(record.expiresAt) + 30_000
      ) {
        throw executionError(
          "EXECUTION_CREATE_UNCERTAIN",
          "The create response is missing. Retain this session until its deadline or exact sandbox identity is observed.",
        );
      } else if (
        options.discardResults !== true &&
        (record.remoteSessionId !== undefined ||
          record.phase === "launching" ||
          record.phase === "stopping") &&
        record.finalResultSaved !== true
      ) {
        throw executionError(
          "EXECUTION_RESULT_UNAVAILABLE",
          "The sandbox is absent and no result was retrieved. The session is retained. Close with --discard-results to acknowledge this loss.",
        );
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        if ((await this.inventory(record)).length !== 0)
          throw executionError(
            "EXECUTION_CLEANUP_UNCERTAIN",
            "Cloud cleanup is not yet confirmed. The session was retained.",
          );
      }
      record.phase = "destroyed";
      await this.store.write(record);
      this.connections.delete(sessionId);
    });
  }

  async dispose(): Promise<void> {
    await this.bridge?.dispose();
    this.connections.clear();
  }

  private key(): string {
    const key = this.environment[this.options.apiKeyEnv];
    if (!key)
      throw executionError(
        "EXECUTION_CREDENTIAL_MISSING",
        `Set ${this.options.apiKeyEnv} in the Observer environment before using E2B.`,
      );
    return key;
  }

  private agentEnvironment(harness: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, reference] of Object.entries(this.options.harnessEnv[harness] ?? {})) {
      if (
        name.startsWith("STATION_") ||
        name === "E2B_API_KEY" ||
        reference === this.options.apiKeyEnv ||
        ["HOME", "PATH", "LD_PRELOAD", "NODE_OPTIONS"].includes(name)
      )
        throw executionError(
          "EXECUTION_ENV_REFUSED",
          "Cloud agent credentials cannot override runtime control or carry the compute credential.",
        );
      const value = this.environment[reference];
      if (!value)
        throw executionError(
          "EXECUTION_AGENT_CREDENTIAL_MISSING",
          `The configured agent environment reference ${reference} is missing.`,
        );
      if (value === this.key())
        throw executionError(
          "EXECUTION_ENV_REFUSED",
          "The compute credential cannot be passed to an agent.",
        );
      env[name] = value;
    }
    return env;
  }

  private metadata(record: ExecutionRecord) {
    return { station_execution: record.token, station_session: record.sessionId };
  }
  private remaining(record: ExecutionRecord) {
    const remaining = Date.parse(record.expiresAt) - Date.now();
    if (remaining < 1000)
      throw executionError("EXECUTION_EXPIRED", "The cloud session reached its lifetime limit.");
    return remaining;
  }

  private async inventory(record: ExecutionRecord): Promise<SandboxInfo[]> {
    const pages = this.sdk.list({
      apiKey: this.key(),
      requestTimeoutMs: 15_000,
      query: { metadata: this.metadata(record), state: ["running", "paused"] },
    });
    const result: SandboxInfo[] = [];
    for (let page = 0; pages.hasNext; page++) {
      if (page >= 20)
        throw executionError(
          "EXECUTION_INVENTORY_TOO_LARGE",
          "Cloud inventory exceeded its page limit.",
        );
      result.push(...(await pages.nextItems()));
      if (result.length > 1000)
        throw executionError(
          "EXECUTION_INVENTORY_TOO_LARGE",
          "Cloud inventory exceeded its safety limit.",
        );
    }
    if (
      result.some(
        (sandbox) =>
          sandbox.metadata.station_execution !== record.token ||
          sandbox.metadata.station_session !== record.sessionId,
      )
    ) {
      throw executionError(
        "EXECUTION_IDENTITY_CONFLICT",
        "Cloud inventory returned a different execution identity.",
      );
    }
    return result;
  }

  private async connection(record: ExecutionRecord): Promise<Sandbox> {
    this.remaining(record);
    if (record.sandboxId === undefined) {
      const matches = await this.inventory(record);
      if (matches.length !== 1 || matches[0] === undefined)
        throw executionError(
          "EXECUTION_CREATE_UNCERTAIN",
          "The original sandbox creation is uncertain.",
        );
      record.sandboxId = matches[0].sandboxId;
      await this.store.write(record);
    }
    const info = await this.sdk.getInfo(record.sandboxId, {
      apiKey: this.key(),
      requestTimeoutMs: 10_000,
    });
    if (
      info.metadata.station_execution !== record.token ||
      info.metadata.station_session !== record.sessionId ||
      info.state !== "running"
    )
      throw executionError(
        "EXECUTION_IDENTITY_CONFLICT",
        "Cloud identity or running state could not be verified. No compute was resumed.",
      );
    let sandbox = this.connections.get(record.sessionId);
    if (sandbox === undefined) {
      sandbox = await this.sdk.connect(record.sandboxId, {
        apiKey: this.key(),
        timeoutMs: Math.max(1000, this.remaining(record) - 1000),
        requestTimeoutMs: 15_000,
      });
      this.connections.set(record.sessionId, sandbox);
    }
    return sandbox;
  }

  private async recoverRemoteSession(
    record: ExecutionRecord,
    sandbox: Sandbox,
    requireCompletedLaunch = false,
  ): Promise<void> {
    if (record.remoteSessionId !== undefined) return;
    let completedSessionId: string | undefined;
    if (requireCompletedLaunch) {
      const output = await this.run(sandbox, `cat '${ROOT}/launch-result.json'`);
      const result = z
        .object({
          status: z.literal("succeeded"),
          command: z
            .object({
              status: z.literal("succeeded"),
              result: z.object({ sessionId: z.string().min(1) }).passthrough(),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(JSON.parse(output));
      completedSessionId = result.command.result.sessionId;
    }
    const output = await this.run(
      sandbox,
      `stn --config '${CONFIG}' session list --project cloud --json`,
      15_000,
    );
    const result = z
      .object({ sessions: z.array(RuntimeSessionSchema) })
      .passthrough()
      .parse(JSON.parse(output));
    const matches = result.sessions.filter(
      (session) =>
        session.harness.provider === record.harness &&
        (completedSessionId === undefined || session.sessionId === completedSessionId),
    );
    if (matches.length !== 1 || matches[0] === undefined) return;
    record.remoteSessionId = matches[0].sessionId;
    record.remotePath = matches[0].path;
    if (requireCompletedLaunch) record.phase = "running";
    await this.store.write(record);
  }

  private async stopRecord(record: ExecutionRecord): Promise<void> {
    this.bridge?.revoke(record.sessionId);
    if (record.phase === "stopped") return;
    const sandbox = await this.connection(record);
    await this.recoverRemoteSession(record, sandbox);
    if (record.remoteSessionId === undefined)
      throw executionError(
        "EXECUTION_LAUNCH_UNCERTAIN",
        "The original remote session has not been identified.",
      );
    record.phase = "stopping";
    await this.store.write(record);
    await this.run(
      sandbox,
      `stn --config '${CONFIG}' session close ${shellQuote(record.remoteSessionId)} --mode all --force --json`,
    );
    record.phase = "stopped";
    await this.store.write(record);
  }

  private async collectRecord(record: ExecutionRecord): Promise<void> {
    const sandbox = await this.connection(record);
    await this.recoverRemoteSession(record, sandbox);
    const nonce = randomUUID();
    const output = await this.run(sandbox, collectScript(record, nonce));
    const lines = z
      .tuple([
        z.string().regex(/^\s*\d+\s*$/),
        z.string().regex(/^[a-f0-9]{40}$/),
        z.string().regex(/^[a-f0-9]{64} {2}.+$/),
      ])
      .parse(output.trim().split("\n"));
    const bytes = Number(lines[0]);
    if (bytes > MAX_TRANSFER_BYTES)
      throw executionError(
        "EXECUTION_RESULT_TOO_LARGE",
        "The cloud patch exceeds 64 MiB; the sandbox was retained.",
      );
    const stream = await sandbox.files.read(`${ROOT}/result-${nonce}.patch`, {
      format: "stream",
      requestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 10_000,
      signal: AbortSignal.timeout(60_000),
    });
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.length;
        if (received > bytes || received > MAX_TRANSFER_BYTES)
          throw executionError(
            "EXECUTION_RESULT_INVALID",
            "Cloud result exceeded its declared size.",
          );
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const patch = Buffer.concat(chunks);
    const digest = createHash("sha256").update(patch).digest("hex");
    if (patch.length !== bytes || digest !== lines[2].slice(0, 64))
      throw executionError(
        "EXECUTION_RESULT_INVALID",
        "Cloud result integrity could not be verified.",
      );
    const directory = join(this.options.stateDir, "execution-results", record.sessionId, nonce);
    await privateDirectory(directory);
    await durableFile(join(directory, "changes.patch"), patch);
    await durableFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        sessionId: record.sessionId,
        baseCommit: record.baseCommit,
        baseTree: record.baseTree,
        resultTree: lines[1],
        sha256: digest,
        bytes,
      }),
    );
    const savedDirectory = await open(directory, "r");
    try {
      await savedDirectory.sync();
    } finally {
      await savedDirectory.close();
    }
    record.resultDirectory = directory;
    record.finalResultSaved = record.phase === "stopped";
    // Persist parent directory entries before the journal can authorize destruction.
    for (const parent of [
      join(this.options.stateDir, "execution-results", record.sessionId),
      join(this.options.stateDir, "execution-results"),
      this.options.stateDir,
    ]) {
      const handle = await open(parent, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await this.store.write(record);
  }

  private async launchPlan(record: ExecutionRecord): Promise<HarnessLaunchPlan> {
    this.bridge ??= await createExecutionBridge(
      this.options.bridgeDirectory,
      (id, cols, rows, output) => this.openAttachment(id, cols, rows, output),
    );
    const bridge = this.bridge;
    const [command, ...args] = this.options.bridgeCommand;
    return {
      provider: record.harness,
      command: "/usr/bin/env",
      args: [
        ...[
          this.options.apiKeyEnv,
          ...Object.values(this.options.harnessEnv[record.harness] ?? {}),
        ].flatMap((name) => ["-u", name]),
        command,
        ...args,
        "execution",
        "attach",
        bridge.path,
        record.sessionId,
      ],
      cwd: record.worktreePath,
      mode: "interactive",
      displayTitle: "[cloud] Agent",
    };
  }

  private async openAttachment(
    sessionId: string,
    cols: number,
    rows: number,
    output: (data: Uint8Array) => void,
  ): Promise<RemoteAttachment> {
    const record = await this.store.read(sessionId);
    if (record.phase !== "running" || this.revoked.has(sessionId))
      throw executionError("EXECUTION_NOT_RUNNING", "The cloud agent cannot be attached.");
    const sandbox = await this.connection(record);
    const nonce = randomUUID();
    const windows = (
      await this.run(
        sandbox,
        `tmux -S '${ROOT}/tmux.sock' list-windows -a -F '#{window_id} #{@station.session_id}'`,
      )
    )
      .trim()
      .split("\n");
    const matches = windows.filter((line) => line.split(" ")[1] === record.remoteSessionId);
    if (matches.length !== 1)
      throw executionError(
        "EXECUTION_TERMINAL_MISSING",
        "The original cloud terminal could not be identified.",
      );
    const window = z
      .string()
      .regex(/^@\d+$/)
      .parse(matches[0]?.split(" ")[0]);
    const handle = await sandbox.pty.create({
      cols,
      rows,
      timeoutMs: this.remaining(record),
      requestTimeoutMs: 15_000,
      envs: { ...REMOTE_ENV, STATION_ATTACHMENT_ID: nonce },
      onData: output,
    });
    let active = true;
    const verify = async () => {
      if (!active || this.revoked.has(sessionId)) throw new Error("Detached");
      const current = await this.store.read(sessionId);
      if (current.phase !== "running" || this.revoked.has(sessionId)) {
        active = false;
        throw new Error("Stopped");
      }
    };
    try {
      await sandbox.pty.sendInput(
        handle.pid,
        Buffer.from(
          `tmux -S '${ROOT}/tmux.sock' select-window -t ${shellQuote(window)} && exec tmux -S '${ROOT}/tmux.sock' attach-session -d -t station-cloud\n`,
        ),
      );
    } catch {
      await handle.disconnect();
      throw executionError(
        "EXECUTION_ATTACH_UNCERTAIN",
        "Cloud terminal attachment failed; the agent was retained.",
      );
    }
    return {
      input: async (data) => {
        await verify();
        await sandbox.pty.sendInput(handle.pid, data, { requestTimeoutMs: 10_000 });
      },
      resize: async (newCols, newRows) => {
        await verify();
        await sandbox.pty.resize(
          handle.pid,
          { cols: newCols, rows: newRows },
          { requestTimeoutMs: 10_000 },
        );
      },
      detach: async () => {
        active = false;
        await handle.disconnect();
        const process = (await sandbox.commands.list({ requestTimeoutMs: 10_000 })).find(
          (candidate) =>
            candidate.pid === handle.pid && candidate.envs.STATION_ATTACHMENT_ID === nonce,
        );
        if (process !== undefined)
          await sandbox.pty.kill(process.pid, { requestTimeoutMs: 10_000 });
      },
    };
  }

  private async run(
    sandbox: Sandbox,
    command: string,
    timeoutMs = 30_000,
    envs: Record<string, string> = {},
  ): Promise<string> {
    const controller = new AbortController();
    let bytes = 0;
    const output = (text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > 1024 * 1024) controller.abort();
    };
    try {
      const result = await sandbox.commands.run(
        `export PATH=${shellQuote(REMOTE_ENV.PATH)}\n${command}`,
        {
          envs: { ...REMOTE_ENV, ...envs },
          timeoutMs,
          requestTimeoutMs: timeoutMs + 5000,
          signal: controller.signal,
          onStdout: output,
          onStderr: output,
        },
      );
      if (result.exitCode !== 0) throw new Error("Remote command failed");
      return result.stdout;
    } catch {
      throw executionError(
        "EXECUTION_REMOTE_COMMAND_FAILED",
        "A cloud operation failed. Remote work was retained; inspect the session before retrying.",
      );
    }
  }

  private revoke(sessionId: string): void {
    this.revoked.add(sessionId);
    this.bridge?.revoke(sessionId);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
