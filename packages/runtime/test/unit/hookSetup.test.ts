import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignBackupPaths,
  commandLine,
  createHookSetupFileOps,
  expectedProviderHookScript,
  type HookSetupErrorFactory,
  hookCommandsForEvents,
  installConfigScriptHook,
  planConfigScriptHook,
  providerHookCommandArgs,
  providerHookCommandLine,
  providerHookInvocationMatchesIgnoringBin,
  providerHookScriptOptions,
  providerHookScriptRoutesByStationEnv,
  shellQuote,
  uninstallConfigScriptHook,
} from "@station/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal document model so the plan/install/uninstall orchestration can be exercised
// without pulling in a provider-specific schema. Config is event -> hook-script-path.
type Doc = Record<string, string>;
const EVENTS = ["PreToolUse", "PostToolUse"] as const;
type Event = (typeof EVENTS)[number];

const docSpec = (scriptPath: string) => ({
  readOptionalFile: readViaOps,
  configPath: "", // set per call
  hookScriptPath: scriptPath,
  parseDocument: (source: string): Doc => (source.trim() ? (JSON.parse(source) as Doc) : {}),
  installCommands: (document: Doc, commands: Record<Event, string>): Doc => ({
    ...document,
    ...commands,
  }),
  removeCommands: (document: Doc, commands: Record<Event, string>): Doc => {
    // Generated entries are keyed by known event names; only those are removed.
    const next: Doc = { ...document };
    for (const event of Object.keys(commands)) {
      delete next[event];
    }
    return next;
  },
  stringifyDocument: (document: Doc): string => JSON.stringify(document, null, 2),
  missingEvents: (document: Doc, commands: Record<Event, string>): Event[] =>
    EVENTS.filter((event) => document[event] !== commands[event]),
  documentContainsCommand: (document: Doc, command: string): boolean =>
    Object.values(document).includes(command),
  expectedCommands: (path: string) => hookCommandsForEvents(EVENTS, path),
});

let readViaOps: (path: string) => Promise<string>;

