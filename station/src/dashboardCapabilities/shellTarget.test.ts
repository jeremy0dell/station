import { describe, expect, it } from "bun:test";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import { resolveDashboardShellTarget } from "./shellTarget.js";

describe("dashboard shell target resolution", () => {
  it("resolves project and session identities from canonical client state", () => {
    const snapshot = manyProjectsSnapshot();
    const source = new FakeStationSource(snapshot);
    const project = snapshot.projects.find((candidate) => candidate.id === "station");
    const session = snapshot.sessions.find((candidate) => candidate.id === "ses_wt_station_idle");
    const worktree = snapshot.rows.find((candidate) => candidate.id === session?.worktreeId);
    if (project === undefined || session === undefined || worktree === undefined) {
      throw new Error("shell target fixture is incomplete");
    }

    expect(resolveDashboardShellTarget(source, { kind: "project", projectId: project.id })).toEqual(
      { kind: "project", project },
    );
    expect(resolveDashboardShellTarget(source, { kind: "session", sessionId: session.id })).toEqual(
      { kind: "session", worktree },
    );
  });

  it("keeps stale semantic identities inert", () => {
    const source = new FakeStationSource(manyProjectsSnapshot());

    expect(
      resolveDashboardShellTarget(source, { kind: "project", projectId: "missing" }),
    ).toBeUndefined();
    expect(
      resolveDashboardShellTarget(source, { kind: "session", sessionId: "missing" }),
    ).toBeUndefined();
  });
});
