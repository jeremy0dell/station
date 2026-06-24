import type { ProviderProjectConfig, WorktreeObservation } from "@station/contracts";
import {
  applyRecoveryBreadcrumbMetadata,
  metadataFromObservation,
  providerNativeMetadataFromWorktrunkItem,
} from "@station/worktrunk";
import { describe, expect, it } from "vitest";

const observedAt = "2026-05-21T12:00:00.000Z";

describe("Worktrunk recovery breadcrumb metadata", () => {
  it("ignores malformed and invalid breadcrumb files", async () => {
    await expect(apply("{ not-json")).resolves.toEqual(observation);
    await expect(
      apply(JSON.stringify({ schemaVersion: 1, createdBy: "station" })),
    ).resolves.toEqual(observation);
    await expect(
      apply(JSON.stringify({ ...validBreadcrumb(), unsupported: true })),
    ).resolves.toEqual(observation);
    await expect(
      apply(JSON.stringify({ ...validBreadcrumb(), projectId: "api" })),
    ).resolves.toEqual(observation);
  });

  it("applies valid breadcrumb metadata that matches the project", async () => {
    const result = await apply(
      JSON.stringify({
        ...validBreadcrumb(),
        worktreeId: "wt_web_feature",
        sessionId: "ses_web_feature",
      }),
    );

    expect(result).toMatchObject({
      id: "wt_web_feature",
      providerData: {
        metadata: {
          source: "worktree-breadcrumb",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
        },
      },
    });
  });

  it("parses providerData metadata through the worktrunk-local schema", () => {
    expect(
      metadataFromObservation({
        ...observation,
        providerData: {
          metadata: {
            source: "provider-native",
            projectId: "web",
            worktreeId: "wt_web_feature",
          },
        },
      }),
    ).toEqual({
      source: "provider-native",
      projectId: "web",
      worktreeId: "wt_web_feature",
    });

    expect(
      metadataFromObservation({
        ...observation,
        providerData: {
          metadata: {
            source: "provider-native",
            projectId: "",
          },
        },
      }),
    ).toBeUndefined();
  });

  it("normalizes provider-native metadata from worktrunk vars", () => {
    expect(
      providerNativeMetadataFromWorktrunkItem({
        vars: {
          station: {
            project_id: "web",
            worktree_id: "wt_web_feature",
            session_id: "ses_web_feature",
          },
        },
      }),
    ).toEqual({
      source: "provider-native",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
    });
  });
});

const project: ProviderProjectConfig = {
  id: "web",
  label: "Web",
  root: "/repo/web",
  defaults: {
    harness: "codex",
    terminal: "tmux",
    layout: "agent-shell",
  },
  worktrunk: {
    enabled: true,
  },
  recoveryBreadcrumbs: {
    location: "worktree",
  },
};

const observation: WorktreeObservation = {
  id: "wt_web_main",
  provider: "worktrunk",
  projectId: "web",
  branch: "main",
  path: "/repo/web-main",
  state: "exists",
  source: "worktrunk",
  observedAt,
};

function validBreadcrumb() {
  return {
    schemaVersion: 1,
    projectId: "web",
    createdBy: "station",
    createdAt: observedAt,
  };
}

async function apply(source: string): Promise<WorktreeObservation> {
  return applyRecoveryBreadcrumbMetadata(observation, project, {
    readTextFile: async () => source,
  });
}
