import { setTimeout as sleep } from "node:timers/promises";
import type { ExternalCommandInput } from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  buildTmuxPopupArgs,
  dismissTmuxPopup,
  ensurePersistentPopupSession,
  openTmuxPopup,
  resolveRegisteredDevPopupUi,
  resolveTmuxPopupFocusOrigin,
} from "../../src/popup";
import { tmuxCommandResult } from "../support/commands";

const defaultPersistentSignature = "v1:stn tui --popup --persistent";

describe("tmux popup", () => {
  it("builds a persistent popup command that attaches the hidden UI session", () => {
    expect(buildTmuxPopupArgs()).toEqual([
      "display-popup",
      "-w",
      "50%",
      "-h",
      "50%",
      "-E",
      "env -u TMUX tmux -T hyperlinks attach-session -t _station-ui",
    ]);
  });

  it("keeps transient TUI popup command construction available", () => {
    expect(buildTmuxPopupArgs({ persistent: false, focusClientId: "client_1" })).toEqual([
      "display-popup",
      "-c",
      "client_1",
      "-w",
      "50%",
      "-h",
      "50%",
      "-E",
      "env STATION_TUI_POPUP=1 STATION_FOCUS_PROVIDER=tmux STATION_FOCUS_CLIENT_ID=client_1 stn tui --popup",
    ]);
  });

  it("creates the persistent UI session only when it is missing", async () => {
    const calls: ExternalCommandInput[] = [];

    await expect(
      ensurePersistentPopupSession({
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "has-session") {
            throw Object.assign(new Error("can't find session"), {
              code: 1,
              stderr: "can't find session",
            });
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ sessionName: "_station-ui", created: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["has-session", "-t", "_station-ui"],
      [
        "new-session",
        "-d",
        "-s",
        "_station-ui",
        "-n",
        "station-ui",
        "env STATION_TUI_POPUP=1 STATION_FOCUS_PROVIDER=tmux stn tui --popup --persistent",
      ],
      [
        "set-option",
        "-t",
        "_station-ui",
        "-q",
        "@station_popup_ui_signature",
        defaultPersistentSignature,
      ],
      persistentPopupMouseCall("_station-ui"),
    ]);

    calls.length = 0;
    await expect(
      ensurePersistentPopupSession({
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "show-options") {
            return tmuxCommandResult(input, `${defaultPersistentSignature}\n`);
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ sessionName: "_station-ui", created: false });
    expect(calls.map((call) => call.args)).toEqual([
      ["has-session", "-t", "_station-ui"],
      ["show-options", "-t", "_station-ui", "-qv", "@station_popup_ui_signature"],
      persistentPopupMouseCall("_station-ui"),
    ]);
  });

  it("recreates the persistent UI session when its command signature changed", async () => {
    const calls: ExternalCommandInput[] = [];

    await expect(
      ensurePersistentPopupSession({
        tuiCommand: "node stn tui --popup --persistent --config /tmp/config-b.toml",
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "show-options") {
            return tmuxCommandResult(
              input,
              "v1:node stn tui --popup --persistent --config /tmp/config-a.toml\n",
            );
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ sessionName: "_station-ui", created: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["has-session", "-t", "_station-ui"],
      ["show-options", "-t", "_station-ui", "-qv", "@station_popup_ui_signature"],
      ["kill-session", "-t", "_station-ui"],
      [
        "new-session",
        "-d",
        "-s",
        "_station-ui",
        "-n",
        "station-ui",
        "env STATION_TUI_POPUP=1 STATION_FOCUS_PROVIDER=tmux node stn tui --popup --persistent --config /tmp/config-b.toml",
      ],
      [
        "set-option",
        "-t",
        "_station-ui",
        "-q",
        "@station_popup_ui_signature",
        "v1:node stn tui --popup --persistent --config /tmp/config-b.toml",
      ],
      persistentPopupMouseCall("_station-ui"),
    ]);
  });

  it("opens the popup by attaching the persistent UI session and recording tmux popup state", async () => {
    const calls: ExternalCommandInput[] = [];

    await expect(
      openTmuxPopup({
        checkoutRoot: "/worktrees/current",
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "display-message") {
            return tmuxCommandResult(input, "client_1\n");
          }
          if (
            input.args?.[0] === "show-options" &&
            input.args.includes("@station_popup_ui_signature")
          ) {
            return tmuxCommandResult(input, `${defaultPersistentSignature}\n`);
          }
          return tmuxCommandResult(input);
        },
        env: {
          TMUX: "/tmp/tmux-501/default,123,0",
        },
        config: {
          popupWidth: "90%",
          popupHeight: "80%",
          popupPosition: "C",
        },
      }),
    ).resolves.toEqual({ opened: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["display-message", "-p", "#{client_name}"],
      ["show-options", "-gqv", "@station_popup_client"],
      ["set-option", "-gq", "@station_popup_client", "client_1"],
      ["set-option", "-gq", "@station_popup_focus_client", "client_1"],
      ["has-session", "-t", "_station-ui"],
      ["show-options", "-t", "_station-ui", "-qv", "@station_popup_ui_signature"],
      persistentPopupMouseCall("_station-ui"),
      ...fastPopupRegistrationCalls(
        "_station-ui",
        "stn tui --popup --persistent",
        "/worktrees/current",
      ),
      [
        "display-popup",
        "-c",
        "client_1",
        "-w",
        "90%",
        "-h",
        "80%",
        "-E",
        expect.stringContaining("env -u TMUX tmux -T hyperlinks attach-session -t _station-ui"),
      ],
    ]);
    const displayPopupArgs = calls.at(-1)?.args;
    const popupShellCommand = displayPopupArgs?.[displayPopupArgs.length - 1];
    expect(popupShellCommand).toContain("tmux -T hyperlinks attach-session -t _station-ui");
    expect(popupShellCommand).toContain("fi; if");
    expect(popupShellCommand).not.toContain("fi if");
  });

  it("prefers a registered dev popup UI when requested", async () => {
    const calls: ExternalCommandInput[] = [];
    const devCommand =
      "env STATION_TUI_DEV=1 node /worktrees/tui-layout/scripts/tui-watch-runner.mjs /worktrees/tui-layout/apps/cli/dist/main.js tui --popup --persistent";
    const devSession = "_station-ui-dev-tui-layout-1234abcd";

    await expect(
      openTmuxPopup({
        preferRegisteredDevPopup: true,
        registeredDevPopupRoot: "/worktrees/tui-layout",
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "display-message") {
            return tmuxCommandResult(input, "client_1\n");
          }
          if (
            input.args?.[0] === "show-options" &&
            input.args.includes("@station_tui_dev_session_name")
          ) {
            return tmuxCommandResult(input, `${devSession}\n`);
          }
          if (
            input.args?.[0] === "show-options" &&
            input.args.includes("@station_tui_dev_command")
          ) {
            return tmuxCommandResult(input, `${devCommand}\n`);
          }
          if (input.args?.[0] === "show-options" && input.args.includes("@station_tui_dev_owner")) {
            return tmuxCommandResult(input, `${process.pid}:test\n`);
          }
          if (input.args?.[0] === "show-options" && input.args.includes("@station_tui_dev_root")) {
            return tmuxCommandResult(input, "/worktrees/tui-layout\n");
          }
          if (
            input.args?.[0] === "show-options" &&
            input.args.includes("@station_popup_ui_signature")
          ) {
            return tmuxCommandResult(input, `v1:${devCommand}\n`);
          }
          return tmuxCommandResult(input);
        },
        env: {
          TMUX: "/tmp/tmux-501/default,123,0",
        },
      }),
    ).resolves.toEqual({ opened: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["display-message", "-p", "#{client_name}"],
      ["show-options", "-gqv", "@station_popup_client"],
      ["set-option", "-gq", "@station_popup_client", "client_1"],
      ["set-option", "-gq", "@station_popup_focus_client", "client_1"],
      ["show-options", "-gqv", "@station_tui_dev_session_name"],
      ["show-options", "-gqv", "@station_tui_dev_command"],
      ["show-options", "-gqv", "@station_tui_dev_owner"],
      ["show-options", "-gqv", "@station_tui_dev_root"],
      ["has-session", "-t", devSession],
      ["show-options", "-t", devSession, "-qv", "@station_popup_ui_signature"],
      persistentPopupMouseCall(devSession),
      expect.arrayContaining(["display-popup", "-c", "client_1"]),
    ]);
    const displayPopupArgs = calls.at(-1)?.args;
    expect(displayPopupArgs?.at(-1)).toContain(`attach-session -t ${devSession}`);
  });

  it("resolves registered dev popup metadata only for a live owner", async () => {
    const devCommand = "env STATION_TUI_DEV=1 node /wt/scripts/tui-watch-runner.mjs /wt/apps/cli";

    await expect(
      resolveRegisteredDevPopupUi({
        runner: async (input) => {
          if (input.args?.includes("@station_tui_dev_session_name")) {
            return tmuxCommandResult(input, "_station-ui-dev-wt-1234abcd\n");
          }
          if (input.args?.includes("@station_tui_dev_command")) {
            return tmuxCommandResult(input, `${devCommand}\n`);
          }
          if (input.args?.includes("@station_tui_dev_owner")) {
            return tmuxCommandResult(input, `${process.pid}:test\n`);
          }
          if (input.args?.includes("@station_tui_dev_root")) {
            return tmuxCommandResult(input, "/wt\n");
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({
      command: devCommand,
      owner: `${process.pid}:test`,
      root: "/wt",
      sessionName: "_station-ui-dev-wt-1234abcd",
    });

    await expect(
      resolveRegisteredDevPopupUi({
        runner: async (input) => {
          if (input.args?.includes("@station_tui_dev_session_name")) {
            return tmuxCommandResult(input, "_station-ui-dev-stale-1234abcd\n");
          }
          if (input.args?.includes("@station_tui_dev_command")) {
            return tmuxCommandResult(input, `${devCommand}\n`);
          }
          if (input.args?.includes("@station_tui_dev_owner")) {
            return tmuxCommandResult(input, "999999999:test\n");
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back to the normal persistent UI when the registered dev owner is stale", async () => {
    const calls: ExternalCommandInput[] = [];
    const devCommand = "env STATION_TUI_DEV=1 node /stale/scripts/tui-watch-runner.mjs /stale/cli";

    await expect(
      openTmuxPopup({
        preferRegisteredDevPopup: true,
        tuiCommand: "node normal-station tui --popup --persistent",
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "display-message") {
            return tmuxCommandResult(input, "client_1\n");
          }
          if (input.args?.includes("@station_tui_dev_session_name")) {
            return tmuxCommandResult(input, "_station-ui-dev-stale-1234abcd\n");
          }
          if (input.args?.includes("@station_tui_dev_command")) {
            return tmuxCommandResult(input, `${devCommand}\n`);
          }
          if (input.args?.includes("@station_tui_dev_owner")) {
            return tmuxCommandResult(input, "999999999:test\n");
          }
          if (
            input.args?.[0] === "show-options" &&
            input.args.includes("@station_popup_ui_signature")
          ) {
            return tmuxCommandResult(input, "v1:node normal-station tui --popup --persistent\n");
          }
          return tmuxCommandResult(input);
        },
        env: {
          TMUX: "/tmp/tmux-501/default,123,0",
        },
      }),
    ).resolves.toEqual({ opened: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["display-message", "-p", "#{client_name}"],
      ["show-options", "-gqv", "@station_popup_client"],
      ["set-option", "-gq", "@station_popup_client", "client_1"],
      ["set-option", "-gq", "@station_popup_focus_client", "client_1"],
      ["show-options", "-gqv", "@station_tui_dev_session_name"],
      ["show-options", "-gqv", "@station_tui_dev_command"],
      ["show-options", "-gqv", "@station_tui_dev_owner"],
      ["has-session", "-t", "_station-ui"],
      ["show-options", "-t", "_station-ui", "-qv", "@station_popup_ui_signature"],
      persistentPopupMouseCall("_station-ui"),
      ...fastPopupRegistrationCalls("_station-ui", "node normal-station tui --popup --persistent"),
      expect.arrayContaining(["display-popup", "-c", "client_1"]),
    ]);
    const displayPopupArgs = calls.at(-1)?.args;
    expect(displayPopupArgs?.at(-1)).toContain("attach-session -t _station-ui");
  });

  it("falls back to the normal persistent UI when the registered dev root differs", async () => {
    const calls: ExternalCommandInput[] = [];
    const devCommand = "env STATION_TUI_DEV=1 node /other/scripts/tui-watch-runner.mjs /other/cli";

    await expect(
      openTmuxPopup({
        preferRegisteredDevPopup: true,
        registeredDevPopupRoot: "/current",
        tuiCommand: "node current-station tui --popup --persistent",
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "display-message") {
            return tmuxCommandResult(input, "client_1\n");
          }
          if (input.args?.includes("@station_tui_dev_session_name")) {
            return tmuxCommandResult(input, "_station-ui-dev-other-1234abcd\n");
          }
          if (input.args?.includes("@station_tui_dev_command")) {
            return tmuxCommandResult(input, `${devCommand}\n`);
          }
          if (input.args?.includes("@station_tui_dev_owner")) {
            return tmuxCommandResult(input, `${process.pid}:test\n`);
          }
          if (input.args?.includes("@station_tui_dev_root")) {
            return tmuxCommandResult(input, "/other\n");
          }
          if (
            input.args?.[0] === "show-options" &&
            input.args.includes("@station_popup_ui_signature")
          ) {
            return tmuxCommandResult(input, "v1:node current-station tui --popup --persistent\n");
          }
          return tmuxCommandResult(input);
        },
        env: {
          TMUX: "/tmp/tmux-501/default,123,0",
        },
      }),
    ).resolves.toEqual({ opened: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["display-message", "-p", "#{client_name}"],
      ["show-options", "-gqv", "@station_popup_client"],
      ["set-option", "-gq", "@station_popup_client", "client_1"],
      ["set-option", "-gq", "@station_popup_focus_client", "client_1"],
      ["show-options", "-gqv", "@station_tui_dev_session_name"],
      ["show-options", "-gqv", "@station_tui_dev_command"],
      ["show-options", "-gqv", "@station_tui_dev_owner"],
      ["show-options", "-gqv", "@station_tui_dev_root"],
      ["has-session", "-t", "_station-ui"],
      ["show-options", "-t", "_station-ui", "-qv", "@station_popup_ui_signature"],
      persistentPopupMouseCall("_station-ui"),
      ...fastPopupRegistrationCalls(
        "_station-ui",
        "node current-station tui --popup --persistent",
        "/current",
      ),
      expect.arrayContaining(["display-popup", "-c", "client_1"]),
    ]);
  });

  it("closes an active popup for the current client without killing the UI session", async () => {
    const calls: ExternalCommandInput[] = [];

    await expect(
      openTmuxPopup({
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "display-message") {
            return tmuxCommandResult(input, "client_1\n");
          }
          if (input.args?.[0] === "show-options") {
            return tmuxCommandResult(input, "client_1\n");
          }
          return tmuxCommandResult(input);
        },
        env: {
          TMUX: "/tmp/tmux-501/default,123,0",
        },
      }),
    ).resolves.toEqual({ opened: false, closed: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["display-message", "-p", "#{client_name}"],
      ["show-options", "-gqv", "@station_popup_client"],
      ["display-popup", "-c", "client_1", "-C"],
      ["set-option", "-gq", "-u", "@station_popup_client"],
      ["set-option", "-gq", "-u", "@station_popup_focus_client"],
    ]);
    expect(calls.some((call) => call.args?.[0] === "kill-session")).toBe(false);
    expect(calls.some((call) => call.args?.[0] === "new-session")).toBe(false);
  });

  it("closes a popup active for another client before opening a new one", async () => {
    const calls: ExternalCommandInput[] = [];

    await expect(
      openTmuxPopup({
        env: {
          STATION_FOCUS_CLIENT_ID: "client_2",
        },
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "show-options" && input.args.includes("@station_popup_client")) {
            return tmuxCommandResult(input, "client_1\n");
          }
          if (
            input.args?.[0] === "show-options" &&
            input.args.includes("@station_popup_ui_signature")
          ) {
            return tmuxCommandResult(input, `${defaultPersistentSignature}\n`);
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ opened: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["show-options", "-gqv", "@station_popup_client"],
      ["display-popup", "-c", "client_1", "-C"],
      ["set-option", "-gq", "@station_popup_client", "client_2"],
      ["set-option", "-gq", "@station_popup_focus_client", "client_2"],
      ["has-session", "-t", "_station-ui"],
      ["show-options", "-t", "_station-ui", "-qv", "@station_popup_ui_signature"],
      persistentPopupMouseCall("_station-ui"),
      ...fastPopupRegistrationCalls("_station-ui", "stn tui --popup --persistent"),
      expect.arrayContaining(["display-popup", "-c", "client_2"]),
    ]);
  });

  it("resolves the focus origin from the current tmux popup client option", async () => {
    await expect(
      resolveTmuxPopupFocusOrigin({
        runner: async (input) => tmuxCommandResult(input, "client_2\n"),
      }),
    ).resolves.toEqual({
      provider: "tmux",
      clientId: "client_2",
    });
  });

  it("dismisses the popup for the recorded focus client", async () => {
    const calls: ExternalCommandInput[] = [];

    await expect(
      dismissTmuxPopup({
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "show-options") {
            return tmuxCommandResult(input, "client_2\n");
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ dismissed: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["show-options", "-gqv", "@station_popup_focus_client"],
      ["display-popup", "-c", "client_2", "-C"],
      ["set-option", "-gq", "-u", "@station_popup_client"],
      ["set-option", "-gq", "-u", "@station_popup_focus_client"],
    ]);
  });

  it("does not time out while the interactive popup is still open", async () => {
    await expect(
      openTmuxPopup({
        timeoutMs: 1,
        env: {},
        runner: async (input) => {
          if (input.args?.[0] === "display-popup") {
            await sleep(10);
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ opened: true });
  });

  it("treats a user-dismissed popup as opened and clears recorded popup state", async () => {
    const calls: ExternalCommandInput[] = [];

    await expect(
      openTmuxPopup({
        env: {
          TMUX: "/tmp/tmux-501/default,123,0",
        },
        runner: async (input) => {
          calls.push(input);
          if (input.args?.[0] === "display-message") {
            return tmuxCommandResult(input, "client_1\n");
          }
          if (
            input.args?.[0] === "show-options" &&
            input.args.includes("@station_popup_ui_signature")
          ) {
            return tmuxCommandResult(input, `${defaultPersistentSignature}\n`);
          }
          if (input.args?.[0] === "display-popup") {
            throw Object.assign(new Error("popup dismissed"), {
              exitCode: 129,
              stderr: "",
              stdout: "",
            });
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ opened: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["display-message", "-p", "#{client_name}"],
      ["show-options", "-gqv", "@station_popup_client"],
      ["set-option", "-gq", "@station_popup_client", "client_1"],
      ["set-option", "-gq", "@station_popup_focus_client", "client_1"],
      ["has-session", "-t", "_station-ui"],
      ["show-options", "-t", "_station-ui", "-qv", "@station_popup_ui_signature"],
      persistentPopupMouseCall("_station-ui"),
      ...fastPopupRegistrationCalls("_station-ui", "stn tui --popup --persistent"),
      expect.arrayContaining(["display-popup", "-c", "client_1"]),
      ["set-option", "-gq", "-u", "@station_popup_client"],
      ["set-option", "-gq", "-u", "@station_popup_focus_client"],
    ]);
  });

  it("reports popup failures with the provider-specific message", async () => {
    await expect(
      openTmuxPopup({
        env: {},
        runner: async (input) => {
          if (input.args?.[0] === "display-popup") {
            throw Object.assign(new Error("tmux failed"), {
              code: 1,
              stderr: "display-popup failed",
            });
          }
          return tmuxCommandResult(input);
        },
      }),
    ).rejects.toMatchObject({
      code: "TERMINAL_OPEN_FAILED",
      message: "tmux failed to open the station popup.",
      provider: "tmux",
    });
  });

  it("enters the workbench before opening when requested", async () => {
    const calls: ExternalCommandInput[] = [];

    await expect(
      openTmuxPopup({
        enterWorkbench: true,
        env: {
          STATION_FOCUS_CLIENT_ID: "client_from_binding",
        },
        runner: async (input) => {
          calls.push(input);
          if (
            input.args?.[0] === "show-options" &&
            input.args.includes("@station_popup_ui_signature")
          ) {
            return tmuxCommandResult(input, `${defaultPersistentSignature}\n`);
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ opened: true });

    expect(calls.map((call) => call.args)).toEqual([
      ["show-options", "-gqv", "@station_popup_client"],
      ["set-option", "-gq", "@station_popup_client", "client_from_binding"],
      ["set-option", "-gq", "@station_popup_focus_client", "client_from_binding"],
      ["has-session", "-t", "station"],
      ["set-option", "-t", "station", "mouse", "on"],
      ["set-option", "-t", "station", "history-limit", "100000"],
      ["set-option", "-t", "station", "set-clipboard", "on"],
      [
        "list-panes",
        "-s",
        "-t",
        "station",
        "-F",
        "#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@station.role}",
      ],
      ["list-windows", "-t", "station", "-F", "#{window_id}"],
      ["switch-client", "-c", "client_from_binding", "-t", "station"],
      ["has-session", "-t", "_station-ui"],
      ["show-options", "-t", "_station-ui", "-qv", "@station_popup_ui_signature"],
      persistentPopupMouseCall("_station-ui"),
      ...fastPopupRegistrationCalls("_station-ui", "stn tui --popup --persistent"),
      expect.arrayContaining(["display-popup", "-c", "client_from_binding"]),
    ]);
  });
});

function fastPopupRegistrationCalls(
  sessionName: string,
  command: string,
  root?: string,
): string[][] {
  const calls = [
    ["set-option", "-gq", "@station_popup_ui_session_name", sessionName],
    ["set-option", "-gq", "@station_popup_ui_expected_signature", `v1:${command}`],
  ];
  if (root !== undefined) {
    calls.push(["set-option", "-gq", "@station_popup_ui_root", root]);
  }
  return calls;
}

function persistentPopupMouseCall(sessionName: string): string[] {
  return ["set-option", "-t", sessionName, "mouse", "on"];
}
