import { describe, expect, it } from "vitest";
import type { PersistedSession, PersistedWorktreeDisplayTitle } from "../../src/persistence/types";
import { resolveWorktreeDisplayTitle } from "../../src/worktreeDisplayTitle";

const branch = "feature/current";
const projectId = "web";
const worktreeId = "shared-worktree-id";

function session(
  id: string,
  title: string,
  overrides: Partial<PersistedSession> = {},
): PersistedSession {
  return {
    id,
    projectId,
    worktreeId,
    lifecycle: "open",
    title,
    createdAt: "2026-05-20T12:00:00.000Z",
    lastSeenAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

function canonical(
  title: string,
  overrides: Partial<PersistedWorktreeDisplayTitle> = {},
): PersistedWorktreeDisplayTitle {
  return {
    projectId,
    worktreeId,
    title,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

function resolve(input: {
  branch?: string;
  canonicalTitles?: readonly PersistedWorktreeDisplayTitle[];
  sessions?: readonly PersistedSession[];
}): string {
  return resolveWorktreeDisplayTitle({
    projectId,
    worktreeId,
    branch: input.branch ?? branch,
    canonicalTitles: input.canonicalTitles ?? [],
    sessions: input.sessions ?? [],
  });
}

describe("worktree display title policy", () => {
  it("always prefers canonical worktree title authority", () => {
    expect(
      resolve({
        canonicalTitles: [canonical("Canonical workspace")],
        sessions: [session("ses_new", "Newer custom", { lastSeenAt: "2026-05-22T12:00:00.000Z" })],
      }),
    ).toBe("Canonical workspace");
  });

  it("prefers an earlier custom title over a later branch-default seed", () => {
    expect(
      resolve({
        sessions: [
          session("ses_custom", "Readable task", { lastSeenAt: "2026-05-20T12:00:00.000Z" }),
          session("ses_branch", branch, { lastSeenAt: "2026-05-21T12:00:00.000Z" }),
        ],
      }),
    ).toBe("Readable task");
  });

  it("chooses the newest custom title among multiple custom titles", () => {
    expect(
      resolve({
        sessions: [
          session("ses_old", "Old title"),
          session("ses_new", "New title", { lastSeenAt: "2026-05-21T12:00:00.000Z" }),
        ],
      }),
    ).toBe("New title");
  });

  it("excludes ended sessions when a worktree identity is recreated", () => {
    expect(
      resolve({
        sessions: [session("ses_ended", "Retired title", { lifecycle: "ended" })],
      }),
    ).toBe(branch);
  });

  it.each([
    "open",
    "legacy",
  ] as const)("allows %s session evidence to seed migration", (lifecycle) => {
    expect(
      resolve({ sessions: [session(`ses_${lifecycle}`, "Migrated title", { lifecycle })] }),
    ).toBe("Migrated title");
  });

  it("ignores blank legacy title evidence", () => {
    expect(resolve({ sessions: [session("ses_blank", "   ")] })).toBe(branch);
  });

  it("falls back to the current branch without title evidence", () => {
    expect(resolve({})).toBe(branch);
  });

  it("preserves an established canonical title after the branch changes", () => {
    expect(
      resolve({
        branch: "feature/renamed",
        canonicalTitles: [canonical("Stable workspace")],
      }),
    ).toBe("Stable workspace");
  });

  it("scopes title evidence by project and worktree composite identity", () => {
    expect(
      resolve({
        canonicalTitles: [canonical("Other project", { projectId: "api" })],
        sessions: [session("ses_other", "Other project session", { projectId: "api" })],
      }),
    ).toBe(branch);
  });

  it("uses created time and descending session ID as deterministic recency ties", () => {
    expect(
      resolve({
        sessions: [
          session("ses_a", "Older creation", { createdAt: "2026-05-19T12:00:00.000Z" }),
          session("ses_b", "Later creation"),
        ],
      }),
    ).toBe("Later creation");

    expect(
      resolve({
        sessions: [session("ses_a", "Lower ID"), session("ses_z", "Higher ID")],
      }),
    ).toBe("Higher ID");
  });
});
