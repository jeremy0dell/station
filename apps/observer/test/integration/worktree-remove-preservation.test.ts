import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StationConfig } from "@station/config";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { environmentWithoutGitLocals } from "@station/runtime";
import { FakeHarnessProvider, FakeTerminalProvider } from "@station/testing";
import { WorktrunkProvider } from "@station/worktrunk";
import { describe, expect, it } from "vitest";
import {
  createCommandQueue,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
} from "../../src/internal";
import { createUnexpectedProjectConfigWriter } from "../support/projectConfigWriter.js";

const execFileAsync = promisify(execFile);
const now = "2026-07-14T20:00:00.000Z";

describe("worktree removal preservation", () => {
  it("protects a same-path replacement and preserves it when Worktrunk later filters it", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-remove-preservation-"));
    const repo = join(root, "repo");
    const linked = join(root, "feature");
    const stateDir = join(root, "state");
    await mkdir(repo, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "station@example.invalid");
    await git(repo, "config", "user.name", "station");
    await writeFile(join(repo, "tracked.txt"), "base\n");
    await git(repo, "add", "tracked.txt");
    await git(repo, "commit", "-m", "initial");
    await git(repo, "branch", "feature");
    await git(repo, "worktree", "add", linked, "feature");

    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const ids = observerIds();
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
    const eventBus = createObserverEventBus();
    const warnings: Record<string, unknown>[] = [];
    const logger = {
      async info(): Promise<void> {},
      async warn(_message: string, attributes?: Record<string, unknown>): Promise<void> {
        warnings.push(attributes ?? {});
      },
      async error(): Promise<void> {},
    };
    const worktrunkCalls: string[][] = [];
    const worktree = new WorktrunkProvider({
      command: "wt",
      clock,
      runner: async (input) => {
        worktrunkCalls.push(input.args ?? []);
        const branch = await gitOutput(linked, "symbolic-ref", "--short", "HEAD");
        const dirty = (await gitOutput(linked, "status", "--porcelain=v1")).length > 0;
        return externalResult(
          input,
          JSON.stringify([
            {
              path: linked,
              branch,
              is_main: false,
              worktree: { modified: dirty ? 1 : 0 },
            },
          ]),
        );
      },
    });
    const terminal = new FakeTerminalProvider({ now });
    const harness = new FakeHarnessProvider({ now });
    const providers = new ProviderRegistry({ worktree, terminal, harnesses: [harness] });
    const config = configFor(repo, stateDir);
    const core = createObserverCore({ config, providers, persistence, clock, logger });
    const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus, logger });
    registerObserverCommandHandlers({
      projectConfigWriter: createUnexpectedProjectConfigWriter(),
      queue,
      core,
      providers,
      projects: config.projects,
      persistence,
      eventBus,
      clock,
      logger,
    });

    try {
      await core.reconcile("capture-feature-selection");
      const selected = core.getSnapshot().rows.find((row) => row.branch === "feature");
      expect(selected).toMatchObject({
        branch: "feature",
        path: linked,
        registrationIdentity: expect.stringMatching(/^git-registration:/),
      });
      if (selected === undefined) throw new Error("Expected the feature worktree row.");
      if (selected.registrationIdentity === undefined) {
        throw new Error("Expected the feature worktree registration identity.");
      }

      await git(repo, "worktree", "remove", "--force", linked);
      await git(repo, "worktree", "add", linked, "feature");
      const replacementReceipt = await queue.dispatch({
        type: "worktree.remove",
        payload: {
          projectId: "web",
          worktreeId: selected.id,
          expectedPath: selected.path,
          expectedBranch: selected.branch,
          expectedRegistrationIdentity: selected.registrationIdentity,
          force: true,
        },
      });
      await queue.drain();

      await expect(persistence.getCommand(replacementReceipt.commandId)).resolves.toMatchObject({
        status: "failed",
        error: { code: "WORKTREE_REMOVE_STALE_SELECTION", worktreeId: selected.id },
        diagnostics: [
          expect.objectContaining({
            type: "worktree_removal_refusal",
            worktreeId: selected.id,
            canonicalPath: linked,
            observedBranch: "feature",
            refusalReason: "registration_changed",
          }),
        ],
      });
      expect(worktrunkCalls.filter((args) => args.includes("remove"))).toEqual([]);
      await expect(access(linked)).resolves.toBeUndefined();

      await core.reconcile("capture-replacement-selection");
      const replacement = core.getSnapshot().rows.find((row) => row.branch === "feature");
      if (replacement?.registrationIdentity === undefined) {
        throw new Error("Expected the replacement worktree registration identity.");
      }
      expect(replacement.registrationIdentity).not.toBe(selected.registrationIdentity);

      await git(repo, "switch", "--detach");
      await git(linked, "switch", "main");
      await writeFile(join(linked, "tracked.txt"), "dirty\n");
      await writeFile(join(linked, "staged.txt"), "staged\n");
      await git(linked, "add", "staged.txt");
      await writeFile(join(linked, "untracked.txt"), "untracked\n");

      const statusBefore = await gitOutput(linked, "status", "--porcelain=v1");
      const indexBefore = await gitOutput(linked, "write-tree");
      const registrationBefore = await gitOutput(repo, "worktree", "list", "--porcelain");
      const mainBefore = await gitOutput(repo, "rev-parse", "refs/heads/main");

      const receipt = await queue.dispatch({
        type: "worktree.remove",
        payload: {
          projectId: "web",
          worktreeId: replacement.id,
          expectedPath: replacement.path,
          expectedBranch: replacement.branch,
          expectedRegistrationIdentity: replacement.registrationIdentity,
          force: true,
        },
      });
      await queue.drain();

      await expect(persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
        status: "failed",
        error: {
          code: "WORKTREE_REMOVE_STALE_SELECTION",
          worktreeId: replacement.id,
        },
      });
      expect(worktrunkCalls.filter((args) => args.includes("remove"))).toEqual([]);
      expect(terminal.snapshot().closed).toEqual([]);
      expect(harness.snapshot().stopped).toEqual([]);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          commandId: receipt.commandId,
          worktreeId: replacement.id,
          canonicalPath: linked,
          observedBranch: "feature",
          refusalReason: "missing_target",
        }),
      );

      await expect(access(linked)).resolves.toBeUndefined();
      await expect(gitOutput(linked, "status", "--porcelain=v1")).resolves.toBe(statusBefore);
      await expect(gitOutput(linked, "write-tree")).resolves.toBe(indexBefore);
      await expect(gitOutput(repo, "worktree", "list", "--porcelain")).resolves.toBe(
        registrationBefore,
      );
      await expect(gitOutput(repo, "rev-parse", "refs/heads/main")).resolves.toBe(mainBefore);
      await expect(readFile(join(linked, "tracked.txt"), "utf8")).resolves.toBe("dirty\n");
      await expect(readFile(join(linked, "staged.txt"), "utf8")).resolves.toBe("staged\n");
      await expect(readFile(join(linked, "untracked.txt"), "utf8")).resolves.toBe("untracked\n");
    } finally {
      await queue.shutdown();
      await git(repo, "worktree", "remove", "--force", linked).catch(() => undefined);
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records correlated refusal evidence when registration changes at final adapter validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-remove-final-race-"));
    const repo = join(root, "repo");
    const linked = join(root, "feature");
    const stateDir = join(root, "state");
    await mkdir(repo, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const ids = observerIds();
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
    const eventBus = createObserverEventBus();
    const warnings: Record<string, unknown>[] = [];
    const logger = {
      async info(): Promise<void> {},
      async warn(_message: string, attributes?: Record<string, unknown>): Promise<void> {
        warnings.push(attributes ?? {});
      },
      async error(): Promise<void> {},
    };
    const worktrunkCalls: string[][] = [];
    let finalRaceArmed = false;
    let armedIdentityReads = 0;
    const worktree = new WorktrunkProvider({
      command: "wt",
      clock,
      resolveRegistrationIdentity: async () => {
        if (!finalRaceArmed) return "git-registration:original";
        armedIdentityReads += 1;
        return armedIdentityReads === 1
          ? "git-registration:original"
          : "git-registration:replacement";
      },
      runner: async (input) => {
        worktrunkCalls.push(input.args ?? []);
        return externalResult(input, JSON.stringify([{ path: linked, branch: "feature" }]));
      },
    });
    const terminal = new FakeTerminalProvider({ now });
    const harness = new FakeHarnessProvider({ now });
    const providers = new ProviderRegistry({ worktree, terminal, harnesses: [harness] });
    const config = configFor(repo, stateDir);
    const core = createObserverCore({ config, providers, persistence, clock, logger });
    const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus, logger });
    registerObserverCommandHandlers({
      projectConfigWriter: createUnexpectedProjectConfigWriter(),
      queue,
      core,
      providers,
      projects: config.projects,
      persistence,
      eventBus,
      clock,
      logger,
    });

    try {
      await core.reconcile("capture-original-registration");
      const selected = core.getSnapshot().rows[0];
      expect(selected).toMatchObject({
        branch: "feature",
        path: linked,
        registrationIdentity: "git-registration:original",
      });
      if (selected?.registrationIdentity === undefined) {
        throw new Error("Expected the original worktree registration identity.");
      }
      finalRaceArmed = true;

      const receipt = await queue.dispatch({
        type: "worktree.remove",
        payload: {
          projectId: "web",
          worktreeId: selected.id,
          expectedPath: selected.path,
          expectedBranch: selected.branch,
          expectedRegistrationIdentity: selected.registrationIdentity,
          force: true,
        },
      });
      await queue.drain();

      await expect(persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
        status: "failed",
        error: { code: "WORKTRUNK_WORKTREE_CHANGED" },
        diagnostics: [
          expect.objectContaining({
            type: "worktree_removal_refusal",
            provider: "worktrunk",
            projectId: "web",
            worktreeId: selected.id,
            canonicalPath: linked,
            observedBranch: "feature",
            refusalReason: "registration_changed",
          }),
        ],
      });
      expect(worktrunkCalls.filter((args) => args.includes("remove"))).toEqual([]);
      expect(terminal.snapshot().closed).toEqual([]);
      expect(harness.snapshot().stopped).toEqual([]);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          commandId: receipt.commandId,
          traceId: expect.any(String),
          provider: "worktrunk",
          projectId: "web",
          worktreeId: selected.id,
          canonicalPath: linked,
          observedBranch: "feature",
          refusalReason: "registration_changed",
        }),
      );
    } finally {
      await queue.shutdown();
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function configFor(repo: string, stateDir: string): StationConfig {
  return {
    schemaVersion: 1,
    observer: { stateDir },
    defaults: {
      worktreeProvider: "worktrunk",
      terminal: "fake-terminal",
      harness: "fake-harness",
      layout: "agent-shell",
      defaultBranch: "main",
    },
    projects: [
      {
        id: "web",
        label: "web",
        root: repo,
        defaultBranch: "main",
        defaults: {
          harness: "fake-harness",
          terminal: "fake-terminal",
          layout: "agent-shell",
        },
        worktrunk: { enabled: true, base: "main", includeMain: false },
      },
    ],
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: environmentWithoutGitLocals() });
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return (
    await execFileAsync("git", args, { cwd, env: environmentWithoutGitLocals() })
  ).stdout.trim();
}

function externalResult(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}

function observerIds() {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    errorId: () => `err_${++error}`,
    observationId: () => `obs_${++observation}`,
    breadcrumbId: () => `crumb_${++breadcrumb}`,
  };
}
