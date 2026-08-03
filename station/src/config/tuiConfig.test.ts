import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  legacySearchExperience,
  persistentFilterExperience,
  type DashboardRuntime,
} from "@station/dashboard-core";
import { createStationDashboardRuntime } from "../station/store/dashboardRuntime.js";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { FakeStationSource } from "../station/test/support/fakeStationSource.js";
import { FakeTuiObserverService } from "../station/test/support/fakeObserverService.js";
import {
  createStationTestDashboardRuntime,
  makeStationTestRuntime,
} from "../station/test/support/makeStationTestRuntime.js";
import { createStation } from "../app/createStation.js";
import { NO_OP_CLIPBOARD_EFFECTS } from "../copy/testing.js";
import { createStationStore } from "../state/store.js";
import { loadStationTuiConfig, startWidgetConfigWrites } from "./tuiConfig.js";

describe("loadStationTuiConfig", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the legacy search experience when the STATION config is absent", async () => {
    await expect(loadStationTuiConfig({ path: "/definitely/not/here/config.toml" })).resolves.toEqual({
      composition: { dashboardSearchExperience: legacySearchExperience },
    });
  });

  it("loads [tui.widgets] from the normal STATION config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const projectRoot = join(dir, "project");
    await mkdir(projectRoot);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[[tui.widgets]]
type = "fleet"

[[tui.widgets]]
type = "prs"

[[projects]]
id = "web"
label = "web"
root = "${projectRoot}"

[projects.defaults]
harness = "codex"
terminal = "tmux"
layout = "agent-build-shell"

[projects.worktrunk]
enabled = true
`,
      "utf8",
    );

    await expect(loadStationTuiConfig({ env: { STATION_CONFIG_PATH: configPath } })).resolves.toEqual({
      config: {
        widgets: [{ type: "fleet" }, { type: "prs" }],
      },
      configPath,
      composition: { dashboardSearchExperience: legacySearchExperience },
    });
  });

  it("resolves the persistent search experience when enabled in TOML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const configPath = await writeWidgetTestConfig(dir, "dashboard_persistent_filter = true");

    const result = await loadStationTuiConfig({ path: configPath });

    expect(result.composition.dashboardSearchExperience).toBe(persistentFilterExperience);
  });

  it("surfaces a warning when [tui] is invalid and widgets fall back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const projectRoot = join(dir, "project");
    await mkdir(projectRoot);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[[tui.widgets]]
type = "weather"
label = "Missing city"

[[projects]]
id = "web"
label = "web"
root = "${projectRoot}"
`,
      "utf8",
    );

    const result = await loadStationTuiConfig({ path: configPath });

    expect(result.config).toBeUndefined();
    expect(result.composition.dashboardSearchExperience).toBe(legacySearchExperience);
    expect(result.warning).toContain("[tui]");
  });

  it("warns but does not reject when widget config cannot be loaded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, "schema_version = ", "utf8");

    const result = await loadStationTuiConfig({ path: configPath });

    expect(result.config).toBeUndefined();
    expect(result.composition.dashboardSearchExperience).toBe(legacySearchExperience);
    expect(result.warning).toContain("widgets disabled");
  });

  it("serializes widget writes and stops observing changes after disposal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const configPath = await writeWidgetTestConfig(dir);

    const { runtime: store } = makeStationTestRuntime({
      initialState: { widgets: [{ type: "time" }] },
    });
    const writes = startTestWidgetConfigWrites(store, configPath);
    addWidgetThroughSettings(store, 3);
    addWidgetThroughSettings(store, 1);
    addWidgetThroughSettings(store, 2);

    await writes.flush();
    await writes.dispose();
    store.actions.dispatch({ type: "widgetSettings.toggle", index: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const loadedAfterDispose = await loadStationTuiConfig({ path: configPath });
    expect(loadedAfterDispose.config?.widgets).toEqual([
      { type: "time" },
      { type: "moon" },
      { type: "fleet" },
      { type: "prs" },
    ]);
  });

  it("flushes the real standalone input flow before immediate exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const configPath = await writeWidgetTestConfig(dir);

    const source = new FakeStationSource(manyProjectsSnapshot());
    const service = new FakeTuiObserverService(manyProjectsSnapshot());
    let writes: ReturnType<typeof startWidgetConfigWrites> | undefined;
    let durableExit: Promise<void> | undefined;
    let exitCode: number | undefined;
    const store = createStationTestDashboardRuntime({
      source,
      service,
      initialState: { widgets: [{ type: "time" }], widgetsPersisted: true },
      onExit: (code) => {
        exitCode = code;
        if (writes === undefined) {
          throw new Error("widget writer was not attached before exit");
        }
        durableExit = writes.dispose();
      },
    });
    writes = startTestWidgetConfigWrites(store, configPath);

    store.actions.handleKey({ input: "W" });
    store.actions.handleKey({ input: " " });
    store.actions.handleKey({ input: "", escape: true });
    store.actions.handleKey({ input: "Q" });

    expect(exitCode).toBe(0);
    if (durableExit === undefined) {
      throw new Error("standalone exit did not wait for widget durability");
    }
    await durableExit;
    expect((await loadStationTuiConfig({ path: configPath })).config?.widgets).toEqual([
      { type: "time", enabled: false },
    ]);
  });

  it("flushes the native Station input flow before its shutdown callback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const configPath = await writeWidgetTestConfig(dir);
    const source = new FakeStationSource(manyProjectsSnapshot());
    let resolveShutdown: (() => void) | undefined;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const composition = createStation({
      store: createStationStore(),
      clipboardEffects: NO_OP_CLIPBOARD_EFFECTS,
      stationClient: {
        state: source,
        service: new FakeTuiObserverService(manyProjectsSnapshot()),
        start: () => source.start(),
        stop: () => source.stop(),
      },
      tuiConfig: { widgets: [{ type: "time" }] },
      tuiConfigPath: configPath,
      shutdown: () => resolveShutdown?.(),
    });
    composition.start();

    composition.dashboard.actions.handleKey({ input: "W" });
    composition.dashboard.actions.handleKey({ input: " " });
    composition.stationInput.handleSequence("\x11");

    await shutdown;
    expect((await loadStationTuiConfig({ path: configPath })).config?.widgets).toEqual([
      { type: "time", enabled: false },
    ]);
  });

  it("rebases independent additions and fails closed after a conflicting edit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-tui-config-"));
    dirs.push(dir);
    const configPath = await writeWidgetTestConfig(dir);

    const initialWidgets = [{ type: "time" }] as const;
    const nativeSource = new FakeStationSource(manyProjectsSnapshot());
    const nativeStore = createStationDashboardRuntime(
      {
        state: nativeSource,
        service: new FakeTuiObserverService(manyProjectsSnapshot()),
        start: () => nativeSource.start(),
        stop: () => nativeSource.stop(),
      },
      { widgets: initialWidgets, widgetsPersisted: true },
    );
    const popupSource = new FakeStationSource(manyProjectsSnapshot());
    const popupStore = createStationTestDashboardRuntime({
      source: popupSource,
      service: new FakeTuiObserverService(manyProjectsSnapshot()),
      initialState: { widgets: initialWidgets, widgetsPersisted: true },
      persistentPopup: true,
      onDismiss: async () => {},
    });
    const nativeWrites = startTestWidgetConfigWrites(nativeStore, configPath);
    const popupWrites = startTestWidgetConfigWrites(popupStore, configPath);

    addWidgetThroughSettings(nativeStore, 3);
    await nativeWrites.flush();
    addWidgetThroughSettings(popupStore, 1);
    await popupWrites.flush();

    expect((await loadStationTuiConfig({ path: configPath })).config?.widgets).toEqual([
      { type: "time" },
      { type: "moon" },
      { type: "fleet" },
    ]);

    nativeStore.actions.handleKey({ input: "", escape: true });
    nativeStore.actions.handleKey({ input: "W" });
    nativeStore.actions.handleKey({ input: " " });
    await nativeWrites.flush();
    addWidgetThroughSettings(popupStore, 2);
    await popupWrites.flush();

    expect((await loadStationTuiConfig({ path: configPath })).config?.widgets).toEqual([
      { type: "time", enabled: false },
      { type: "moon" },
      { type: "fleet" },
    ]);
    expect(popupStore.state.getState().toasts.at(-1)?.toast.message).toBe(
      "Could not save widgets to config.toml.",
    );
    await Promise.all([nativeWrites.dispose(), popupWrites.dispose()]);
  });

  it("keeps persistent-popup Q on the dismiss path instead of process exit", async () => {
    const source = new FakeStationSource(manyProjectsSnapshot());
    let dismisses = 0;
    let exits = 0;
    const store = createStationTestDashboardRuntime({
      source,
      service: new FakeTuiObserverService(manyProjectsSnapshot()),
      persistentPopup: true,
      onDismiss: async () => {
        dismisses += 1;
      },
      onExit: () => {
        exits += 1;
      },
    });

    store.actions.handleKey({ input: "Q" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dismisses).toBe(1);
    expect(exits).toBe(0);
  });
});

function startTestWidgetConfigWrites(
  runtime: DashboardRuntime,
  configPath: string,
): ReturnType<typeof startWidgetConfigWrites> {
  return startWidgetConfigWrites(runtime.state, runtime.actions.pushToast, configPath);
}

function addWidgetThroughSettings(
  store: DashboardRuntime,
  pickerIndex: number,
): void {
  store.actions.handleKey({ input: "W" });
  store.actions.handleKey({ input: "a" });
  for (let index = 0; index < pickerIndex; index += 1) {
    store.actions.handleKey({ input: "", downArrow: true });
  }
  store.actions.handleKey({ input: "\r", return: true });
}

async function writeWidgetTestConfig(
  dir: string,
  featureFlag?: string,
): Promise<string> {
  const projectRoot = join(dir, "project");
  await mkdir(projectRoot);
  const configPath = join(dir, "config.toml");
  await writeFile(
    configPath,
    `
schema_version = 1

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

${featureFlag === undefined ? "" : `[feature_flags]\n${featureFlag}\n`}
[[tui.widgets]]
type = "time"

[[projects]]
id = "web"
label = "web"
root = "${projectRoot}"
`,
    "utf8",
  );
  return configPath;
}
