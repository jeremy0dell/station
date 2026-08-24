import type { TerminalTargetId } from "@station/contracts";
import { z } from "zod";

const TmuxTargetIdFieldsSchema = z.tuple([
  z.literal("tmux"),
  z.string().regex(/^[a-f0-9]{64}$/u),
  z.string().regex(/^\$\d+$/u),
  z.string().regex(/^@\d+$/u),
  z.string().regex(/^%\d+$/u),
]);

export type TmuxTargetIdentity = {
  generation: string;
  sessionId: string;
  windowId: string;
  paneId: string;
};

export function buildTmuxTargetId(input: TmuxTargetIdentity): TerminalTargetId {
  return TmuxTargetIdFieldsSchema.parse([
    "tmux",
    input.generation,
    input.sessionId,
    input.windowId,
    input.paneId,
  ]).join(":");
}

export function parseTmuxTargetId(targetId: string): TmuxTargetIdentity {
  const parsed = TmuxTargetIdFieldsSchema.safeParse(targetId.split(":"));
  if (!parsed.success) {
    throw new Error("Invalid tmux target identity.");
  }
  const [, generation, sessionId, windowId, paneId] = parsed.data;
  return { generation, sessionId, windowId, paneId };
}
