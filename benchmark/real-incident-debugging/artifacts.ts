import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Citation, TrialAttemptStatus, TrialOutput, TrialRecord } from "./protocol.js";

export type RunPaths = {
  root: string;
  official: string;
  raw: string;
  blind: string;
  state: string;
};

export type BlindReviewPacket = {
  schemaVersion: 1;
  reviewId: string;
  caseId: string;
  symptom: string;
  terminalStatus: TrialAttemptStatus;
  response?: TrialOutput;
  citedEvidence: Array<{
    field: "proximateFailure" | "ownership" | "underlyingCause";
    commandNumber: number;
    literal: string;
    output: string;
  }>;
};

export async function createRunPaths(root: string): Promise<RunPaths> {
  const paths: RunPaths = {
    root,
    official: join(root, "official"),
    raw: join(root, "raw"),
    blind: join(root, "blind"),
    state: join(root, "run-state.json"),
  };
  await Promise.all(
    [paths.root, paths.official, paths.raw, paths.blind].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  return paths;
}

export async function writeTrialArtifact(input: {
  paths: RunPaths;
  record: TrialRecord;
  stdoutJsonl: string;
}): Promise<void> {
  const officialRoot = join(input.paths.official, "trials", input.record.trialId);
  const rawRoot = join(input.paths.raw, "trials", input.record.trialId);
  const attempt = input.record.attempts.at(-1);
  if (attempt === undefined) {
    throw new Error(
      `Cannot write an artifact for a trial with no attempts: ${input.record.trialId}`,
    );
  }
  await writeJson(join(officialRoot, "trial.json"), input.record);
  await writeText(
    join(rawRoot, `attempt-${attempt.attempt}-codex-events.jsonl`),
    input.stdoutJsonl,
  );
}

export async function writeRunState(paths: RunPaths, value: unknown): Promise<void> {
  await writeJson(paths.state, value);
}

export async function readRunState<T>(paths: RunPaths): Promise<T | undefined> {
  const text = await readFile(paths.state, "utf8").catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

type CitationField = "proximateFailure" | "ownership" | "underlyingCause";

function sanitizeCitation(citation: Citation, labels: readonly string[]): Citation {
  return {
    ...citation,
    literal: sanitizeBlindText(citation.literal, labels),
  };
}

function citationEntries(output: TrialOutput): Array<{ field: CitationField; citation: Citation }> {
  const entries: Array<{ field: CitationField; citation: Citation }> = [
    { field: "proximateFailure", citation: output.proximateCitation },
    { field: "ownership", citation: output.ownershipCitation },
  ];
  if (output.underlyingCauseCitation !== null) {
    entries.push({ field: "underlyingCause", citation: output.underlyingCauseCitation });
  }
  return entries;
}

export function createBlindReviewPacket(input: {
  record: TrialRecord;
  symptom: string;
}): BlindReviewPacket {
  const output = completedOutput(input.record);
  const sensitiveLabels = [input.record.trialId, input.record.blindArm];
  const sanitizedOutput =
    output === undefined
      ? undefined
      : {
          ...output,
          proximateFailure: sanitizeBlindText(output.proximateFailure, sensitiveLabels),
          underlyingCause: sanitizeBlindText(output.underlyingCause, sensitiveLabels),
          responsibleSubsystem: sanitizeBlindText(output.responsibleSubsystem, sensitiveLabels),
          nextActions: output.nextActions.map((action) =>
            sanitizeBlindText(action, sensitiveLabels),
          ),
          proximateCitation: sanitizeCitation(output.proximateCitation, sensitiveLabels),
          ownershipCitation: sanitizeCitation(output.ownershipCitation, sensitiveLabels),
          underlyingCauseCitation:
            output.underlyingCauseCitation === null
              ? null
              : sanitizeCitation(output.underlyingCauseCitation, sensitiveLabels),
        };
  const lastAttempt = input.record.attempts.at(-1);
  if (lastAttempt === undefined) {
    throw new Error(`Trial has no attempts: ${input.record.trialId}`);
  }
  const citedEvidence =
    output === undefined
      ? []
      : citationEntries(output).map(({ field, citation }) => {
          const command = lastAttempt.commands[citation.commandNumber - 1];
          return {
            field,
            commandNumber: citation.commandNumber,
            literal: sanitizeBlindText(citation.literal, sensitiveLabels),
            output: sanitizeBlindText(command?.output ?? "", sensitiveLabels),
          };
        });
  const packet: BlindReviewPacket = {
    schemaVersion: 1,
    reviewId: reviewIdFor(input.record.trialId),
    caseId: input.record.incidentId,
    symptom: sanitizeBlindText(input.symptom, sensitiveLabels),
    terminalStatus: lastAttempt.status,
    citedEvidence,
  };
  if (sanitizedOutput !== undefined) {
    packet.response = sanitizedOutput;
  }
  return packet;
}

export async function writeBlindReviewPacket(
  paths: RunPaths,
  packet: BlindReviewPacket,
): Promise<void> {
  await writeJson(join(paths.blind, "packets", `${packet.reviewId}.json`), packet);
}

export function assertBlindPacketHasNoArmLabels(
  packet: BlindReviewPacket,
  labels: readonly string[],
): void {
  const serialized = JSON.stringify(packet);
  for (const label of labels) {
    if (serialized.includes(label)) {
      throw new Error(`Blind review packet leaks arm label: ${label}`);
    }
  }
}

export function assertBlindPacketHasNoPrivatePaths(packet: BlindReviewPacket): void {
  const serialized = JSON.stringify(packet);
  if (/\/(?:Users|home)\//u.test(serialized)) {
    throw new Error("Blind review packet leaks a private absolute path.");
  }
}

export function reviewIdFor(trialId: string): string {
  return `review-${createHash("sha256").update(trialId).digest("hex").slice(0, 20)}`;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function sanitizeBlindText(value: string, labels: readonly string[]): string {
  // CLI evidence may echo absolute copied-workspace paths that disclose the study checkout.
  const pathSanitized = value.replace(
    /\/(?:Users|home)\/[^"'\n\r\\]+/gu,
    (path) => `[REDACTED_PATH]/${basename(path)}`,
  );
  return labels.reduce(
    (sanitized, label) =>
      label.length === 0 ? sanitized : sanitized.replaceAll(label, "[REDACTED]"),
    pathSanitized,
  );
}

function completedOutput(record: TrialRecord) {
  const attempt = record.attempts.at(-1);
  return attempt?.status === "completed" ? attempt.output : undefined;
}
