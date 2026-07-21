import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type { ProviderProjectConfig } from "@station/contracts";
import type { ExternalCommandInput } from "@station/runtime";
import { FakeHarnessProvider, FakeTerminalProvider } from "@station/testing";
import {
  installWorktrunkHooks,
  type WorktrunkHookExpectation,
  WorktrunkProvider,
} from "@station/worktrunk";
import { describe, expect, it } from "vitest";
import { ProviderRegistry, runDoctor } from "../../src/internal";
import { createTestObserverCore } from "../support/testObserver";

const now = "2026-05-21T12:00:00.000Z";

describe("Worktrunk diagnostics", () => {
  it("uses the requester hook launcher while retaining the incumbent fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-diag-requester-"));
    const stateDir = join(root, "state");
    const stationConfigPath = join(root, "config.toml");
    const worktrunkConfigPath = join(root, "worktrunk", "config.toml");
    const incumbentLauncher = "/checkout/A/bin/stn-ingress";
    const requesterLauncher = "/checkout/B/bin/stn-ingress";
    await mkdir(stateDir, { recursive: true });
    const hookExpectation: WorktrunkHookExpectation = {
      hookBin: incumbentLauncher,
      observerSocketPath: join(root, "run", "observer.sock"),
      stateDir,
      hookSpoolDir: join(stateDir, "spool", "hooks"),
      autoStartFromHooks: true,
      stationConfigPath,
    };
    await installWorktrunkHooks({
      expectation: { ...hookExpectation, hookBin: requesterLauncher },
      worktrunkConfigPath,
    });
    const clock = { now: () => new Date(now) };
    const stationConfig = config(stateDir);
    const providers = new ProviderRegistry({
      worktree: new WorktrunkProvider({
        command: "wt",
        configPath: worktrunkConfigPath,
        hookExpectation,
        clock,
        runner: async (input) => ({
          command: input.command,
          args: input.args ?? [],
          stdout: input.args?.includes("--version") ? "wt 0.68.0" : "--no-hooks --yes",
          stderr: "",
          exitCode: 0,
        }),
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config: stationConfig,
      providers,
      clock,
      sqlitePath: join(stateDir, "observer.sqlite"),
    });
    await core.reconcile("diagnostics");
    const deps = {
      config: stationConfig,
      configPath: stationConfigPath,
      core,
      persistence,
      persistenceHealth: persistence,
      providers,
      paths: { stateDir },
      clock,
    };

    const requesterReport = await runDoctor(deps, {
      providerHookIngressLauncher: requesterLauncher,
    });
    const incumbentReport = await runDoctor(deps);

    expect(requesterReport.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "worktrunk-hooks", status: "ok" })]),
    );
    expect(incumbentReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "worktrunk-hooks", status: "warn" }),
      ]),
    );
    sqlite.close();
  });

  it("reports provider failures and missing hook setup in doctor data", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-wt-diag-"));
    const clock = { now: () => new Date(now) };
    const providers = new ProviderRegistry({
      worktree: new WorktrunkProvider({
        command: "missing-wt",
        clock,
        runner: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config: config(stateDir),
      providers,
      clock,
      sqlitePath: join(stateDir, "observer.sqlite"),
    });

    await core.reconcile("diagnostics");
    const report = await runDoctor({
      config: config(stateDir),
      core,
      persistence,
      persistenceHealth: persistence,
      providers,
      paths: { stateDir },
      clock,
    });

    expect(report.status).toBe("degraded");
    expect(report.providers.worktrunk).toMatchObject({
      status: "unavailable",
      lastError: {
        code: "WORKTRUNK_UNAVAILABLE",
        hint: expect.stringContaining("brew install worktrunk"),
      },
      diagnostics: {
        attemptedCommand: "missing-wt",
        installHint: expect.stringContaining("brew install worktrunk"),
      },
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-hooks",
          status: "warn",
          error: expect.objectContaining({
            code: "WORKTRUNK_HOOKS_MISSING",
          }),
        }),
      ]),
    );
    sqlite.close();
  });

  it("scopes stale-registration diagnostics to the requested project", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-wt-diag-scope-"));
    const clock = { now: () => new Date(now) };
    const projects = [project("web"), project("api")];
    const stationConfig = config(stateDir, projects);
    const listCalls: ExternalCommandInput[] = [];
    const providers = new ProviderRegistry({
      worktree: new WorktrunkProvider({
        command: "wt",
        useLifecycleHooks: false,
        clock,
        runner: async (input) => {
          if (input.args?.includes("list")) {
            listCalls.push(input);
            return {
              command: input.command,
              args: input.args ?? [],
              stdout: JSON.stringify([
                {
                  path: `${input.cwd}/missing-feature`,
                  branch: "missing-feature",
                  worktree: { state: "prunable" },
                },
              ]),
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            command: input.command,
            args: input.args ?? [],
            stdout: input.args?.includes("--version") ? "wt 0.64.0" : "--no-hooks",
            stderr: "",
            exitCode: 0,
          };
        },
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config: stationConfig,
      providers,
      clock,
      sqlitePath: join(stateDir, "observer.sqlite"),
    });

    const report = await runDoctor(
      {
        config: stationConfig,
        core,
        persistence,
        persistenceHealth: persistence,
        providers,
        paths: { stateDir },
        clock,
      },
      { projectId: "web" },
    );

    expect(listCalls.map((call) => call.cwd)).toEqual([projects[0]?.root]);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-stale-registrations-web",
          status: "warn",
        }),
      ]),
    );
    expect(report.checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "worktrunk-stale-registrations-api" }),
      ]),
    );
    sqlite.close();
  });

  it("scopes corrupted-root diagnostics and preserves the typed project error", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-wt-diag-bare-root-"));
    const clock = { now: () => new Date(now) };
    const webRoot = join(stateDir, "web");
    const apiRoot = join(stateDir, "api");
    await Promise.all([
      mkdir(join(webRoot, ".git"), { recursive: true }),
      mkdir(join(apiRoot, ".git"), { recursive: true }),
    ]);
    const projects = [project("web", webRoot), project("api", apiRoot)];
    const stationConfig = config(stateDir, projects);
    const listCalls: ExternalCommandInput[] = [];
    const providers = new ProviderRegistry({
      worktree: new WorktrunkProvider({
        command: "wt",
        useLifecycleHooks: false,
        clock,
        runner: async (input) => {
          if (input.command === "git") {
            return commandResult(
              input,
              input.args?.includes(webRoot) === true ? "true\n" : "false\n",
            );
          }
          if (input.args?.includes("list")) {
            listCalls.push(input);
            return commandResult(input, "[]");
          }
          return commandResult(
            input,
            input.args?.includes("--version") ? "wt 0.64.0" : "--no-hooks",
          );
        },
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config: stationConfig,
      providers,
      clock,
      sqlitePath: join(stateDir, "observer.sqlite"),
    });

    await core.reconcile("bare-root-diagnostics");
    expect(
      core.getSnapshot().projects.find((candidate) => candidate.id === "web")?.health,
    ).toMatchObject({
      status: "unavailable",
      lastError: {
        code: "WORKTRUNK_PROJECT_ROOT_BARE",
        projectId: "web",
        hint: expect.stringContaining("config --local core.bare false"),
      },
    });

    listCalls.length = 0;
    const report = await runDoctor(
      {
        config: stationConfig,
        core,
        persistence,
        persistenceHealth: persistence,
        providers,
        paths: { stateDir },
        clock,
      },
      { projectId: "web" },
    );

    expect(report.status).toBe("degraded");
    expect(listCalls).toEqual([]);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-project-root-web",
          status: "warn",
          error: expect.objectContaining({
            code: "WORKTRUNK_PROJECT_ROOT_BARE",
            projectId: "web",
          }),
        }),
      ]),
    );
    expect(report.checks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "worktrunk-project-root-api" })]),
    );
    sqlite.close();
  });

  it("returns partial stale evidence before the outer provider timeout", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-wt-diag-timeout-"));
    const clock = { now: () => new Date(now) };
    const projects = [project("web"), project("api")];
    const stationConfig = config(stateDir, projects);
    let slowScanAborted = false;
    const providers = new ProviderRegistry({
      worktree: new WorktrunkProvider({
        command: "wt",
        useLifecycleHooks: false,
        clock,
        runner: async (input) => {
          if (input.args?.includes("list") && input.cwd === projects[1]?.root) {
            return new Promise((_, reject) => {
              const abort = () => {
                slowScanAborted = true;
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              };
              if (input.signal?.aborted === true) {
                abort();
              } else {
                input.signal?.addEventListener("abort", abort, { once: true });
              }
            });
          }
          return commandResult(
            input,
            input.args?.includes("list")
              ? JSON.stringify([
                  {
                    path: "/tmp/station/web/missing-feature",
                    branch: "missing-feature",
                    worktree: { state: "prunable" },
                  },
                ])
              : input.args?.includes("--version")
                ? "wt 0.64.0"
                : "--no-hooks",
          );
        },
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config: stationConfig,
      providers,
      clock,
      sqlitePath: join(stateDir, "observer.sqlite"),
    });

    const report = await runDoctor({
      config: stationConfig,
      core,
      persistence,
      persistenceHealth: persistence,
      providers,
      paths: { stateDir },
      clock,
      providerDoctorTimeoutMs: 250,
    });

    expect(slowScanAborted).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-stale-registrations-web",
          status: "warn",
        }),
        expect.objectContaining({
          name: "worktrunk-stale-registrations-scan",
          status: "warn",
          message: expect.stringContaining("1 of 2 project(s)"),
        }),
      ]),
    );
    expect(report.checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-diagnostics",
          error: expect.objectContaining({ code: "PROVIDER_DOCTOR_CHECK_TIMEOUT" }),
        }),
      ]),
    );
    sqlite.close();
  });
});

function config(stateDir: string, projects: ProviderProjectConfig[] = []): StationConfig {
  return {
    schemaVersion: 1,
    observer: {
      stateDir,
    },
    defaults: {
      worktreeProvider: "worktrunk",
      terminal: "fake-terminal",
      harness: "fake-harness",
      layout: "agent-shell",
    },
    worktree: {
      worktrunk: {
        configPath: join(stateDir, "worktrunk", "config.toml"),
      },
    },
    projects,
    workspace: DEFAULT_WORKSPACE_CONFIG,
  };
}

function project(id: string, root = `/tmp/station/${id}`): ProviderProjectConfig {
  return {
    id,
    label: id,
    root,
    defaults: {
      harness: "fake-harness",
      terminal: "fake-terminal",
      layout: "agent-shell",
    },
    worktrunk: {
      enabled: true,
    },
  };
}

function commandResult(input: ExternalCommandInput, stdout: string) {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
