import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export const INCIDENT_WORKLOAD = Object.freeze({
  reports: 242,
  batches: 93,
  durationMs: 446_000,
  threeReportBatches: 56,
  twoReportBatches: 37,
});

export const INCIDENT_GRAPH = Object.freeze({
  projects: 4,
  sessionsPerProject: 3,
});

/** Creates the stable project/worktree/session identities used by every profile cell. */
export function createIncidentGraph(root, options = {}) {
  if (!isAbsolute(root)) throw new Error(`Incident fixture root must be absolute: ${root}`);
  const projectCount = options.projects ?? INCIDENT_GRAPH.projects;
  const sessionsPerProject = options.sessionsPerProject ?? INCIDENT_GRAPH.sessionsPerProject;
  const projects = [];
  for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
    const projectId = `memory-project-${String(projectIndex + 1).padStart(2, "0")}`;
    const projectRoot = join(root, "projects", projectId);
    const worktrees = [];
    for (let sessionIndex = 0; sessionIndex < sessionsPerProject; sessionIndex += 1) {
      const ordinal = projectIndex * sessionsPerProject + sessionIndex + 1;
      const worktreeId = `memory-worktree-${String(ordinal).padStart(2, "0")}`;
      const sessionId = `memory-session-${String(ordinal).padStart(2, "0")}`;
      worktrees.push({
        worktreeId,
        sessionId,
        branch: `memory/feature-${String(ordinal).padStart(2, "0")}`,
        path: join(projectRoot, ".memory-worktrees", worktreeId),
        title: `Memory fixture ${String(ordinal).padStart(2, "0")}`,
      });
    }
    projects.push({
      projectId,
      label: `Memory project ${projectIndex + 1}`,
      root: projectRoot,
      worktrees,
    });
  }
  return { projects, sessionCount: projectCount * sessionsPerProject };
}

/** Produces exactly 242 uniquely identifiable reports in the issue's 93-batch/446-second shape. */
export function buildIncidentSchedule(graph, startAt = "2026-08-30T12:00:00.000Z") {
  const startMs = Date.parse(startAt);
  if (!Number.isFinite(startMs)) throw new Error(`Invalid incident fixture start: ${startAt}`);
  const batchIntervalMs = INCIDENT_WORKLOAD.durationMs / (INCIDENT_WORKLOAD.batches - 1);
  const schedule = [];
  let reportNumber = 0;
  for (let batch = 0; batch < INCIDENT_WORKLOAD.batches; batch += 1) {
    const count = batch < INCIDENT_WORKLOAD.threeReportBatches ? 3 : 2;
    const batchAtMs = startMs + Math.round(batch * batchIntervalMs);
    for (let offset = 0; offset < count; offset += 1) {
      const target = graph.projects[reportNumber % graph.projects.length];
      const worktree = target.worktrees[reportNumber % target.worktrees.length];
      reportNumber += 1;
      schedule.push({
        batch,
        offsetMs: offset * 10,
        report: createHarnessEventReport({
          graph,
          reportNumber,
          observedAt: new Date(batchAtMs + offset * 10).toISOString(),
          project: target,
          worktree,
        }),
      });
    }
  }
  if (schedule.length !== INCIDENT_WORKLOAD.reports) {
    throw new Error(`Incident fixture produced ${schedule.length} reports.`);
  }
  return schedule;
}

/** Builds one provider-neutral report; the payload is intentionally small and fixed-size. */
export function createHarnessEventReport(input) {
  const working = input.reportNumber % 2 === 1;
  return {
    schemaVersion: "0.12.0",
    reportId: `memory-report-${String(input.reportNumber).padStart(4, "0")}`,
    provider: "scripted",
    kind: "harness",
    eventType: "memory_fixture.tick",
    observedAt: input.observedAt,
    coalesceKey: `memory-report-${String(input.reportNumber).padStart(4, "0")}`,
    status: {
      value: working ? "working" : "idle",
      confidence: "high",
      reason: working
        ? "deterministic memory fixture working tick"
        : "deterministic memory fixture idle tick",
      source: "harness_event",
      updatedAt: input.observedAt,
    },
    correlation: {
      sessionId: input.worktree.sessionId,
      worktreeId: input.worktree.worktreeId,
      projectId: input.project.projectId,
      cwd: input.worktree.path,
    },
    diagnostics: {
      rawEventType: "memory_fixture.tick",
      payloadBytes: 1_024,
      compactedBytes: 1_024,
      compacted: false,
      truncated: false,
      omittedFieldNames: [],
    },
    providerData: { fixture: "memory-owner", ordinal: input.reportNumber },
  };
}

