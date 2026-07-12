import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  HarnessEventReportSpoolRecord,
  ProviderHookSpoolRecord,
  SafeError,
} from "@station/contracts";
import {
  HarnessEventReportSpoolRecordSchema,
  ProviderHookSpoolRecordSchema,
} from "@station/contracts";

export type ParsedProviderIngressSpoolRecord =
  | { kind: "hook"; record: ProviderHookSpoolRecord }
  | { kind: "report"; record: HarnessEventReportSpoolRecord };

export type ProviderIngressSpoolEntry = {
  id: string;
  parsed?: ParsedProviderIngressSpoolRecord;
};

/**
 * DRIVEN PORT
 *
 * Supplies validated pending ingress records and commits their retry or removal state without exposing filesystem mechanics.
 */
export interface ProviderIngressSpoolStore {
  list(): Promise<ProviderIngressSpoolEntry[]>;
  depth(): Promise<number>;
  remove(id: string): Promise<void>;
  recordFailure(
    entry: ProviderIngressSpoolEntry & { parsed: ParsedProviderIngressSpoolRecord },
    error?: SafeError,
  ): Promise<void>;
}

/**
 * ADAPTER
 *
 * Stores provider ingress fallback records as strict JSON files and leaves malformed evidence in place for diagnostics.
 */
export function createFilesystemProviderIngressSpoolStore(
  spoolDir: string,
): ProviderIngressSpoolStore {
  return {
    list: async () => {
      let names: string[];
      try {
        names = await readdir(spoolDir);
      } catch {
        return [];
      }
      const entries: ProviderIngressSpoolEntry[] = [];
      for (const id of names.filter((name) => name.endsWith(".json")).sort()) {
        try {
          const raw: unknown = JSON.parse(await readFile(join(spoolDir, id), "utf8"));
          entries.push({ id, parsed: parseSpoolRecord(raw) });
        } catch {
          entries.push({ id });
        }
      }
      return entries;
    },
    depth: async () => {
      try {
        return (await readdir(spoolDir)).filter((name) => name.endsWith(".json")).length;
      } catch {
        return 0;
      }
    },
    remove: (id) => unlink(join(spoolDir, id)),
    recordFailure: async (entry, error) => {
      const updated = {
        ...entry.parsed.record,
        attempts: entry.parsed.record.attempts + 1,
      };
      if (error !== undefined) {
        updated.lastError = error;
      }
      const schema =
        entry.parsed.kind === "hook"
          ? ProviderHookSpoolRecordSchema
          : HarnessEventReportSpoolRecordSchema;
      await writeFile(join(spoolDir, entry.id), JSON.stringify(schema.parse(updated), null, 2), {
        mode: 0o600,
      });
    },
  };
}

export function providerIngressSpoolDir(stateDir: string): string {
  return join(stateDir, "spool", "hooks");
}

function parseSpoolRecord(input: unknown): ParsedProviderIngressSpoolRecord {
  const hook = ProviderHookSpoolRecordSchema.safeParse(input);
  if (hook.success) {
    return { kind: "hook", record: hook.data };
  }
  return { kind: "report", record: HarnessEventReportSpoolRecordSchema.parse(input) };
}
