import type { ProjectId } from "@station/contracts";
import { describe, expect, it } from "vitest";
import type { ProviderReadOutcome } from "../../src/reconcile/providerObservations.js";
import { decideSessionGroupRepairAuthority } from "../../src/reconcile/sessionGroupRepairAuthority.js";

const projectIds: ProjectId[] = ["web", "api"];

function completeWorktrees(...ids: ProjectId[]): ProviderReadOutcome[] {
  return ids.map((projectId) => ({
    status: "complete",
    providerType: "worktree",
    providerId: "worktrunk",
    projectId,
  }));
}

const completeTerminalRead: ProviderReadOutcome = {
  status: "complete",
  providerType: "terminal",
  providerId: "tmux",
};
const completeHarnessRead: ProviderReadOutcome = {
  status: "complete",
  providerType: "harness",
  providerId: "codex",
};
const completeGlobalReads: ProviderReadOutcome[] = [completeTerminalRead, completeHarnessRead];

describe("decideSessionGroupRepairAuthority", () => {
  it("applies absence repair to every completely observed project", () => {
    expect(
      decideSessionGroupRepairAuthority({
        projectIds,
        providerReadOutcomes: [...completeWorktrees(...projectIds), ...completeGlobalReads],
      }),
    ).toEqual({
      status: "applied",
      absenceAuthorityProjectIds: ["web", "api"],
      preservedProjectIds: [],
      blockers: [],
    });
  });

  it("partially scopes repair across successful and failed worktree projects", () => {
    expect(
      decideSessionGroupRepairAuthority({
        projectIds,
        providerReadOutcomes: [
          ...completeWorktrees("web"),
          {
            status: "indeterminate",
            providerType: "worktree",
            providerId: "worktrunk",
            projectId: "api",
            failureCode: "PROVIDER_TIMEOUT",
          },
          ...completeGlobalReads,
        ],
      }),
    ).toEqual({
      status: "partially_scoped",
      absenceAuthorityProjectIds: ["web"],
      preservedProjectIds: ["api"],
      blockers: [
        {
          scope: "project",
          providerType: "worktree",
          providerId: "worktrunk",
          projectId: "api",
          code: "PROVIDER_TIMEOUT",
        },
      ],
    });
  });

  it("skips absence repair globally after a terminal read failure", () => {
    expect(
      decideSessionGroupRepairAuthority({
        projectIds,
        providerReadOutcomes: [
          ...completeWorktrees(...projectIds),
          {
            status: "indeterminate",
            providerType: "terminal",
            providerId: "tmux",
            failureCode: "PROVIDER_TIMEOUT",
          },
          completeHarnessRead,
        ],
      }),
    ).toEqual({
      status: "skipped",
      absenceAuthorityProjectIds: [],
      preservedProjectIds: projectIds,
      blockers: [
        {
          scope: "global",
          providerType: "terminal",
          providerId: "tmux",
          code: "PROVIDER_TIMEOUT",
        },
      ],
    });
  });

  it("skips absence repair globally after a harness discovery failure", () => {
    expect(
      decideSessionGroupRepairAuthority({
        projectIds,
        providerReadOutcomes: [
          ...completeWorktrees(...projectIds),
          completeTerminalRead,
          {
            status: "indeterminate",
            providerType: "harness",
            providerId: "codex",
            failureCode: "HARNESS_DISCOVER_FAILED",
          },
        ],
      }),
    ).toEqual({
      status: "skipped",
      absenceAuthorityProjectIds: [],
      preservedProjectIds: projectIds,
      blockers: [
        {
          scope: "global",
          providerType: "harness",
          providerId: "codex",
          code: "HARNESS_DISCOVER_FAILED",
        },
      ],
    });
  });

  it("skips absence repair when every worktree project is indeterminate", () => {
    expect(
      decideSessionGroupRepairAuthority({
        projectIds,
        providerReadOutcomes: [
          ...projectIds.map(
            (projectId): ProviderReadOutcome => ({
              status: "indeterminate",
              providerType: "worktree",
              providerId: "worktrunk",
              projectId,
              failureCode: "WORKTREE_LIST_FAILED",
            }),
          ),
          ...completeGlobalReads,
        ],
      }),
    ).toEqual({
      status: "skipped",
      absenceAuthorityProjectIds: [],
      preservedProjectIds: projectIds,
      blockers: projectIds.map((projectId) => ({
        scope: "project",
        providerType: "worktree",
        providerId: "worktrunk",
        projectId,
        code: "WORKTREE_LIST_FAILED",
      })),
    });
  });

  it("never grants authority to an unconfigured project", () => {
    expect(
      decideSessionGroupRepairAuthority({
        projectIds: ["web"],
        providerReadOutcomes: [...completeWorktrees("web", "removed"), ...completeGlobalReads],
      }),
    ).toEqual({
      status: "applied",
      absenceAuthorityProjectIds: ["web"],
      preservedProjectIds: [],
      blockers: [],
    });
  });
});
