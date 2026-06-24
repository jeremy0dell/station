import { readFile } from "node:fs/promises";
import { parseWorktrunkListJson, WorktrunkProviderError } from "@station/worktrunk";
import { describe, expect, it } from "vitest";

const now = "2026-05-21T12:00:00.000Z";
const project = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: {
    harness: "codex",
    terminal: "tmux",
    layout: "agent-shell",
  },
  worktrunk: {
    enabled: true,
    base: "main",
  },
};

describe("Worktrunk list parser", () => {
  it("normalizes Worktrunk JSON into provider-neutral observations", async () => {
    const source = await fixture("list.json");

    const observations = parseWorktrunkListJson(source, {
      project,
      observedAt: now,
    });

    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      id: "wt_provider_feature_auth",
      provider: "worktrunk",
      projectId: "web",
      branch: "feature/auth",
      path: "/tmp/station/web/feature-auth",
      state: "exists",
      source: "worktrunk",
      dirty: true,
      ahead: 2,
      behind: 1,
      confidence: "high",
      observedAt: now,
      providerData: {
        metadata: {
          source: "provider-native",
          projectId: "web",
          worktreeId: "wt_provider_feature_auth",
        },
      },
    });
    expect(observations[1]?.branch).toBe("detached:abc1234");
    expect(observations[1]?.dirty).toBe(false);
  });

  it("surfaces repo identity and HEAD sha, skipping rows without a full sha or repo", async () => {
    const source = await fixture("list.json");

    const observations = parseWorktrunkListJson(source, { project, observedAt: now });

    expect(observations[0]?.remote).toEqual({
      host: "github.com",
      owner: "example",
      repo: "web",
      url: "https://github.com/example/web",
    });
    expect(observations[0]?.headSha).toBe("cb7f4d35eaa8e63255250cb61412ce160d0e8604");
    expect(observations[1]?.remote).toBeUndefined();
    expect(observations[1]?.headSha).toBeUndefined();
  });

  it("uses modern working_tree diff as dirty evidence without creating branch summaries", () => {
    const observations = parseWorktrunkListJson(
      JSON.stringify([
        {
          branch: "feature/modern-status",
          path: "/tmp/station/web/feature-modern-status",
          working_tree: {
            diff: {
              added: 6,
              deleted: 2,
            },
          },
        },
      ]),
      {
        project,
        observedAt: now,
      },
    );

    expect(observations[0]).toMatchObject({
      branch: "feature/modern-status",
      dirty: true,
      providerData: {
        worktrunk: {
          workingTreeDiff: {
            added: 6,
            deleted: 2,
          },
        },
      },
    });
    expect(observations[0]).not.toHaveProperty("changeSummary");
  });

  it("rejects invalid structured output with a typed provider error", async () => {
    const source = await fixture("invalid-list.json");

    expect(() =>
      parseWorktrunkListJson(source, {
        project,
        observedAt: now,
      }),
    ).toThrow(WorktrunkProviderError);
  });

  it("keeps detached worktree IDs unique when path display labels collide", () => {
    const observations = parseWorktrunkListJson(
      JSON.stringify([
        {
          branch: null,
          path: "/Users/example/.codex/worktrees/408d/station",
          commit: {
            sha: "9dd15ba750ce5308f9173f33388d1789be102afb",
            short_sha: "9dd15ba",
          },
          worktree: {
            detached: true,
          },
        },
        {
          branch: null,
          path: "/Users/example/.codex/worktrees/ee4f/station",
          commit: {
            sha: "9dd15ba750ce5308f9173f33388d1789be102afb",
            short_sha: "9dd15ba",
          },
          worktree: {
            detached: true,
          },
        },
      ]),
      {
        project,
        observedAt: now,
      },
    );

    expect(observations.map((observation) => observation.branch)).toEqual([
      "detached:9dd15ba",
      "detached:9dd15ba",
    ]);
    expect(new Set(observations.map((observation) => observation.id)).size).toBe(2);
    expect(observations.map((observation) => observation.id)).toEqual([
      expect.stringMatching(/^wt_web_station_[a-f0-9]{10}$/),
      expect.stringMatching(/^wt_web_station_[a-f0-9]{10}$/),
    ]);
  });

  it("keeps path-derived worktree IDs distinct when path labels differ", () => {
    const observations = parseWorktrunkListJson(
      JSON.stringify([
        { path: "/tmp/station/web/worktrees/feature-auth", branch: "feature/auth" },
        { path: "/tmp/station/web/worktrees/feature_auth", branch: "feature_auth" },
      ]),
      {
        project,
        observedAt: now,
      },
    );

    expect(new Set(observations.map((observation) => observation.id)).size).toBe(2);
    expect(observations.map((observation) => observation.id)).toEqual([
      expect.stringMatching(/^wt_web_feature-auth_[a-f0-9]{10}$/),
      expect.stringMatching(/^wt_web_feature_auth_[a-f0-9]{10}$/),
    ]);
  });

  it("keeps path-derived worktree IDs distinct when path labels collide", () => {
    const observations = parseWorktrunkListJson(
      JSON.stringify([
        { path: "/tmp/station/web/worktrees/alpha/feature", branch: "feature/alpha" },
        { path: "/tmp/station/web/worktrees/beta/feature", branch: "feature/beta" },
      ]),
      {
        project,
        observedAt: now,
      },
    );

    expect(new Set(observations.map((observation) => observation.id)).size).toBe(2);
    expect(observations.map((observation) => observation.id)).toEqual([
      expect.stringMatching(/^wt_web_feature_[a-f0-9]{10}$/),
      expect.stringMatching(/^wt_web_feature_[a-f0-9]{10}$/),
    ]);
  });

  it("keeps the same fallback worktree ID when a path checks out a new branch", () => {
    const before = parseWorktrunkListJson(
      JSON.stringify([
        {
          path: "/tmp/station/web/worktrees/original_title",
          branch: "original-title",
        },
      ]),
      {
        project,
        observedAt: now,
      },
    )[0];
    const after = parseWorktrunkListJson(
      JSON.stringify([
        {
          path: "/tmp/station/web/worktrees/original_title",
          branch: "agent-created-branch",
        },
      ]),
      {
        project,
        observedAt: now,
      },
    )[0];

    expect(after?.id).toBe(before?.id);
    expect(after).toMatchObject({
      id: expect.stringMatching(/^wt_web_original_title_[a-f0-9]{10}$/),
      branch: "agent-created-branch",
      path: "/tmp/station/web/worktrees/original_title",
    });
  });

  it("keeps hashed worktree IDs stable across macOS /var aliases", () => {
    const branch = "station/very-long-customer-account-permissions-rollout-for-enterprise-alpha";
    const varObservation = parseWorktrunkListJson(
      JSON.stringify([
        {
          path: "/var/folders/test/station/repo/.station-real-e2e/worktrees/feature",
          branch,
        },
      ]),
      {
        project,
        observedAt: now,
      },
    )[0];
    const privateVarObservation = parseWorktrunkListJson(
      JSON.stringify([
        {
          path: "/private/var/folders/test/station/repo/.station-real-e2e/worktrees/feature",
          branch,
        },
      ]),
      {
        project,
        observedAt: now,
      },
    )[0];

    expect(varObservation?.id).toBe(privateVarObservation?.id);
    expect(varObservation?.id).toMatch(/^wt_web_feature_[a-f0-9]{10}$/);
  });

  it("rejects non-JSON output with a typed provider error", () => {
    expect(() =>
      parseWorktrunkListJson("not-json", {
        project,
        observedAt: now,
      }),
    ).toThrow("Worktrunk list output is not valid JSON.");
  });
});

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}
