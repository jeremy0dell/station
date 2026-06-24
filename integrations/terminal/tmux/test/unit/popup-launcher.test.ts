import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const launcherPath = fileURLToPath(new URL("../../bin/stn-popup", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\/$/, "");

describe("tmux popup launcher", () => {
  it("attaches a registered persistent popup UI without entering the Node CLI", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_TMUX_OWNER: `${process.pid}:test`,
        FAKE_TMUX_DEV_ROOT: repoRoot,
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0 });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_tui_dev_owner",
      "show-options -gqv @station_tui_dev_root",
      "has-session -t _station-ui-dev",
      "show-options -t _station-ui-dev -qv @station_popup_ui_signature",
      "display-message -p #{client_name}",
      "show-options -gqv @station_popup_client",
      "set-option -gq @station_popup_client client_1",
      "set-option -gq @station_popup_focus_client client_1",
      "set-option -t _station-ui-dev mouse on",
      expect.stringContaining(
        `display-popup -c client_1 -w 50% -h 50% -E env -u TMUX '${fixture.tmuxPath}' -T hyperlinks attach-session -t '_station-ui-dev'`,
      ),
      "show-options -gqv @station_popup_client",
      "show-options -gqv @station_popup_focus_client",
    ]);
  });

  it("accepts a tmux binding focus client even when TMUX is not exported", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_TMUX_OWNER: `${process.pid}:test`,
        FAKE_TMUX_DEV_ROOT: repoRoot,
        TMUX_LOG: fixture.logPath,
        STATION_FOCUS_CLIENT_ID: "client_from_binding",
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0 });

    expect(await readLog(fixture.logPath)).toContain(
      "display-popup -c client_from_binding -w 50% -h 50% -E env -u TMUX " +
        `'${fixture.tmuxPath}' -T hyperlinks attach-session -t '_station-ui-dev'`,
    );
  });

  it("attaches a registered normal popup UI without entering the Node CLI", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_FAST_POPUP_EXPECTED_SIGNATURE: "v1:node normal tui --popup --persistent",
        FAKE_FAST_POPUP_ROOT: repoRoot,
        FAKE_FAST_POPUP_SESSION_NAME: "_station-ui",
        FAKE_TMUX_MISSING_DEV_REGISTRATION: "1",
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0 });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_popup_ui_session_name",
      "show-options -gqv @station_popup_ui_expected_signature",
      "show-options -gqv @station_popup_ui_root",
      "has-session -t _station-ui",
      "show-options -t _station-ui -qv @station_popup_ui_signature",
      "display-message -p #{client_name}",
      "show-options -gqv @station_popup_client",
      "set-option -gq @station_popup_client client_1",
      "set-option -gq @station_popup_focus_client client_1",
      "set-option -t _station-ui mouse on",
      expect.stringContaining(
        `display-popup -c client_1 -w 50% -h 50% -E env -u TMUX '${fixture.tmuxPath}' -T hyperlinks attach-session -t '_station-ui'`,
      ),
      "show-options -gqv @station_popup_client",
      "show-options -gqv @station_popup_focus_client",
    ]);
  });

  it("only claims bare station and explicit popup invocations", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher(["snapshot"], {
        FAKE_TMUX_OWNER: `${process.pid}:test`,
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 1 });

    await expect(readLog(fixture.logPath)).resolves.toEqual([]);
  });

  it("closes the current client popup when toggled from the same client", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher(["popup"], {
        FAKE_ACTIVE_POPUP_CLIENT: "client_1",
        FAKE_TMUX_OWNER: `${process.pid}:test`,
        FAKE_TMUX_DEV_ROOT: repoRoot,
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0 });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_tui_dev_owner",
      "show-options -gqv @station_tui_dev_root",
      "has-session -t _station-ui-dev",
      "show-options -t _station-ui-dev -qv @station_popup_ui_signature",
      "display-message -p #{client_name}",
      "show-options -gqv @station_popup_client",
      "display-popup -c client_1 -C",
      "show-options -gqv @station_popup_client",
      "set-option -gq -u @station_popup_client",
      "show-options -gqv @station_popup_focus_client",
    ]);
  });

  it("falls back to the normal popup command when registered metadata is missing", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_TMUX_MISSING_REGISTRATION: "1",
        FAKE_TMUX_OWNER: `${process.pid}:test`,
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_POPUP_FALLBACK_COMMAND: "printf fallback",
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "fallback" });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_popup_ui_session_name",
      "show-options -gqv @station_popup_ui_expected_signature",
      "show-options -gqv @station_popup_ui_root",
      "set-option -gq -u @station_popup_ui_session_name",
      "set-option -gq -u @station_popup_ui_expected_signature",
      "set-option -gq -u @station_popup_ui_root",
    ]);
  });

  it("declines fallback when the launcher is only being probed", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_TMUX_MISSING_REGISTRATION: "1",
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_FAST_POPUP_NO_FALLBACK: "1",
        STATION_POPUP_FALLBACK_COMMAND: "printf fallback",
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 1, stdout: "" });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_popup_ui_session_name",
      "show-options -gqv @station_popup_ui_expected_signature",
      "show-options -gqv @station_popup_ui_root",
      "set-option -gq -u @station_popup_ui_session_name",
      "set-option -gq -u @station_popup_ui_expected_signature",
      "set-option -gq -u @station_popup_ui_root",
    ]);
  });

  it("falls back when the registered popup session is gone", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_TMUX_HAS_SESSION: "0",
        FAKE_TMUX_OWNER: `${process.pid}:test`,
        FAKE_TMUX_DEV_ROOT: repoRoot,
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_POPUP_FALLBACK_COMMAND: "printf fallback",
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "fallback" });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_tui_dev_owner",
      "show-options -gqv @station_tui_dev_root",
      "has-session -t _station-ui-dev",
      "show-options -gqv @station_popup_ui_session_name",
      "show-options -gqv @station_popup_ui_expected_signature",
      "show-options -gqv @station_popup_ui_root",
      "set-option -gq -u @station_popup_ui_session_name",
      "set-option -gq -u @station_popup_ui_expected_signature",
      "set-option -gq -u @station_popup_ui_root",
    ]);
  });

  it("falls back when the registered popup owner is stale", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_TMUX_OWNER: "999999999:test",
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_POPUP_FALLBACK_COMMAND: "printf fallback",
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "fallback" });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_tui_dev_owner",
      "show-options -gqv @station_tui_dev_root",
      "show-options -gqv @station_popup_ui_session_name",
      "show-options -gqv @station_popup_ui_expected_signature",
      "show-options -gqv @station_popup_ui_root",
      "set-option -gq -u @station_popup_ui_session_name",
      "set-option -gq -u @station_popup_ui_expected_signature",
      "set-option -gq -u @station_popup_ui_root",
    ]);
  });

  it("falls back and clears when normal popup registration points at another checkout", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_FAST_POPUP_EXPECTED_SIGNATURE: "v1:node other-dev tui",
        FAKE_FAST_POPUP_ROOT: "/other",
        FAKE_FAST_POPUP_SESSION_NAME: "_station-ui-dev-other",
        FAKE_TMUX_DEV_ROOT: "/other",
        FAKE_TMUX_DEV_SESSION_NAME: "_station-ui-dev-other",
        FAKE_TMUX_OWNER: `${process.pid}:test`,
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_POPUP_FALLBACK_COMMAND: "printf fallback",
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "fallback" });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_tui_dev_owner",
      "show-options -gqv @station_tui_dev_root",
      "show-options -gqv @station_popup_ui_session_name",
      "show-options -gqv @station_popup_ui_expected_signature",
      "show-options -gqv @station_popup_ui_root",
      "set-option -gq -u @station_popup_ui_session_name",
      "set-option -gq -u @station_popup_ui_expected_signature",
      "set-option -gq -u @station_popup_ui_root",
    ]);
  });

  it("falls back and clears a stale rootless normal popup registration", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_FAST_POPUP_EXPECTED_SIGNATURE: "v1:node normal tui --popup --persistent",
        FAKE_FAST_POPUP_SESSION_NAME: "_station-ui",
        FAKE_TMUX_MISSING_DEV_REGISTRATION: "1",
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_POPUP_FALLBACK_COMMAND: "printf fallback",
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "fallback" });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_popup_ui_session_name",
      "show-options -gqv @station_popup_ui_expected_signature",
      "show-options -gqv @station_popup_ui_root",
      "set-option -gq -u @station_popup_ui_session_name",
      "set-option -gq -u @station_popup_ui_expected_signature",
      "set-option -gq -u @station_popup_ui_root",
    ]);
  });

  it("falls back and clears when the normal popup signature differs", async () => {
    const fixture = await createFakeTmux();

    await expect(
      runLauncher([], {
        FAKE_FAST_POPUP_EXPECTED_SIGNATURE: "v1:node normal tui --popup --persistent",
        FAKE_FAST_POPUP_ROOT: repoRoot,
        FAKE_FAST_POPUP_SESSION_NAME: "_station-ui",
        FAKE_SESSION_SIGNATURE: "v1:node stale tui --popup --persistent",
        FAKE_TMUX_MISSING_DEV_REGISTRATION: "1",
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_LOG: fixture.logPath,
        STATION_POPUP_FALLBACK_COMMAND: "printf fallback",
        STATION_TMUX_BIN: fixture.tmuxPath,
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "fallback" });

    expect(await readLog(fixture.logPath)).toEqual([
      "show-options -gqv @station_tui_dev_session_name",
      "show-options -gqv @station_tui_dev_command",
      "show-options -gqv @station_popup_ui_session_name",
      "show-options -gqv @station_popup_ui_expected_signature",
      "show-options -gqv @station_popup_ui_root",
      "has-session -t _station-ui",
      "show-options -t _station-ui -qv @station_popup_ui_signature",
      "set-option -gq -u @station_popup_ui_session_name",
      "set-option -gq -u @station_popup_ui_expected_signature",
      "set-option -gq -u @station_popup_ui_root",
    ]);
  });
});

