import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSqliteObserverPersistence,
  openObserverSqlite,
} from "../../apps/observer/dist/internal.js";
import { shellQuote } from "../../packages/runtime/dist/index.js";

/** Creates only fixture-owned Git, provider artifacts, and recovery records. */
export async function prepareUpdateRecoveryFixture({
  root,
  stateDir,
  configPath,
  socketPath,
  env,
  tmux,
  run,
}) {
  const projectRoot = join(root, "project");
  const resumeLog = join(root, "resumes.log");
  const fakeCodex = join(root, "codex-fixture");
  await mkdir(projectRoot, { recursive: true });
  await run("git", ["init", "-b", "main", projectRoot], { env });
  await run(
    "git",
    [
      "-C",
      projectRoot,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    ],
    { env },
  );
  for (let index = 0; index < 3; index += 1) {
    await run(
      "git",
      [
        "-C",
        projectRoot,
        "worktree",
        "add",
        "-b",
        `recovery-${index}`,
        join(root, `worktree-${index}`),
      ],
      { env },
    );
  }
  const worktrunk = join(root, "worktrunk-fixture");
  const canonicalRoot = await realpath(root);
  const worktrees = Array.from({ length: 3 }, (_, index) => ({
    path: join(canonicalRoot, `worktree-${index}`),
    branch: `recovery-${index}`,
    dirty: false,
  }));
  await writeFile(
    worktrunk,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("worktrunk 0.0.0-fixture"); process.exit(0); }
if (args.includes("--help")) { console.log("Options: --no-hooks --yes"); process.exit(0); }
if (!args.includes("list")) process.exit(89);
console.log(${JSON.stringify(JSON.stringify(worktrees))});
`,
    { mode: 0o700 },
  );
  await writeFile(resumeLog, "", { mode: 0o600 });
  await writeFile(
    fakeCodex,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.114.0"); process.exit(0); }
if (args[0] === "login") process.exit(0);
if (args[0] !== "resume") process.exit(89);
appendFileSync(${JSON.stringify(resumeLog)}, args.join(" ") + "\\n");
console.log("RECOVERY_FIXTURE_READY");
process.stdin.resume();
`,
    { mode: 0o700 },
  );
  await writeFile(
    configPath,
    `schema_version = 1
[observer]
state_dir = ${JSON.stringify(stateDir)}
socket_path = ${JSON.stringify(socketPath)}
[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-shell"
[feature_flags]
session_resume_agent = true
[worktree.worktrunk]
command = ${JSON.stringify(worktrunk)}
include_external = true
include_main = true
hook_mode = "disabled"
breadcrumb_location = "disabled"
[terminal.tmux]
command = ${JSON.stringify(tmux.tmuxPath)}
workbench_session = "recovery-workbench"
workbench_socket_path = ${JSON.stringify(tmux.socketPath)}
[harness.codex]
command = ${JSON.stringify(fakeCodex)}
resume = true
install_hooks = true
[harness.claude]
command = ${JSON.stringify(fakeCodex)}
install_hooks = false
[[projects]]
id = "recovery-project"
label = "Recovery fixture"
root = ${JSON.stringify(projectRoot)}
[projects.worktrunk]
include_external = true
include_main = true
`,
    { mode: 0o600 },
  );
  await run(tmux.tmuxPath, ["new-session", "-d", "-s", "recovery-workbench", "/bin/sh"], {
    env: tmux.env,
  });
  const sessions = [];
  let unrelated;
  return {
    async captureFailure(observer) {
      const panes = await run(
        tmux.tmuxPath,
        [
          "list-panes",
          "-a",
          "-F",
          "#{pane_id}\t#{pane_current_command}\t#{pane_dead}\t#{pane_pid}\t#{pane_current_path}",
        ],
        { env: tmux.env },
      );
      const screens = [];
      for (const row of panes.stdout.trim().split("\n")) {
        const pane = row.split("\t")[0];
        const screen = await run(tmux.tmuxPath, ["capture-pane", "-p", "-t", pane], {
          env: tmux.env,
        });
        screens.push({ pane, screen: screen.stdout });
      }
      const evidence = {
        snapshot: await observer.getSnapshot(),
        resumes: await readFile(resumeLog, "utf8"),
        panes: panes.stdout,
        screens,
      };
      await writeFile(join(root, "recovery-evidence.json"), JSON.stringify(evidence, null, 2), {
        mode: 0o600,
      });
      process.stderr.write(`Recovery fixture evidence: ${JSON.stringify(evidence)}\n`);
    },
    async seedAndSpawn(observer, host) {
      const snapshot = await observer.getSnapshot();
      const rows = snapshot.rows.filter((row) => row.branch?.startsWith("recovery-"));
      assert.equal(rows.length, 3, JSON.stringify(snapshot));
      const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite") });
      const persistence = createSqliteObserverPersistence({ sqlite });
      try {
        const now = new Date().toISOString();
        const codexSessions = join(env.HOME, ".codex", "sessions");
        await mkdir(codexSessions, { recursive: true, mode: 0o700 });
        for (const [index, row] of rows.entries()) {
          const sessionId = `session-recovery-${index}`;
          const nativeId = `00000000-0000-4000-8000-00000000000${index + 1}`;
          await persistence.seedSession({
            sessionId,
            projectId: row.projectId,
            worktreeId: row.id,
            harness: "codex",
            initialTitle: "Recovery fixture",
            terminalProvider: "tmux",
            createdAt: now,
            lastSeenAt: now,
          });
          await persistence.upsertSessionRecoveryHandle({
            id: `fixture-report-${index}`,
            provider: "codex",
            projectId: row.projectId,
            worktreeId: row.id,
            sessionId,
            target: { kind: "native-session", id: nativeId },
            cwd: row.path,
            observedAt: now,
            lastSeenAt: now,
          });
          await writeFile(
            join(codexSessions, `rollout-fixture-${nativeId}.jsonl`),
            `${JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd: row.path, timestamp: now } })}\n`,
            { mode: 0o600 },
          );
          const identity = {
            kind: "agent",
            terminalTargetId: `native:recovery-${index}`,
            projectId: row.projectId,
            worktreeId: row.id,
            sessionId,
            worktreePath: row.path,
            harnessProvider: "codex",
          };
          const spawned = await host.spawn({
            ...identity,
            command: "/bin/sh",
            args: ["-c", "printf 'UPDATE_SMOKE_PRE\\n'; read _"],
            cwd: row.path,
            cols: 80,
            rows: 24,
          });
          sessions.push({ ...identity, ...spawned, nativeId });
        }
        await persistence.seedSession({
          sessionId: "session-unrelated",
          projectId: "recovery-project",
          worktreeId: "missing-worktree",
          harness: "claude",
          initialTitle: "Unrelated retained session",
          terminalProvider: "tmux",
          createdAt: now,
          lastSeenAt: now,
        });
        unrelated = (await persistence.readRecoveryRepairSnapshot()).snapshot.sessions.find(
          (session) => session.id === "session-unrelated",
        );
      } finally {
        sqlite.close();
      }
      return sessions;
    },
    async verify(observer, report) {
      assert.equal(report.schemaVersion, 6);
      assert.equal(report.status, "current");
      assert.equal(report.initial.evidenceComplete, false);
      assert.equal(report.reapRecovery.status, "completed");
      assert.equal(report.reapRecovery.terminals.length, 3);
      assert.ok(
        report.reapRecovery.terminals.every((terminal) => terminal.resumeDisposition === "resumed"),
      );
      assert.equal(report.finalInspection.plan.outcome, "converged");
      assert.equal(
        report.warnings.filter((warning) => warning.code === "UPDATE_RETAINED_SESSION_UNRESOLVED")
          .length,
        1,
      );
      const snapshot = await observer.getSnapshot();
      for (const session of sessions) {
        const row = snapshot.rows.find((row) => row.id === session.worktreeId);
        assert.equal(row?.agent?.sessionId, session.sessionId, JSON.stringify(row));
        assert.equal(row.agent.harness, "codex");
      }
      const log = await readFile(resumeLog, "utf8");
      for (const session of sessions) assert.equal(log.split(session.nativeId).length - 1, 1, log);
      const panes = await run(
        tmux.tmuxPath,
        ["list-panes", "-a", "-F", "#{session_name}:#{pane_current_path}"],
        { env: tmux.env },
      );
      for (const session of sessions)
        assert.ok(
          panes.stdout.includes(`recovery-workbench:${session.worktreePath}`),
          panes.stdout,
        );
      const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite") });
      try {
        const persistence = createSqliteObserverPersistence({ sqlite });
        assert.deepEqual(
          (await persistence.readRecoveryRepairSnapshot()).snapshot.sessions.find(
            (session) => session.id === "session-unrelated",
          ),
          unrelated,
        );
      } finally {
        sqlite.close();
      }
      const tuiScript = join(root, "real-tui");
      const tuiExit = join(root, "real-tui.exit");
      await writeFile(
        tuiScript,
        `#!/bin/sh
unset TMUX TMUX_PANE
${shellQuote(join(root, "bin", "stn"))}
printf '%s' "$?" > ${shellQuote(tuiExit)}
read _
`,
        { mode: 0o700 },
      );
      const tui = await run(
        tmux.tmuxPath,
        [
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          "station-update",
          "-n",
          "recovery-tui",
          tuiScript,
        ],
        { env: tmux.env },
      );
      const pane = tui.stdout.trim();
      try {
        let screen = "";
        let openedProjectView = false;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          screen = (await run(tmux.tmuxPath, ["capture-pane", "-p", "-t", pane], { env: tmux.env }))
            .stdout;
          if (screen.includes("Recovery fixture")) break;
          if (!openedProjectView && screen.includes("Open project view")) {
            await run(tmux.tmuxPath, ["send-keys", "-t", pane, "Enter"], { env: tmux.env });
            openedProjectView = true;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(
          screen.includes("Recovery fixture"),
          `Real TUI did not render the project: ${screen}`,
        );
        await writeFile(join(root, "real-tui.txt"), screen, { mode: 0o600 });
        await run(tmux.tmuxPath, ["send-keys", "-t", pane, "C-q"], { env: tmux.env });
        let exit;
        while (Date.now() < deadline) {
          exit = await readFile(tuiExit, "utf8").catch(() => undefined);
          if (exit !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(exit, "0", "Real TUI exits cleanly through Ctrl-Q");
      } finally {
        await run(tmux.tmuxPath, ["kill-window", "-t", pane], {
          env: tmux.env,
          allowedExitCodes: [0, 1],
        });
      }
      // A completed rerun must not launch any provider session again.
      await run(join(root, "bin", "stn"), ["update", "--reap", "--json"], {
        env,
        timeoutMs: 30_000,
      });
      assert.equal(await readFile(resumeLog, "utf8"), log);
    },
  };
}
