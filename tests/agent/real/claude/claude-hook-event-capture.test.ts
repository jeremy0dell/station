import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { installClaudeHooks, isClaudeForwardedEventType } from "@station/claude";
import { HarnessEventReportSchema } from "@station/contracts";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const realClaudeEnabled = process.env.STATION_REAL_CLAUDE === "1";
const describeRealClaude = realClaudeEnabled ? describe : describe.skip;

const SENTINEL_PROMPT = "Reply with exactly: STATION-HOOK-CAPTURE-OK";

let cleanupTasks: Array<() => Promise<void>> = [];

describeRealClaude("real Claude hook event capture", () => {
  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    await Promise.allSettled(tasks.map((task) => task()));
  });

  // Version-skew tripwire: proves the shipping claude binary still fires the
  // station-generated settings hooks and that real payloads still normalize into
  // schema-valid HarnessEventReports end-to-end through bin/stn-ingress.
  it("spools schema-valid reports from a real claude print run", async () => {
    const claudeBin = process.env.STATION_CLAUDE_BIN ?? "claude";
    await execFileAsync(claudeBin, ["--version"], { timeout: 15_000 });

    const root = await mkdtemp(join(tmpdir(), "station-real-claude-hooks-"));
    const stateDir = join(root, "state");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    const worktreePath = join(root, "worktree");
    const settingsPath = join(stateDir, "hooks", "station-claude-settings.json");
    const hookScriptPath = join(stateDir, "hooks", "station-claude-hook.sh");
    const ingressBin = join(process.cwd(), "bin", "stn-ingress");
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
    if (process.env.STATION_REAL_CLAUDE_KEEP_TEMP !== "1") {
      cleanupTasks.push(async () => {
        await rm(root, { recursive: true, force: true });
      });
    } else {
      process.stderr.write(`Keeping real Claude hook temp root: ${root}\n`);
    }

    await installClaudeHooks({
      claudeSettingsPath: settingsPath,
      claudeConfigDir: join(root, "claude-home"),
      hookScriptPath,
      observerSocketPath: join(root, "observer.sock"),
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
      hookBin: ingressBin,
      env: {},
    });

    await execFileAsync(claudeBin, ["-p", SENTINEL_PROMPT, "--settings", settingsPath], {
      cwd: worktreePath,
      timeout: 150_000,
      env: {
        ...process.env,
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_real_claude",
        STATION_WORKTREE_PATH: worktreePath,
        STATION_SESSION_ID: "ses_real_claude",
        STATION_HARNESS_PROVIDER: "claude",
      },
    });

    const spoolFiles = (await readdir(hookSpoolDir)).filter((name) => name.endsWith(".json"));
    expect(spoolFiles.length).toBeGreaterThan(0);

    const eventTypes: string[] = [];
    for (const name of spoolFiles) {
      const record = JSON.parse(await readFile(join(hookSpoolDir, name), "utf8")) as {
        report?: unknown;
      };
      expect(record.report, `${name} should carry a harness event report`).toBeDefined();
      const report = HarnessEventReportSchema.parse(record.report);
      expect(report.provider).toBe("claude");
      expect(isClaudeForwardedEventType(report.eventType)).toBe(true);
      expect(report.correlation).toMatchObject({
        sessionId: "ses_real_claude",
        worktreeId: "wt_real_claude",
      });
      expect(JSON.stringify(report)).not.toContain(SENTINEL_PROMPT);
      eventTypes.push(report.eventType);
    }

    expect(eventTypes).toEqual(expect.arrayContaining(["SessionStart", "Stop", "SessionEnd"]));
  }, 180_000);
});
