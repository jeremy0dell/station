import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type RepairAudit, RepairAuditSchema } from "@station/contracts";
import { replaceTextFile } from "@station/runtime";

/** DRIVEN PORT: records, rediscovers, and finalizes every authorized repair attempt. */
export interface RepairAuditPort {
  findInProgress(): Promise<RepairAudit | undefined>;
  read(auditId: string): Promise<RepairAudit>;
  start(
    input: Omit<RepairAudit, "schemaVersion" | "id" | "status" | "createdAt" | "updatedAt">,
  ): Promise<RepairAudit>;
  finalize(
    audit: RepairAudit,
    update: Pick<RepairAudit, "status" | "errorCodes" | "recoveryCommands"> &
      Pick<Partial<RepairAudit>, "backup">,
  ): Promise<RepairAudit>;
}

/** ADAPTER: atomically stores redacted mode-0600 audit records under the configured state directory. */
export function createFilesystemRepairAuditPort(
  stateDir: string,
  options: { auditId?: () => string; now?: () => string } = {},
): RepairAuditPort {
  const directory = join(stateDir, "repair", "audit");
  const now = options.now ?? (() => new Date().toISOString());
  const read = async (auditId: string) => {
    const path = join(directory, `${auditId}.json`);
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("Repair audit permissions were not private.");
    }
    return RepairAuditSchema.parse(JSON.parse(await readFile(path, "utf8")));
  };
  const write = async (audit: RepairAudit) => {
    await replaceTextFile({
      path: join(directory, `${audit.id}.json`),
      contents: `${JSON.stringify(RepairAuditSchema.parse(audit))}\n`,
      mode: 0o600,
      directoryMode: 0o700,
    });
    const metadata = await stat(join(directory, `${audit.id}.json`));
    if ((metadata.mode & 0o777) !== 0o600) throw new Error("Repair audit was not private.");
  };
  return {
    async findInProgress() {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") return undefined;
        throw error;
      }
      const audits = await Promise.all(
        names
          .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name))
          .sort()
          .map((name) => read(name.slice(0, -".json".length))),
      );
      const inProgress = audits.filter((audit) => audit.status === "in-progress");
      if (inProgress.length > 1) {
        throw new Error("Multiple unfinished repair audits require manual recovery.");
      }
      return inProgress[0];
    },
    read,
    async start(input) {
      const timestamp = now();
      const audit = RepairAuditSchema.parse({
        schemaVersion: 1,
        id: (options.auditId ?? randomUUID)(),
        ...input,
        status: "in-progress",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await write(audit);
      return audit;
    },
    async finalize(audit, update) {
      const next = RepairAuditSchema.parse({
        ...audit,
        ...update,
        updatedAt: now(),
      });
      await write(next);
      return next;
    },
  };
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
