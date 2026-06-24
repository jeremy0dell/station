import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ProjectIdSchema,
  type ProviderProjectConfig,
  RecoveryBreadcrumbSchema,
  SessionIdSchema,
  WorktreeIdSchema,
  type WorktreeObservation,
} from "@station/contracts";
import { z } from "zod";

export const WorktrunkMetadataSchema = z
  .object({
    source: z.enum(["provider-native", "worktree-breadcrumb"]),
    projectId: ProjectIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
  })
  .strict();

export type WorktrunkMetadata = z.infer<typeof WorktrunkMetadataSchema>;

type ReadTextFile = (path: string) => Promise<string>;

export function providerNativeMetadataFromWorktrunkItem(
  item: unknown,
): WorktrunkMetadata | undefined {
  const record = asRecord(item);
  if (record === undefined) {
    return undefined;
  }

  const vars = asRecord(record.vars);
  const station = asRecord(vars?.station);
  const candidates = [
    {
      projectId: stringValue(station?.project_id ?? station?.projectId),
      worktreeId: stringValue(station?.worktree_id ?? station?.worktreeId),
      sessionId: stringValue(station?.session_id ?? station?.sessionId),
    },
    {
      projectId: stringValue(vars?.station_project_id ?? vars?.STATION_PROJECT_ID),
      worktreeId: stringValue(vars?.station_worktree_id ?? vars?.STATION_WORKTREE_ID),
      sessionId: stringValue(vars?.station_session_id ?? vars?.STATION_SESSION_ID),
    },
  ];

  const candidate = candidates.find((value) =>
    [value.projectId, value.worktreeId, value.sessionId].some((field) => field !== undefined),
  );
  if (candidate === undefined) {
    return undefined;
  }

  const metadata: WorktrunkMetadata = {
    source: "provider-native",
  };
  if (candidate.projectId !== undefined) metadata.projectId = candidate.projectId;
  if (candidate.worktreeId !== undefined) metadata.worktreeId = candidate.worktreeId;
  if (candidate.sessionId !== undefined) metadata.sessionId = candidate.sessionId;

  return WorktrunkMetadataSchema.parse(metadata);
}

export async function applyRecoveryBreadcrumbMetadata(
  observation: WorktreeObservation,
  project: ProviderProjectConfig,
  options: { readTextFile?: ReadTextFile } = {},
): Promise<WorktreeObservation> {
  if (metadataFromObservation(observation)?.source === "provider-native") {
    return observation;
  }
  if (project.recoveryBreadcrumbs?.location !== "worktree") {
    return observation;
  }

  const configuredPath = project.recoveryBreadcrumbs.path ?? ".station/recovery-breadcrumb.json";
  const path = resolve(observation.path, configuredPath);
  const source = await readOptionalText(path, options.readTextFile ?? readFileUtf8);
  if (source === undefined) {
    return observation;
  }

  const metadata = parseBreadcrumbMetadata(source);
  if (metadata === undefined || metadata.projectId !== project.id) {
    return observation;
  }

  return applyMetadataToObservation(observation, metadata);
}

export function applyMetadataToObservation(
  observation: WorktreeObservation,
  metadata: WorktrunkMetadata | undefined,
): WorktreeObservation {
  if (metadata === undefined) {
    return observation;
  }

  const providerData: Record<string, unknown> = {
    ...(asRecord(observation.providerData) ?? {}),
  };
  providerData.metadata = metadata;

  return {
    ...observation,
    id: metadata.worktreeId ?? observation.id,
    providerData,
  };
}

export function metadataFromObservation(
  observation: WorktreeObservation,
): WorktrunkMetadata | undefined {
  return parseWorktrunkMetadata(asRecord(observation.providerData)?.metadata);
}

function parseBreadcrumbMetadata(source: string): WorktrunkMetadata | undefined {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }

  const parsed = RecoveryBreadcrumbSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }

  const breadcrumb = parsed.data;

  const metadata: WorktrunkMetadata = {
    source: "worktree-breadcrumb",
    projectId: breadcrumb.projectId,
  };
  if (breadcrumb.worktreeId !== undefined) metadata.worktreeId = breadcrumb.worktreeId;
  if (breadcrumb.sessionId !== undefined) metadata.sessionId = breadcrumb.sessionId;

  return WorktrunkMetadataSchema.parse(metadata);
}

async function readOptionalText(
  path: string,
  readTextFile: ReadTextFile,
): Promise<string | undefined> {
  try {
    return await readTextFile(path);
  } catch {
    return undefined;
  }
}

async function readFileUtf8(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseWorktrunkMetadata(input: unknown): WorktrunkMetadata | undefined {
  const parsed = WorktrunkMetadataSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
