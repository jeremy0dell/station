import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigFromToml, type StationConfig } from "@station/config";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import type { ProjectConfigWriter } from "../../src/commands/projectConfigWriter.js";
import {
  createCommandQueue,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
} from "../../src/internal";
import type { ObserverCore } from "../../src/reconcile/core.js";
import { createProjectConfigWriter } from "../../src/runtime/projectConfigWriter.js";

const now = "2026-05-20T12:00:00.000Z";

describe("observer project commands", () => {
  it("adds a project through config mutation and reconciles it into the snapshot", async () => {
    const fixture = await createFixture();
    const repo = await makeRepo(fixture.root, "web");

    const receipt = await fixture.queue.dispatch({
      type: "project.add",
      payload: { path: repo },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      loadConfig({ configPath: fixture.configPath, homeDir: fixture.root }),
    ).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: "web", root: repo })],
    });
    expect(fixture.core.getSnapshot()).toMatchObject({
      counts: { projects: 1 },
      projects: [expect.objectContaining({ id: "web", label: "web" })],
    });

    fixture.sqlite.close();
  });

  it("removes a project through config mutation and reconciles the snapshot", async () => {
    const fixture = await createFixture();
    const repo = await makeRepo(fixture.root, "web");
    await fixture.queue.dispatch({ type: "project.add", payload: { path: repo } });
    await fixture.queue.drain();

    const receipt = await fixture.queue.dispatch({
      type: "project.remove",
      payload: { projectId: "web" },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(readFile(fixture.configPath, "utf8")).resolves.toContain("projects = []");
    expect(fixture.core.getSnapshot()).toMatchObject({
      counts: { projects: 0 },
      projects: [],
    });

    fixture.sqlite.close();
  });

  it("sets a project default harness through config mutation and reconciles the snapshot", async () => {
    const fixture = await createFixture();
    const repo = await makeRepo(fixture.root, "web");
    await fixture.queue.dispatch({ type: "project.add", payload: { path: repo } });
    await fixture.queue.drain();

    const receipt = await fixture.queue.dispatch({
      type: "project.setDefaultHarness",
      payload: { projectId: "web", harness: "other-harness" },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      loadConfig({ configPath: fixture.configPath, homeDir: fixture.root }),
    ).resolves.toMatchObject({
      projects: [
        expect.objectContaining({
          defaults: expect.objectContaining({ harness: "other-harness" }),
        }),
      ],
    });
    expect(fixture.core.getSnapshot()).toMatchObject({
      projects: [
        expect.objectContaining({
          defaults: expect.objectContaining({ harness: "other-harness" }),
        }),
      ],
    });

    fixture.sqlite.close();
  });

  it("records safe command failures for invalid project additions", async () => {
    const fixture = await createFixture();
    const folder = join(fixture.root, "not-git");
    await mkdir(folder, { recursive: true });

    const receipt = await fixture.queue.dispatch({
      type: "project.add",
      payload: { path: folder },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "ProjectConfigError",
        code: "PROJECT_ROOT_NOT_GIT",
        message: "Selected folder is not inside a git repository.",
      },
    });
    const events = await fixture.persistence.listEvents({ commandId: receipt.commandId });
    expect(events.at(-1)).toMatchObject({
      type: "command.failed",
      event: {
        error: {
          tag: "ProjectConfigError",
          code: "PROJECT_ROOT_NOT_GIT",
        },
      },
    });

    fixture.sqlite.close();
  });

  it("passes the exact validated payload through a substitute writer before reconcile", async () => {
    const received: unknown[] = [];
    const fixture = await createFixture({
      instrumentCore: true,
      createWriter: async ({ root, configPath, calls }) => {
        const repo = await makeRepo(root, "substituted");
        const nextConfig = (
          await loadConfigFromToml(configToml(repo), { configPath, homeDir: root })
        ).config;
        return {
          async addProject(payload) {
            calls.push("writer");
            received.push(payload);
            return nextConfig;
          },
          removeProject: unexpectedMutation,
          setDefaultHarness: unexpectedMutation,
        };
      },
    });

    await fixture.queue.dispatch({
      type: "project.add",
      payload: { path: "/selected/path", label: "Selected" },
    });
    await fixture.queue.drain();

    expect(received).toEqual([{ path: "/selected/path", label: "Selected" }]);
    expect(fixture.calls).toEqual(["writer", "updateConfig", "reconcile"]);
    expect(fixture.core.getSnapshot().projects).toEqual([
      expect.objectContaining({ id: "substituted", label: "substituted" }),
    ]);
    fixture.sqlite.close();
  });

  it("does not update core or reconcile when the writer fails", async () => {
    const fixture = await createFixture({
      instrumentCore: true,
      createWriter: async () => ({
        async addProject() {
          throw Object.assign(new Error("Project write failed."), {
            name: "ProjectConfigError",
            tag: "ProjectConfigError" as const,
            code: "PROJECT_WRITE_FAILED",
          });
        },
        removeProject: unexpectedMutation,
        setDefaultHarness: unexpectedMutation,
      }),
    });

    const receipt = await fixture.queue.dispatch({
      type: "project.add",
      payload: { path: "/selected/path" },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { tag: "ProjectConfigError", code: "PROJECT_WRITE_FAILED" },
    });
    expect(fixture.calls).toEqual([]);
    expect(fixture.core.getSnapshot().projects).toEqual([]);
    fixture.sqlite.close();
  });

  it("still updates core and reconciles when the real writer reports an unchanged add", async () => {
    const fixture = await createFixture({ instrumentCore: true });
    const repo = await makeRepo(fixture.root, "unchanged");
    await fixture.queue.dispatch({ type: "project.add", payload: { path: repo } });
    await fixture.queue.drain();
    fixture.calls.length = 0;

    await fixture.queue.dispatch({ type: "project.add", payload: { path: repo } });
    await fixture.queue.drain();

    expect(fixture.calls).toEqual(["updateConfig", "reconcile"]);
    expect(fixture.core.getSnapshot().projects).toHaveLength(1);
    fixture.sqlite.close();
  });

  it("resolves the default config path from the home captured by the real adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-observer-project-home-"));
    const configPath = join(root, ".config", "station", "config.toml");
    await mkdir(join(root, ".config", "station"), { recursive: true });
    await writeFile(configPath, configToml(), "utf8");
    const repo = await makeRepo(root, "home-project");
    const writer = createProjectConfigWriter({ homeDir: root });

    const config = await writer.addProject({ path: repo });

    expect(config.projects).toEqual([expect.objectContaining({ id: "home-project", root: repo })]);
    await expect(readFile(configPath, "utf8")).resolves.toContain('id = "home-project"');
  });

  it("preserves project-local harness overrides and the authoritative config on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-observer-project-local-"));
    const repo = await makeRepo(root, "local-project");
    await mkdir(join(repo, ".station"), { recursive: true });
    await writeFile(
      join(repo, ".station", "config.toml"),
      'schema_version = 1\n\n[defaults]\nharness = "claude"\n',
      "utf8",
    );
    const configPath = join(root, "config.toml");
    await writeFile(configPath, configTomlWithLocalProject(repo), "utf8");
    const before = await readFile(configPath, "utf8");
    const writer = createProjectConfigWriter({ configPath, homeDir: root });

    await expect(
      writer.setDefaultHarness({ projectId: "local-project", harness: "opencode" }),
    ).rejects.toMatchObject({
      tag: "ProjectConfigError",
      code: "PROJECT_DEFAULT_HARNESS_OVERRIDDEN",
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe(before);
  });
});