describe("runtime hookSetup", () => {
  let root: string;
  let createError: HookSetupErrorFactory;
  let ops: ReturnType<typeof createHookSetupFileOps>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "station-hooksetup-"));
    createError = ({ operation, path, cause }) => {
      const error = new Error(`${operation}:${path}`) as Error & {
        operation: string;
        cause: unknown;
      };
      error.operation = operation;
      error.cause = cause;
      return error;
    };
    ops = createHookSetupFileOps(createError);
    readViaOps = ops.readOptionalFile;
  });

  describe("shellQuote / commandLine", () => {
    it("leaves safe tokens unquoted and quotes the rest", () => {
      expect(shellQuote("stn-ingress")).toBe("stn-ingress");
      expect(shellQuote("/tmp/station/config.toml")).toBe("/tmp/station/config.toml");
      expect(shellQuote("has space")).toBe("'has space'");
      expect(shellQuote("it's")).toBe("'it'\\''s'");
      expect(commandLine(["stn-ingress", "--config", "a b", "claude"])).toBe(
        "stn-ingress --config 'a b' claude",
      );
    });
  });

  describe("providerHookCommandLine / expectedProviderHookScript", () => {
    it("assembles the ingress command with optional flags only when present", () => {
      expect(providerHookCommandLine("claude", { stationConfigPath: "/c.toml" })).toBe(
        "stn-ingress --config /c.toml claude",
      );
      expect(
        providerHookCommandLine("codex", {
          observerSocketPath: "/s.sock",
          autoStartFromHooks: false,
          hookBin: "/bin/ingress",
        }),
      ).toBe("/bin/ingress --socket /s.sock --no-auto-start codex");
    });

    it("reproduces each provider's exact redirect/suffix shape", () => {
      const plain = expectedProviderHookScript({ provider: "codex" });
      expect(plain).toContain(`stn-ingress \${SOCKET_ARG[@]+"\${SOCKET_ARG[@]}"}`);
      expect(plain).toContain("codex > /dev/null\n");
      expect(plain).not.toContain("|| true");

      const ignoreAndRedirect = expectedProviderHookScript({
        provider: "claude",
        ignoreFailure: true,
        redirectStderr: true,
      });
      expect(ignoreAndRedirect).toContain("claude > /dev/null 2>&1 || true\n");

      // No ownership gate: external sessions (no station env) must deliver so
      // the observer can correlate them by cwd; scope lives in the adapters.
      expect(plain).not.toContain("STATION_SESSION_ID");
      expect(plain).not.toContain("STATION_WORKTREE_ID");
      expect(plain).not.toContain("  exit 0");
    });

    it("builds provider-neutral ingress commands and generated scripts", () => {
      const options = providerHookScriptOptions("/tmp/station hook.sh", {
        stationConfigPath: "/tmp/station/config.toml",
        observerSocketPath: "/tmp/station/run/observer.sock",
        stateDir: "/tmp/station/state",
        hookSpoolDir: "/tmp/station/state/spool/hooks",
        autoStartFromHooks: false,
        hookBin: "/usr/local/bin/stn-ingress",
      });

      expect(providerHookCommandArgs("codex", options, "PreToolUse")).toEqual([
        "/usr/local/bin/stn-ingress",
        "--socket",
        "/tmp/station/run/observer.sock",
        "--state-dir",
        "/tmp/station/state",
        "--spool-dir",
        "/tmp/station/state/spool/hooks",
        "--config",
        "/tmp/station/config.toml",
        "--no-auto-start",
        "codex",
        "PreToolUse",
      ]);
      expect(providerHookCommandLine("codex", options, "PreToolUse")).toBe(
        "/usr/local/bin/stn-ingress --socket /tmp/station/run/observer.sock --state-dir /tmp/station/state --spool-dir /tmp/station/state/spool/hooks --config /tmp/station/config.toml --no-auto-start codex PreToolUse",
      );
      expect(
        expectedProviderHookScript({
          provider: "claude",
          options,
          ignoreFailure: true,
          redirectStderr: true,
        }),
      ).toContain("claude > /dev/null 2>&1 || true");
    });

    it("routes generated hook scripts through runtime Station env before install fallbacks", () => {
      const script = expectedProviderHookScript({
        provider: "cursor",
        options: {
          stationConfigPath: "/tmp/stale/config.toml",
          observerSocketPath: "/tmp/stale/observer.sock",
          stateDir: "/tmp/stale/state",
          hookSpoolDir: "/tmp/stale/spool/hooks",
          hookBin: "/tmp/bin/stn-ingress",
        },
      });

      expect(script).toContain(`if [ -n "\${STATION_OBSERVER_SOCKET_PATH:-}" ]; then`);
      expect(script).toContain('  SOCKET_ARG=(--socket "$STATION_OBSERVER_SOCKET_PATH")');
      expect(script).toContain("else\n  SOCKET_ARG=(--socket /tmp/stale/observer.sock)");
      expect(script).toContain(`if [ -n "\${STATION_CONFIG_PATH:-}" ]; then`);
      expect(script).toContain('  CONFIG_ARG=(--config "$STATION_CONFIG_PATH")');
      expect(script).toContain("else\n  CONFIG_ARG=(--config /tmp/stale/config.toml)");
      expect(script).toContain(`elif [ -z "\${STATION_CONFIG_PATH:-}" ]; then`);
      expect(script).toContain("STATE_DIR_ARG=(--state-dir /tmp/stale/state)");
      expect(script).toContain("SPOOL_DIR_ARG=(--spool-dir /tmp/stale/spool/hooks)");
    });

    it("recognizes generated scripts that route through runtime Station env", () => {
      const script = expectedProviderHookScript({
        provider: "cursor",
        options: {
          stationConfigPath: "/tmp/stale/config.toml",
          observerSocketPath: "/tmp/stale/observer.sock",
          stateDir: "/tmp/stale/state",
          hookSpoolDir: "/tmp/stale/spool/hooks",
        },
      });

      expect(providerHookScriptRoutesByStationEnv(script, "cursor")).toBe(true);
      expect(providerHookScriptRoutesByStationEnv(script, "codex")).toBe(false);
      expect(
        providerHookScriptRoutesByStationEnv(
          script.replaceAll("STATION_CONFIG_PATH", "STATION_OLD_CONFIG_PATH"),
          "cursor",
        ),
      ).toBe(false);
    });

    it("matches checkout-local and PATH hook binaries without hiding other drift", () => {
      const expectedScript = expectedProviderHookScript({
        provider: "codex",
        options: { stationConfigPath: "/tmp/station/config.toml" },
      });
      const checkoutScript = expectedProviderHookScript({
        provider: "codex",
        options: {
          stationConfigPath: "/tmp/station/config.toml",
          hookBin: "/tmp/checkout with space/bin/stn-ingress",
        },
      });

      expect(
        providerHookInvocationMatchesIgnoringBin(checkoutScript, expectedScript, "codex"),
      ).toBe(true);
      expect(
        providerHookInvocationMatchesIgnoringBin(
          checkoutScript,
          expectedScript.replace("/tmp/station/config.toml", "/tmp/other/config.toml"),
          "codex",
        ),
      ).toBe(false);
      expect(
        providerHookInvocationMatchesIgnoringBin(
          "/tmp/checkout/bin/stn-ingress --config /tmp/station/config.toml worktrunk post-create",
          "stn-ingress --config /tmp/station/config.toml worktrunk post-create",
          "worktrunk",
        ),
      ).toBe(true);
      expect(
        providerHookInvocationMatchesIgnoringBin(
          "malicious --config /tmp/station/config.toml worktrunk post-create",
          "stn-ingress --config /tmp/station/config.toml worktrunk post-create",
          "worktrunk",
        ),
      ).toBe(false);
    });
  });

  describe("plan / install / uninstall lifecycle", () => {
    it("plans a fresh install as fully changed, then idempotent after install", async () => {
      const configPath = join(root, "config.json");
      const scriptPath = join(root, "hook.sh");
      const spec = { ...docSpec(scriptPath), configPath };
      const expectedScript = expectedProviderHookScript({ provider: "claude" });

      const fresh = await planConfigScriptHook({ ...spec, expectedScript });
      expect(fresh.configChanged).toBe(true);
      expect(fresh.scriptChanged).toBe(true);
      expect(fresh.changed).toBe(true);
      expect(fresh.missing.sort()).toEqual([...EVENTS].sort());

      const backup = await installConfigScriptHook({
        configPath,
        hookScriptPath: scriptPath,
        after: fresh.after,
        expectedScript,
        configChanged: fresh.configChanged,
        scriptChanged: fresh.scriptChanged,
        fileOps: ops,
      });
      expect(backup).toBeUndefined(); // nothing to back up on first write

      // config 0o600, script 0o700 + chmod
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(scriptPath)).mode & 0o777).toBe(0o700);
      expect(await readFile(scriptPath, "utf8")).toBe(expectedScript);

      const replan = await planConfigScriptHook({ ...spec, expectedScript });
      expect(replan.configChanged).toBe(false);
      expect(replan.scriptChanged).toBe(false);
      expect(replan.changed).toBe(false);
      expect(replan.missing).toEqual([]);
    });

    it("honors extraChanged even when config and script are unchanged", async () => {
      const configPath = join(root, "config.json");
      const scriptPath = join(root, "hook.sh");
      const expectedScript = expectedProviderHookScript({ provider: "claude" });
      const spec = { ...docSpec(scriptPath), configPath };

      const first = await planConfigScriptHook({ ...spec, expectedScript });
      await installConfigScriptHook({
        configPath,
        hookScriptPath: scriptPath,
        after: first.after,
        expectedScript,
        configChanged: first.configChanged,
        scriptChanged: first.scriptChanged,
        fileOps: ops,
      });

      const replan = await planConfigScriptHook({ ...spec, expectedScript, extraChanged: true });
      expect(replan.configChanged).toBe(false);
      expect(replan.scriptChanged).toBe(false);
      expect(replan.changed).toBe(true);
    });

    it("backs up the existing config when a reinstall changes it", async () => {
      const configPath = join(root, "config.json");
      const scriptPath = join(root, "hook.sh");
      const expectedScript = expectedProviderHookScript({ provider: "claude" });

      await writeFile(configPath, JSON.stringify({ PreToolUse: "/old/path.sh" }), "utf8");
      const spec = { ...docSpec(scriptPath), configPath };
      const plan = await planConfigScriptHook({ ...spec, expectedScript });
      expect(plan.configChanged).toBe(true);

      const backup = await installConfigScriptHook({
        configPath,
        hookScriptPath: scriptPath,
        after: plan.after,
        expectedScript,
        configChanged: plan.configChanged,
        scriptChanged: plan.scriptChanged,
        fileOps: ops,
      });
      expect(backup).toBeDefined();
      expect(await readFile(backup as string, "utf8")).toContain("/old/path.sh");
    });

    it("removes the script on uninstall only when no command still references it", async () => {
      const configPath = join(root, "config.json");
      const scriptPath = join(root, "hook.sh");
      const expectedScript = expectedProviderHookScript({ provider: "claude" });
      const spec = { ...docSpec(scriptPath), configPath };

      const plan = await planConfigScriptHook({ ...spec, expectedScript });
      await installConfigScriptHook({
        configPath,
        hookScriptPath: scriptPath,
        after: plan.after,
        expectedScript,
        configChanged: plan.configChanged,
        scriptChanged: plan.scriptChanged,
        fileOps: ops,
      });

      const removed = await uninstallConfigScriptHook({ ...spec, fileOps: ops });
      expect(removed.scriptRemoved).toBe(true);
      expect(removed.configChanged).toBe(true);
      expect(removed.backupPath).toBeDefined();
      await expect(stat(scriptPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps the script when an unrelated event still points at it", async () => {
      const configPath = join(root, "config.json");
      const scriptPath = join(root, "hook.sh");
      // An out-of-band event references the same script; removeCommands won't touch it.
      await writeFile(
        configPath,
        JSON.stringify({ PreToolUse: scriptPath, PostToolUse: scriptPath, Custom: scriptPath }),
        "utf8",
      );
      await writeFile(scriptPath, "#!/usr/bin/env bash\n", { mode: 0o700 });

      const removed = await uninstallConfigScriptHook({
        ...docSpec(scriptPath),
        configPath,
        fileOps: ops,
      });
      expect(removed.scriptRemoved).toBe(false);
      expect((await stat(scriptPath)).mode & 0o777).toBe(0o700); // script survives
    });
  });

  describe("createHookSetupFileOps error-operation mapping", () => {
    let filePath: string;
    let dirPath: string;

    beforeEach(async () => {
      filePath = join(root, "a-file");
      await writeFile(filePath, "x", "utf8");
      dirPath = await mkdtemp(join(root, "dir-"));
    });

    it("maps read failures", async () => {
      await expect(ops.readOptionalFile(dirPath)).rejects.toMatchObject({ operation: "read" });
    });

    it("maps writeConfig and writeScript failures by mode", async () => {
      const underFile = join(filePath, "nested", "out");
      await expect(ops.writeHookConfig(underFile, "x")).rejects.toMatchObject({
        operation: "writeConfig",
      });
      await expect(ops.writeHookScript(underFile, "x")).rejects.toMatchObject({
        operation: "writeScript",
      });
    });

    it("maps remove failures", async () => {
      await expect(ops.removeHookFileIfPresent(dirPath)).rejects.toMatchObject({
        operation: "remove",
      });
    });

    it("maps metadata and backup failures", async () => {
      // stat on a path whose parent is a file -> ENOTDIR -> metadata
      await expect(ops.backupIfPresent(join(filePath, "nested"))).rejects.toMatchObject({
        operation: "metadata",
      });
      // path exists (a directory) -> copyFile of a directory -> backup
      await expect(ops.backupIfPresent(dirPath)).rejects.toMatchObject({ operation: "backup" });
    });

    it("treats an absent file as no backup, not an error", async () => {
      await expect(ops.backupIfPresent(join(root, "missing"))).resolves.toBeUndefined();
    });

    it("keeps backups distinct when created in the same millisecond", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
      try {
        const first = await ops.backupIfPresent(filePath);
        const second = await ops.backupIfPresent(filePath);
        expect(first).not.toBe(second);
        await expect(readFile(first as string, "utf8")).resolves.toBe("x");
        await expect(readFile(second as string, "utf8")).resolves.toBe("x");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("assignBackupPaths", () => {
    it("is a no-op when no real backups exist", () => {
      const target: { backupPath?: string; backupPaths?: string[] } = {};
      assignBackupPaths(target, [undefined, undefined]);
      expect(target).toEqual({});
    });

    it("sets backupPath to the first and lists all present backups", () => {
      const target: { backupPath?: string; backupPaths?: string[] } = {};
      assignBackupPaths(target, ["/a.bak", undefined, "/b.bak"]);
      expect(target.backupPath).toBe("/a.bak");
      expect(target.backupPaths).toEqual(["/a.bak", "/b.bak"]);
    });
  });
});
