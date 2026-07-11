import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@station/config";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
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
});

async function createFixture() {
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
  registerObserverCommandHandlers({
    queue,
    core,
    providers,
    projects: [],
    getProjects: () => core.getProjects(),
    persistence,
    eventBus,
    clock,
    configPath,
    homeDir: root,
  });
  return { root, configPath, sqlite, persistence, queue, core };
}

async function makeRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(join(repo, ".git"), { recursive: true });
  return repo;
}

function configToml(): string {
  return `
schema_version = 1
projects = []

[defaults]
worktree_provider = "fake-worktree"
terminal = "fake-terminal"
harness = "fake-harness"
layout = "agent-shell"
`;
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