type FixtureOptions = {
  instrumentCore?: boolean;
  createWriter?: (input: {
    root: string;
    configPath: string;
    config: StationConfig;
    calls: string[];
  }) => Promise<ProjectConfigWriter>;
};

async function createFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "station-observer-project-"));
  const configPath = join(root, "config.toml");
  await writeFile(configPath, configToml(), "utf8");
  const config = (await loadConfig({ configPath, homeDir: root })).config;
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const ids = observerIds();
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus });
  const providers = new ProviderRegistry({
    worktree: new FakeWorktreeProvider({ now }),
    terminal: new FakeTerminalProvider({ now }),
    harnesses: [new FakeHarnessProvider({ now })],
  });
  const core = createObserverCore({
    config,
    providers,
    persistence,
    clock,
  });
  const calls: string[] = [];
  const handlerCore: ObserverCore =
    options.instrumentCore === true
      ? {
          ...core,
          updateConfig(nextConfig) {
            calls.push("updateConfig");
            core.updateConfig(nextConfig);
          },
          async reconcile(reason) {
            calls.push("reconcile");
            return core.reconcile(reason);
          },
        }
      : core;
  const projectConfigWriter =
    (await options.createWriter?.({ root, configPath, config, calls })) ??
    createProjectConfigWriter({ configPath, homeDir: root });
  registerObserverCommandHandlers({
    queue,
    core: handlerCore,
    providers,
    projects: [],
    getProjects: () => handlerCore.getProjects(),
    persistence,
    eventBus,
    clock,
    projectConfigWriter,
  });
  return { root, configPath, sqlite, persistence, queue, core, calls };
}

async function makeRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(join(repo, ".git"), { recursive: true });
  return repo;
}

function configToml(projectRoot?: string): string {
  return `
schema_version = 1
${projectRoot === undefined ? "projects = []" : ""}

[defaults]
worktree_provider = "fake-worktree"
terminal = "fake-terminal"
harness = "fake-harness"
layout = "agent-shell"
${
  projectRoot === undefined
    ? ""
    : `
[[projects]]
id = "substituted"
label = "substituted"
root = "${projectRoot}"
`
}
`;
}

function configTomlWithLocalProject(projectRoot: string): string {
  return configToml().replace(
    "projects = []",
    `[[projects]]
id = "local-project"
label = "local-project"
root = "${projectRoot}"

[projects.local_config]
enabled = true
path = ".station/config.toml"`,
  );
}

async function unexpectedMutation(): Promise<never> {
  throw new Error("Unexpected project mutation.");
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
