import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { SafeError } from "@station/contracts";
import { SafeErrorSchema } from "@station/contracts";
import { z } from "zod";
import { GatewayConfigSchema, RuntimeArtifactSchema } from "./terminalProtocol.js";

const LegacyExecutionRecordSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().regex(/^ses_[a-zA-Z0-9_-]+$/),
    token: z.uuid(),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    worktreePath: z.string().min(1),
    harness: z.string().regex(/^[a-z][a-z0-9-]*$/),
    template: z.string().min(1),
    expiresAt: z.iso.datetime(),
    phase: z.enum([
      "creating",
      "preparing",
      "launching",
      "running",
      "stopping",
      "stopped",
      "destroying",
      "destroyed",
    ]),
    sandboxId: z.string().min(1).optional(),
    remoteSessionId: z.string().min(1).optional(),
    remotePath: z.string().min(1).optional(),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    baseTree: z.string().regex(/^[a-f0-9]{40}$/),
    resultDirectory: z.string().min(1).optional(),
    finalResultSaved: z.boolean().optional(),
    launchError: SafeErrorSchema.optional(),
  })
  .strict();
export const NativeExecutionRecordSchema = LegacyExecutionRecordSchema.extend({
  version: z.literal(2),
  transport: z.literal("host-websocket"),
  runtime: RuntimeArtifactSchema,
  gateway: GatewayConfigSchema.optional(),
  remoteRuntime: z
    .object({ version: z.string(), buildIdentity: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .optional(),
}).strict();
export const ExecutionRecordSchema = z.discriminatedUnion("version", [
  LegacyExecutionRecordSchema,
  NativeExecutionRecordSchema,
]);
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

export function executionError(code: string, message: string): SafeError {
  return { tag: "AgentExecutionError", provider: "e2b", code, message };
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw executionError(
      "EXECUTION_STATE_PERMISSIONS",
      "Cloud state must be a private directory owned by this user.",
    );
  }
}

export class ExecutionStore {
  constructor(readonly directory: string) {}

  async read(sessionId: string): Promise<ExecutionRecord> {
    const id = LegacyExecutionRecordSchema.shape.sessionId.parse(sessionId);
    return ExecutionRecordSchema.parse(
      JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")),
    );
  }

  async list(): Promise<ExecutionRecord[]> {
    await privateDirectory(this.directory);
    const names = (await readdir(this.directory)).filter((name) =>
      /^ses_[a-zA-Z0-9_-]+\.json$/.test(name),
    );
    return Promise.all(names.map((name) => this.read(name.slice(0, -5))));
  }

  async write(record: ExecutionRecord, create = false): Promise<void> {
    const value = ExecutionRecordSchema.parse(record);
    await privateDirectory(this.directory);
    const destination = join(this.directory, `${value.sessionId}.json`);
    const temporary = create ? destination : join(this.directory, `.${randomUUID()}.json`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    if (!create) await rename(temporary, destination);
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export async function durableFile(path: string, data: string | Uint8Array): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
}
