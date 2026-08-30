import { randomUUID } from "node:crypto";
import type { ProjectId } from "@station/contracts";
import { stableName, stableNameHash } from "@station/runtime";

export function generatedSessionBranch(projectId: ProjectId, token: string): string {
  return stableName({
    profile: "path-segment",
    display: [projectId, token],
    unique: [projectId, token],
  });
}

export function createNewSessionNameToken(unique: string = randomUUID()): string {
  return stableNameHash(["new-session", unique], 6);
}