/** Writes isolated config, project roots, and a Worktrunk-compatible fixed-list executable. */
export async function writeIncidentFixture(root, options = {}) {
  if (!isAbsolute(root)) throw new Error(`Incident fixture root must be absolute: ${root}`);
  const stateDir = options.stateDir ?? join(root, "state");
  const socketPath = options.socketPath ?? join(root, "run", "observer.sock");
  const configPath = options.configPath ?? join(root, "station.config.toml");
  const worktrunkConfigPath = options.worktrunkConfigPath ?? join(root, "worktrunk", "config.toml");
  const graph = createIncidentGraph(root, options);
  await Promise.all([
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(dirname(socketPath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(worktrunkConfigPath), { recursive: true, mode: 0o700 }),
    ...graph.projects.flatMap((project) => [
      mkdir(project.root, { recursive: true, mode: 0o700 }),
      mkdir(join(project.root, ".git"), { recursive: true, mode: 0o700 }),
      ...project.worktrees.map((worktree) =>
        mkdir(worktree.path, { recursive: true, mode: 0o700 }),
      ),
      ...project.worktrees.map((worktree) =>
        mkdir(join(worktree.path, ".git"), { recursive: true, mode: 0o700 }),
      ),
    ]),
  ]);

  const worktrunkPath = join(root, "bin", "memory-worktrunk.mjs");
  await mkdir(dirname(worktrunkPath), { recursive: true, mode: 0o700 });
  await writeFile(worktrunkPath, fakeWorktrunkSource(graph), { mode: 0o700 });
  await chmod(worktrunkPath, 0o700);
  await writeFile(worktrunkConfigPath, "# fixture-owned Worktrunk config\n", { mode: 0o600 });
  await writeFile(
    configPath,
    stationConfigToml({ graph, stateDir, socketPath, worktrunkPath, worktrunkConfigPath }),
    {
      mode: 0o600,
    },
  );
  return {
    root,
    stateDir,
    socketPath,
    configPath,
    worktrunkPath,
    graph,
    schedule: buildIncidentSchedule(graph),
  };
}

function stationConfigToml(input) {
  const lines = [
    "schema_version = 1",
    "",
    "[observer]",
    `socket_path = ${JSON.stringify(input.socketPath)}`,
    `state_dir = ${JSON.stringify(input.stateDir)}`,
    "auto_start_from_hooks = false",
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "noop-terminal"',
    'harness = "scripted"',
    'layout = "agent-shell"',
    "",
    "[worktree.worktrunk]",
    `command = ${JSON.stringify(input.worktrunkPath)}`,
    `config_path = ${JSON.stringify(input.worktrunkConfigPath)}`,
    "use_lifecycle_hooks = false",
    'hook_mode = "disabled"',
    "",
    "[harness.scripted]",
    "enabled = true",
    `command = ${JSON.stringify(process.execPath)}`,
    "",
  ];
  for (const project of input.graph.projects) {
    lines.push(
      "[[projects]]",
      `id = ${JSON.stringify(project.projectId)}`,
      `label = ${JSON.stringify(project.label)}`,
      `root = ${JSON.stringify(project.root)}`,
      "",
      "[projects.defaults]",
      'harness = "scripted"',
      'terminal = "noop-terminal"',
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      "include_main = false",
      "include_external = false",
      `managed_root = ${JSON.stringify(".memory-worktrees")}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function fakeWorktrunkSource(graph) {
  const rows = graph.projects.flatMap((project) =>
    project.worktrees.map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
      dirty: false,
      vars: {
        station: {
          project_id: project.projectId,
          worktree_id: worktree.worktreeId,
          session_id: worktree.sessionId,
        },
      },
    })),
  );
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("memory-worktrunk 0.0.0"); process.exit(0); }
if (args.includes("list")) { console.log(${JSON.stringify(JSON.stringify(rows))}); process.exit(0); }
process.exit(0);
`;
}
