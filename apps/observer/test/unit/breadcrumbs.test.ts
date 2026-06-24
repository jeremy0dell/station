import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "@station/config";
import { describe, expect, it } from "vitest";
import {
  parseRecoveryBreadcrumbJson,
  type RecoveryBreadcrumb,
  RecoveryBreadcrumbError,
  readRecoveryBreadcrumbFile,
  writeRecoveryBreadcrumb,
} from "../../src/hooks/breadcrumbs";

const now = "2026-05-20T12:00:00.000Z";

const breadcrumb: RecoveryBreadcrumb = {
  schemaVersion: 1,
  projectId: "web",
  worktreeId: "wt_web_main",
  sessionId: "ses_web_main",
  createdBy: "station",
  createdAt: now,
};

const project = (root: string, recoveryBreadcrumbs?: ProjectConfig["recoveryBreadcrumbs"]) =>
  ({
    id: "web",
    label: "web",
    root,
    defaults: {
      harness: "codex",
      terminal: "tmux",
      layout: "agent-shell",
    },
    worktrunk: {
      enabled: true,
    },
    ...(recoveryBreadcrumbs === undefined ? {} : { recoveryBreadcrumbs }),
  }) satisfies ProjectConfig;

describe("recovery breadcrumbs", () => {
  it("writes and reads external parse-only marker hints", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "station-breadcrumbs-"));

    const written = await writeRecoveryBreadcrumb({
      stateDir: tempDir,
      breadcrumb,
    });
    const parsed = await readRecoveryBreadcrumbFile(written.path);

    expect(written.location).toBe("external");
    expect(written.path).toContain(join(tempDir, "markers"));
    expect(parsed).toEqual({
      breadcrumb,
      authoritative: false,
    });
    expect(await readFile(written.path, "utf8")).toContain('"schemaVersion": 1');
  });

  it("blocks in-worktree markers unless the global project config opts in", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "station-breadcrumbs-"));
    const worktreePath = join(tempDir, "web-main");

    await expect(
      writeRecoveryBreadcrumb({
        stateDir: tempDir,
        location: "worktree",
        worktreePath,
        project: project(worktreePath),
        breadcrumb,
      }),
    ).rejects.toMatchObject({
      tag: "RecoveryBreadcrumbError",
      code: "RECOVERY_BREADCRUMB_WORKTREE_NOT_OPTED_IN",
    });
  });

  it("allows in-worktree markers with explicit project opt-in", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "station-breadcrumbs-"));
    const worktreePath = join(tempDir, "web-main");

    const written = await writeRecoveryBreadcrumb({
      stateDir: tempDir,
      location: "worktree",
      worktreePath,
      project: project(worktreePath, {
        location: "worktree",
        path: ".station/recovery.json",
      }),
      breadcrumb,
    });

    expect(written).toMatchObject({
      location: "worktree",
      path: join(worktreePath, ".station/recovery.json"),
      authoritative: false,
    });
  });

  it("rejects shell-like or unsafe marker content", () => {
    expect(() => parseRecoveryBreadcrumbJson("export SESSION=ses_web_main\n")).toThrow(
      RecoveryBreadcrumbError,
    );
    expect(() =>
      parseRecoveryBreadcrumbJson(
        JSON.stringify({
          ...breadcrumb,
          prompt: "do secret work",
        }),
      ),
    ).toThrow(RecoveryBreadcrumbError);
  });

  it("rejects unsupported fields, invalid timestamps, and empty optional fields", () => {
    expect(() =>
      parseRecoveryBreadcrumbJson(
        JSON.stringify({
          ...breadcrumb,
          extra: true,
        }),
      ),
    ).toThrow(RecoveryBreadcrumbError);

    expect(() =>
      parseRecoveryBreadcrumbJson(
        JSON.stringify({
          ...breadcrumb,
          createdAt: "2026-05-20",
        }),
      ),
    ).toThrow(RecoveryBreadcrumbError);

    expect(() =>
      parseRecoveryBreadcrumbJson(
        JSON.stringify({
          ...breadcrumb,
          worktreeId: "",
        }),
      ),
    ).toThrow(RecoveryBreadcrumbError);
  });

  it("accepts minimal and full valid breadcrumb payloads", () => {
    expect(
      parseRecoveryBreadcrumbJson(
        JSON.stringify({
          schemaVersion: 1,
          projectId: "web",
          createdBy: "station",
          createdAt: now,
        }),
      ),
    ).toEqual({
      breadcrumb: {
        schemaVersion: 1,
        projectId: "web",
        createdBy: "station",
        createdAt: now,
      },
      authoritative: false,
    });

    expect(
      parseRecoveryBreadcrumbJson(
        JSON.stringify({
          ...breadcrumb,
          provider: "worktrunk",
          note: "created by lifecycle hook",
        }),
      ).breadcrumb,
    ).toMatchObject({
      worktreeId: "wt_web_main",
      sessionId: "ses_web_main",
      provider: "worktrunk",
      note: "created by lifecycle hook",
    });
  });
});
