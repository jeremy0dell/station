import { open } from "node:fs/promises";
import { z } from "zod";

const DEFAULT_MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const jsonObjectSchema = z.record(z.string(), z.unknown());
const nonEmptyStringSchema = z.string().min(1);

export const CodexApprovalsReviewerSchema = z.enum(["user", "auto_review"]);

const CodexPermissionReviewerUnavailableReasonSchema = z.enum([
  "transcript_path_missing",
  "transcript_unreadable",
  "turn_context_not_found",
  "turn_context_malformed",
  "transcript_scan_limit_reached",
  "approvals_reviewer_unrecognized",
]);

export const CodexPermissionReviewerEvidenceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("resolved"),
      source: z.literal("transcript_turn_context"),
      reviewer: CodexApprovalsReviewerSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      source: z.literal("transcript_turn_context"),
      reason: CodexPermissionReviewerUnavailableReasonSchema,
    })
    .strict(),
]);

export type CodexPermissionReviewerEvidence = z.infer<typeof CodexPermissionReviewerEvidenceSchema>;

export const CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD =
  "station_codex_permission_reviewer_evidence";

const PermissionRequestLookupSchema = z
  .object({
    hook_event_name: z.literal("PermissionRequest"),
    transcript_path: nonEmptyStringSchema.nullable(),
    turn_id: nonEmptyStringSchema,
  })
  .strict();

const TranscriptEnvelopeSchema = z
  .object({
    type: z.literal("turn_context"),
    payload: jsonObjectSchema,
  })
  .strict();

const TranscriptTurnIdSchema = z
  .object({
    turn_id: nonEmptyStringSchema,
  })
  .strict();

export type CodexPermissionReviewerEnrichmentOptions = {
  maxTranscriptBytes?: number;
};

/**
 * ADAPTER
 *
 * Removes caller-supplied reviewer claims and reads a bounded Codex transcript tail so only a
 * strictly parsed, matching turn context can add provider-private permission-reviewer evidence.
 */
export async function enrichCodexPermissionReviewerEvidence(
  payload: unknown,
  options: CodexPermissionReviewerEnrichmentOptions = {},
): Promise<unknown> {
  const payloadResult = jsonObjectSchema.safeParse(payload);
  if (!payloadResult.success) return payload;

  const nativePayload = Object.fromEntries(
    Object.entries(payloadResult.data).filter(
      ([fieldName]) => fieldName !== CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD,
    ),
  );
  const lookupResult = PermissionRequestLookupSchema.safeParse({
    hook_event_name: nativePayload.hook_event_name,
    transcript_path: nativePayload.transcript_path,
    turn_id: nativePayload.turn_id,
  });
  if (!lookupResult.success) return nativePayload;

  const evidence =
    lookupResult.data.transcript_path === null
      ? unavailableEvidence("transcript_path_missing")
      : await reviewerEvidenceFromTranscript(
          lookupResult.data.transcript_path,
          lookupResult.data.turn_id,
          options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES,
        );
  return {
    ...nativePayload,
    [CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD]: evidence,
  };
}

async function reviewerEvidenceFromTranscript(
  transcriptPath: string,
  turnId: string,
  maxTranscriptBytes: number,
): Promise<CodexPermissionReviewerEvidence> {
  let transcript: BoundedTranscriptTail;
  try {
    transcript = await readBoundedTranscriptTail(transcriptPath, maxTranscriptBytes);
  } catch {
    return unavailableEvidence("transcript_unreadable");
  }

  const lines = transcript.text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.includes("turn_context") || !line.includes(turnId)) continue;
    const context = transcriptTurnContext(line);
    if (context === undefined) return unavailableEvidence("turn_context_malformed");
    if (context.turnId !== turnId) continue;
    if (context.reviewer === undefined) {
      return unavailableEvidence("approvals_reviewer_unrecognized");
    }
    return CodexPermissionReviewerEvidenceSchema.parse({
      status: "resolved",
      source: "transcript_turn_context",
      reviewer: context.reviewer,
    });
  }

  return unavailableEvidence(
    transcript.truncatedAtStart ? "transcript_scan_limit_reached" : "turn_context_not_found",
  );
}

type TranscriptTurnContext = {
  turnId: string;
  reviewer?: z.infer<typeof CodexApprovalsReviewerSchema>;
};

function transcriptTurnContext(line: string): TranscriptTurnContext | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  const recordResult = jsonObjectSchema.safeParse(parsed);
  if (!recordResult.success) return undefined;
  const payloadResult = jsonObjectSchema.safeParse(recordResult.data.payload);
  if (!payloadResult.success) return undefined;
  const envelopeResult = TranscriptEnvelopeSchema.safeParse({
    type: recordResult.data.type,
    payload: payloadResult.data,
  });
  if (!envelopeResult.success) return undefined;
  const turnResult = TranscriptTurnIdSchema.safeParse({
    turn_id: envelopeResult.data.payload.turn_id,
  });
  if (!turnResult.success) return undefined;
  const reviewerResult = CodexApprovalsReviewerSchema.safeParse(
    envelopeResult.data.payload.approvals_reviewer,
  );
  const context: TranscriptTurnContext = { turnId: turnResult.data.turn_id };
  if (reviewerResult.success) context.reviewer = reviewerResult.data;
  return context;
}

type BoundedTranscriptTail = {
  text: string;
  truncatedAtStart: boolean;
};

async function readBoundedTranscriptTail(
  transcriptPath: string,
  maxTranscriptBytes: number,
): Promise<BoundedTranscriptTail> {
  const handle = await open(transcriptPath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Codex transcript path is not a regular file.");
    const byteLimit = Math.max(1, Math.floor(maxTranscriptBytes));
    const byteCount = Math.min(stats.size, byteLimit);
    const start = stats.size - byteCount;
    const buffer = Buffer.allocUnsafe(byteCount);
    let bytesRead = 0;
    while (bytesRead < byteCount) {
      const result = await handle.read(buffer, bytesRead, byteCount - bytesRead, start + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstLineEnd = text.indexOf("\n");
      text = firstLineEnd === -1 ? "" : text.slice(firstLineEnd + 1);
    }
    return { text, truncatedAtStart: start > 0 };
  } finally {
    await handle.close();
  }
}

function unavailableEvidence(
  reason: z.infer<typeof CodexPermissionReviewerUnavailableReasonSchema>,
): CodexPermissionReviewerEvidence {
  return CodexPermissionReviewerEvidenceSchema.parse({
    status: "unavailable",
    source: "transcript_turn_context",
    reason,
  });
}