async function createFakeTmux(): Promise<{ logPath: string; tmuxPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "stn-tmux-popup-launcher-"));
  const tmuxPath = join(dir, "tmux");
  const logPath = join(dir, "tmux.log");
  await writeFile(logPath, "");
  await writeFile(
    tmuxPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$TMUX_LOG"
last=
for arg in "$@"; do
  last=$arg
done
case "$1" in
  show-options)
	case "$last" in
	  @station_tui_dev_session_name)
	    [ "\${FAKE_TMUX_MISSING_REGISTRATION:-}" = "1" ] || [ "\${FAKE_TMUX_MISSING_DEV_REGISTRATION:-}" = "1" ] || printf '%s\\n' "\${FAKE_TMUX_DEV_SESSION_NAME:-_station-ui-dev}"
	    ;;
	  @station_tui_dev_command)
	    [ "\${FAKE_TMUX_MISSING_REGISTRATION:-}" = "1" ] || [ "\${FAKE_TMUX_MISSING_DEV_REGISTRATION:-}" = "1" ] || printf '%s\\n' 'node tui'
	    ;;
	  @station_tui_dev_owner) printf '%s\\n' "$FAKE_TMUX_OWNER" ;;
	  @station_tui_dev_root) printf '%s\\n' "\${FAKE_TMUX_DEV_ROOT:-}" ;;
	  @station_popup_ui_session_name) printf '%s\\n' "\${FAKE_FAST_POPUP_SESSION_NAME:-}" ;;
	  @station_popup_ui_expected_signature) printf '%s\\n' "\${FAKE_FAST_POPUP_EXPECTED_SIGNATURE:-}" ;;
	  @station_popup_ui_root) printf '%s\\n' "\${FAKE_FAST_POPUP_ROOT:-}" ;;
	  @station_popup_ui_signature) printf '%s\\n' "\${FAKE_SESSION_SIGNATURE:-\${FAKE_FAST_POPUP_EXPECTED_SIGNATURE:-v1:node tui}}" ;;
	  @station_popup_client) printf '%s\\n' "\${FAKE_ACTIVE_POPUP_CLIENT:-}" ;;
	  @station_popup_focus_client) printf '%s\\n' "\${FAKE_FOCUS_POPUP_CLIENT:-}" ;;
	esac
	;;
  has-session)
    [ "\${FAKE_TMUX_HAS_SESSION:-1}" = "1" ] || exit 1
    ;;
  display-message)
    printf '%s\\n' 'client_1'
    ;;
  display-popup)
    ;;
  set-option)
    ;;
esac
`,
  );
  await chmod(tmuxPath, 0o700);
  return { logPath, tmuxPath };
}

async function readLog(path: string): Promise<string[]> {
  const log = await readFile(path, "utf8");
  return log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function runLauncher(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawn(launcherPath, args, {
    env: {
      PATH: process.env.PATH ?? "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}
