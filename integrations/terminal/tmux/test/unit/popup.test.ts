import { setTimeout as sleep } from "node:timers/promises";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  buildTmuxPopupArgs,
  dismissTmuxPopup,
  ensurePersistentPopupSession,
  openTmuxPopup,
  resolveRegisteredDevPopupUi,
  resolveTmuxPopupFocusOrigin,
} from "../../src/popup";
import { buildNormalPopupRoute, buildPopupActiveClaim } from "../../src/popup/fastProtocol";
import { tmuxCommandResult } from "../support/commands";

const defaultCommand = "stn tui --popup --persistent";
const defaultSignature = `v1:${defaultCommand}`;
const registrationNonce = "11".repeat(16);
const actionNonce = "22".repeat(16);

describe("tmux popup", () => {
  it("builds persistent and transient popup commands", () => {
    expect(buildTmuxPopupArgs()).toEqual([
      "display-popup",
      "-w",
      "50%",
      "-h",
      "50%",
      "-E",
      "env -u TMUX tmux -T hyperlinks attach-session -t _station-ui",
    ]);
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

  it("creates, reuses, and replaces the persistent UI by exact signature", async () => {
    const missingCalls: ExternalCommandInput[] = [];
    await expect(
      ensurePersistentPopupSession({
        runner: async (input) => {
          missingCalls.push(input);
          if (input.args?.[0] === "has-session") {
            throw Object.assign(new Error("missing"), { code: 1 });
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ created: true, sessionName: "_station-ui" });
    expect(missingCalls.map((call) => call.args)).toEqual([
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
      ["set-option", "-t", "_station-ui", "-q", "@station_popup_ui_signature", defaultSignature],
      popupMouseCall,
    ]);

    const reusedCalls: ExternalCommandInput[] = [];
    await expect(
      ensurePersistentPopupSession({
        runner: async (input) => {
          reusedCalls.push(input);
          if (input.args?.includes("@station_popup_ui_signature")) {
            return tmuxCommandResult(input, `${defaultSignature}\n`);
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ created: false, sessionName: "_station-ui" });
    expect(reusedCalls.map((call) => call.args)).toEqual([
      ["has-session", "-t", "_station-ui"],
      ["show-options", "-t", "_station-ui", "-qv", "@station_popup_ui_signature"],
      popupMouseCall,
    ]);

    const replacedCalls: ExternalCommandInput[] = [];
    await expect(
      ensurePersistentPopupSession({
        tuiCommand: "node current tui --popup --persistent",
        runner: async (input) => {
          replacedCalls.push(input);
          if (input.args?.includes("@station_popup_ui_signature")) {
            return tmuxCommandResult(input, "v1:node stale tui --popup --persistent\n");
          }
          return tmuxCommandResult(input);
        },
      }),
    ).resolves.toEqual({ created: true, sessionName: "_station-ui" });
    expect(replacedCalls.map((call) => call.args)).toContainEqual([
      "kill-session",
      "-t",
      "_station-ui",
    ]);
  });

  it("registers lease and mirrors before committing the route, then opens with a claim", async () => {
    const fake = createPopupTmux({ root: "/opt/station/bin" });
    await expect(
      openTmuxPopup({
        checkoutRoot: fake.root,
        config: { popupHeight: "80%", popupPosition: "C", popupWidth: "90%" },
        env: { TMUX: "/tmp/tmux/default,1,0" },
        runner: fake.runner,
      }),
    ).resolves.toEqual({ opened: true });

    const leaseIndex = fake.indexOfSet("@station_popup_ui_lease");
    const sessionMirrorIndex = fake.indexOfSet("@station_popup_ui_session_name");
    const signatureMirrorIndex = fake.indexOfSet("@station_popup_ui_expected_signature");
    const rootMirrorIndex = fake.indexOfSet("@station_popup_ui_root");
    const routeCommitIndex = fake.calls.findIndex(
      (call) => call.args?.[0] === "if-shell" && call.args.at(-1)?.includes("popup_ui_route"),
    );
    const claimIndex = fake.calls.findIndex(
      (call) =>
        call.args?.[0] === "if-shell" &&
        call.args.some((arg) => arg.includes("@station_popup_active_claim v1.open.")),
    );
    expect(leaseIndex).toBeGreaterThan(-1);
    expect(leaseIndex).toBeLessThan(sessionMirrorIndex);
    expect(sessionMirrorIndex).toBeLessThan(signatureMirrorIndex);
    expect(signatureMirrorIndex).toBeLessThan(rootMirrorIndex);
    expect(rootMirrorIndex).toBeLessThan(routeCommitIndex);
    expect(routeCommitIndex).toBeLessThan(claimIndex);

    const display = fake.calls.findLast(claimedPopupAction);
    expect(display?.args?.[3]).toContain("display-popup -c /dev/ttys001 -w 90% -h 80% -E");
    expect(display?.args?.[3]).toContain("@station_popup_active_claim");
    expect(fake.globalOptions.get("@station_popup_active_claim")).toMatch(/^v1\.open\./);
  });

  it("reuses a valid route and transitions a same-client claim to closing without replacing UI", async () => {
    const fake = createPopupTmux({ activeClaim: true, registered: true, root: "/opt/station/bin" });
    await expect(
      openTmuxPopup({
        checkoutRoot: fake.root,
        env: { TMUX: "/tmp/tmux/default,1,0" },
        runner: fake.runner,
      }),
    ).resolves.toEqual({ closed: true, opened: false });

    expect(
      fake.executedPopupActions.some((action) =>
        action.includes("display-popup -c /dev/ttys001 -C"),
      ),
    ).toBe(true);
    expect(fake.calls.some((call) => call.args?.[0] === "kill-session")).toBe(false);
    expect(fake.calls.some((call) => call.args?.[0] === "new-session")).toBe(false);
    const claimWrites = fake.claimWrites();
    expect(claimWrites).toHaveLength(1);
    expect(claimWrites[0]).toMatch(/^v1\.closing\./);
    expect(fake.globalOptions.has("@station_popup_active_claim")).toBe(false);
  });

  it("migrates a same-client legacy toggle through an exact closing claim", async () => {
    const fake = createPopupTmux({ registered: true, root: "/opt/station/bin" });
    fake.globalOptions.set("@station_popup_client", "/dev/ttys001");
    fake.globalOptions.set("@station_popup_focus_client", "/dev/ttys001");

    await expect(
      openTmuxPopup({
        checkoutRoot: fake.root,
        env: { TMUX: "/tmp/tmux/default,1,0" },
        runner: fake.runner,
      }),
    ).resolves.toEqual({ closed: true, opened: false });

    expect(fake.claimWrites()).toEqual([expect.stringMatching(/^v1\.closing\./)]);
    expect(
      fake.executedPopupActions.some((action) =>
        action.includes("display-popup -c /dev/ttys001 -C"),
      ),
    ).toBe(true);
    expect(fake.globalOptions.has("@station_popup_active_claim")).toBe(false);
  });

  it("replaces the claim before closing a cross-client popup", async () => {
    const fake = createPopupTmux({
      activeClaim: true,
      clientName: "/dev/ttys002",
      clientPid: 5678,
      registered: true,
      root: "/opt/station/bin",
    });
    await expect(
      openTmuxPopup({
        checkoutRoot: fake.root,
        env: { TMUX: "/tmp/tmux/default,1,0" },
        runner: fake.runner,
      }),
    ).resolves.toEqual({ opened: true });

    const claimWriteIndex = fake.calls.findIndex((call) =>
      call.args?.at(-1)?.includes("@station_popup_active_claim v1.open."),
    );
    const closeIndex = fake.calls.findIndex((call) =>
      call.args?.[3]?.includes("display-popup -c /dev/ttys001 -C"),
    );
    expect(claimWriteIndex).toBeLessThan(closeIndex);
    expect(fake.executedPopupActions.at(-1)).toContain("display-popup -c /dev/ttys001 -C");
  });

  it("uses a valid claim for focus origin and falls back to the compatibility mirror", async () => {
    const claimed = createPopupTmux({ activeClaim: true, registered: true });
    await expect(resolveTmuxPopupFocusOrigin({ runner: claimed.runner })).resolves.toEqual({
      clientId: "/dev/ttys001",
      provider: "tmux",
    });

    const legacy = createPopupTmux();
    legacy.globalOptions.set("@station_popup_focus_client", "legacy-client");
    await expect(resolveTmuxPopupFocusOrigin({ runner: legacy.runner })).resolves.toEqual({
      clientId: "legacy-client",
      provider: "tmux",
    });
  });

  it("dismisses through a closing claim and exact compare-clear", async () => {
    const fake = createPopupTmux({ activeClaim: true, registered: true });
    await expect(dismissTmuxPopup({ runner: fake.runner })).resolves.toEqual({ dismissed: true });
    expect(fake.claimWrites()).toEqual([expect.stringMatching(/^v1\.closing\./)]);
    expect(
      fake.executedPopupActions.some((action) =>
        action.includes("display-popup -c /dev/ttys001 -C"),
      ),
    ).toBe(true);
    expect(fake.globalOptions.has("@station_popup_active_claim")).toBe(false);
  });

  it("does not let delayed cleanup erase a replacement claim", async () => {
    const replacement = buildPopupActiveClaim({
      actionNonce: "44".repeat(16),
      clientName: "/dev/ttys099",
      clientPid: 9999,
      registrationNonce,
      state: "open",
    });
    const fake = createPopupTmux({
      displayExit: 129,
      replaceClaimBeforeCleanup: replacement,
      root: "/opt/station/bin",
    });
    await expect(
      openTmuxPopup({
        checkoutRoot: fake.root,
        env: { TMUX: "/tmp/tmux/default,1,0" },
        runner: fake.runner,
      }),
    ).resolves.toEqual({ opened: true });
    expect(fake.globalOptions.get("@station_popup_active_claim")).toBe(replacement);
    expect(fake.globalOptions.get("@station_popup_client")).toBe("/dev/ttys099");
  });

  it("does not display after a newer caller replaces its claim", async () => {
    const replacement = buildPopupActiveClaim({
      actionNonce: "99".repeat(16),
      clientName: "/dev/ttys099",
      clientPid: 9999,
      registrationNonce,
      state: "open",
    });
    const fake = createPopupTmux({
      replaceClaimBeforeDisplay: replacement,
      root: "/opt/station/bin",
    });

    await expect(
      openTmuxPopup({
        checkoutRoot: fake.root,
        env: { TMUX: "/tmp/tmux/default,1,0" },
        runner: fake.runner,
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_OPEN_FAILED" });

    expect(fake.executedPopupActions).toEqual([]);
    expect(fake.globalOptions.get("@station_popup_active_claim")).toBe(replacement);
  });

  it("does not display from the compatibility path after a claimed caller wins", async () => {
    const replacement = buildPopupActiveClaim({
      actionNonce: "98".repeat(16),
      clientName: "/dev/ttys099",
      clientPid: 9999,
      registrationNonce,
      state: "open",
    });
    const fake = createPopupTmux({ replaceClaimBeforeDisplay: replacement });

    await expect(
      openTmuxPopup({
        env: { STATION_FOCUS_CLIENT_ID: "/dev/ttys001" },
        runner: fake.runner,
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_OPEN_FAILED" });

    expect(fake.executedPopupActions).toEqual([]);
    expect(fake.globalOptions.get("@station_popup_active_claim")).toBe(replacement);
  });

  it("does not let legacy cleanup or dismiss contention erase a replacement owner", async () => {
    const replacement = buildPopupActiveClaim({
      actionNonce: "44".repeat(16),
      clientName: "/dev/ttys099",
      clientPid: 9999,
      registrationNonce,
      state: "open",
    });
    const legacy = createPopupTmux({
      displayExit: 129,
      replaceClaimBeforeLegacyAction: replacement,
    });
    await expect(
      openTmuxPopup({
        env: { STATION_FOCUS_CLIENT_ID: "/dev/ttys001" },
        runner: legacy.runner,
      }),
    ).resolves.toEqual({ opened: true });
    expect(legacy.globalOptions.get("@station_popup_active_claim")).toBe(replacement);
    expect(legacy.globalOptions.get("@station_popup_client")).toBe("/dev/ttys099");

    const contended = createPopupTmux({ activeClaim: true, claimCasMisses: 2 });
    await expect(dismissTmuxPopup({ runner: contended.runner })).resolves.toEqual({
      dismissed: false,
    });
    expect(contended.calls.some((call) => call.args?.[0] === "display-popup")).toBe(false);
    expect(contended.globalOptions.has("@station_popup_active_claim")).toBe(true);
  });

  it("CAS-replaces malformed route state without an unconditional clear", async () => {
    const replacementRoute = buildNormalPopupRoute({
      registrationNonce: "55".repeat(16),
      root: "/other/root",
      sessionName: "_station-ui",
      signature: defaultSignature,
    });
    const fake = createPopupTmux({
      concurrentRouteBeforeCommit: replacementRoute,
      malformedRoute: "hostile#,}route",
      root: "/opt/station/bin",
    });
    await openTmuxPopup({
      checkoutRoot: fake.root,
      env: {},
      runner: fake.runner,
    });
    expect(
      fake.calls.some(
        (call) =>
          call.args?.[0] === "set-option" &&
          call.args.includes("-u") &&
          call.args.includes("@station_popup_ui_route"),
      ),
    ).toBe(false);
    expect(fake.globalOptions.get("@station_popup_ui_route")).toBe(replacementRoute);
  });

  it("prefers only a live same-root dev UI and rejects stale or wrong-root registrations", async () => {
    const fake = createPopupTmux({
      devCommand: "node dev-ui tui --popup --persistent",
      devOwner: `${process.pid}:test`,
      devRoot: "/worktree",
      devSession: "_station-ui-dev",
      root: "/worktree",
    });
    fake.sessionSignatures.set("_station-ui-dev", `v1:${fake.devCommand}`);
    await expect(
      openTmuxPopup({
        env: { TMUX: "/tmp/tmux/default,1,0" },
        preferRegisteredDevPopup: true,
        registeredDevPopupRoot: "/worktree",
        runner: fake.runner,
      }),
    ).resolves.toEqual({ opened: true });
    expect(fake.calls.findLast(claimedPopupAction)?.args?.[3]).toContain(
      "attach-session -t _station-ui-dev",
    );

    await expect(resolveRegisteredDevPopupUi({ runner: fake.runner })).resolves.toMatchObject({
      command: fake.devCommand,
      root: "/worktree",
      sessionName: "_station-ui-dev",
    });

    const stale = createPopupTmux({
      devCommand: "node stale-ui tui --popup --persistent",
      devOwner: "999999999:test",
      devRoot: "/worktree",
      devSession: "_station-ui-dev-stale",
      root: "/worktree",
    });
    stale.sessionSignatures.set("_station-ui-dev-stale", `v1:${stale.devCommand}`);
    await openTmuxPopup({
      env: { TMUX: "/tmp/tmux/default,1,0" },
      preferRegisteredDevPopup: true,
      registeredDevPopupRoot: "/worktree",
      runner: stale.runner,
    });
    expect(stale.calls.findLast(claimedPopupAction)?.args?.[3]).toContain(
      "attach-session -t _station-ui",
    );

    const wrongRoot = createPopupTmux({
      devCommand: "node other-ui tui --popup --persistent",
      devOwner: `${process.pid}:test`,
      devRoot: "/other",
      devSession: "_station-ui-dev-other",
      root: "/worktree",
    });
    wrongRoot.sessionSignatures.set("_station-ui-dev-other", `v1:${wrongRoot.devCommand}`);
    await openTmuxPopup({
      env: { TMUX: "/tmp/tmux/default,1,0" },
      preferRegisteredDevPopup: true,
      registeredDevPopupRoot: "/worktree",
      runner: wrongRoot.runner,
    });
    expect(wrongRoot.calls.findLast(claimedPopupAction)?.args?.[3]).toContain(
      "attach-session -t _station-ui",
    );
  });

  it("enters the workbench before displaying the popup", async () => {
    const fake = createPopupTmux({ root: "/opt/station/bin" });
    await openTmuxPopup({
      checkoutRoot: fake.root,
      enterWorkbench: true,
      env: { TMUX: "/tmp/tmux/default,1,0" },
      runner: fake.runner,
    });
    const switchIndex = fake.calls.findIndex((call) => call.args?.[0] === "switch-client");
    const displayIndex = fake.calls.findIndex(claimedPopupAction);
    expect(fake.calls[switchIndex]?.args).toEqual([
      "switch-client",
      "-c",
      "/dev/ttys001",
      "-t",
      "station",
    ]);
    expect(switchIndex).toBeLessThan(displayIndex);
  });

  it("guards compatibility open and legacy focus cleanup against claims", async () => {
    for (const claim of ["valid", "malformed"] as const) {
      const fake = createPopupTmux({ activeClaim: claim === "valid" });
      if (claim === "malformed") {
        fake.globalOptions.set("@station_popup_active_claim", "future.claim.format");
      }
      await expect(
        openTmuxPopup({
          env: { STATION_FOCUS_CLIENT_ID: "/dev/ttys001" },
          runner: fake.runner,
        }),
      ).rejects.toMatchObject({ code: "TERMINAL_OPEN_FAILED" });
      expect(
        fake.calls.some(
          (call) => call.args?.[0] === "set-option" && call.args.includes("@station_popup_client"),
        ),
      ).toBe(false);
      expect(fake.calls.some((call) => call.args?.includes("-C"))).toBe(false);
    }

    const legacy = createPopupTmux();
    legacy.globalOptions.set("@station_popup_focus_client", "/dev/ttys001");
    await openTmuxPopup({ env: {}, runner: legacy.runner });
    expect(legacy.globalOptions.has("@station_popup_focus_client")).toBe(false);
  });

  it("handles interactive duration, exit 129, and provider errors", async () => {
    await expect(
      openTmuxPopup({
        env: {},
        runner: async (input) => {
          if (input.args?.[0] === "display-popup") await sleep(10);
          if (input.args?.includes("@station_popup_ui_signature")) {
            return tmuxCommandResult(input, `${defaultSignature}\n`);
          }
          return tmuxCommandResult(input);
        },
        timeoutMs: 1,
      }),
    ).resolves.toEqual({ opened: true });

    const dismissed = createPopupTmux({ displayExit: 129, root: "/opt/station/bin" });
    await expect(
      openTmuxPopup({
        checkoutRoot: dismissed.root,
        env: { TMUX: "/tmp/tmux/default,1,0" },
        runner: dismissed.runner,
      }),
    ).resolves.toEqual({ opened: true });

    await expect(
      openTmuxPopup({
        env: {},
        runner: async (input) => {
          if (input.args?.[0] === "display-popup") {
            throw Object.assign(new Error("failed"), { code: 1, stderr: "display failed" });
          }
          if (input.args?.includes("@station_popup_ui_signature")) {
            return tmuxCommandResult(input, `${defaultSignature}\n`);
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
});

const popupMouseCall = ["set-option", "-t", "_station-ui", "mouse", "on"];

type PopupFakeOptions = {
  activeClaim?: boolean;
  claimCasMisses?: number;
  clientName?: string;
  clientPid?: number;
  concurrentRouteBeforeCommit?: string;
  devCommand?: string;
  devOwner?: string;
  devRoot?: string;
  devSession?: string;
  displayExit?: number;
  malformedRoute?: string;
  registered?: boolean;
  replaceClaimBeforeCleanup?: string;
  replaceClaimBeforeDisplay?: string;
  replaceClaimBeforeLegacyAction?: string;
  root?: string;
};

function createPopupTmux(options: PopupFakeOptions = {}) {
  const calls: ExternalCommandInput[] = [];
  const executedPopupActions: string[] = [];
  const root = options.root ?? "/opt/station/bin";
  const clientName = options.clientName ?? "/dev/ttys001";
  const clientPid = options.clientPid ?? 1234;
  const route = buildNormalPopupRoute({
    registrationNonce,
    root,
    sessionName: "_station-ui",
    signature: defaultSignature,
  });
  const globalOptions = new Map<string, string>();
  const sessionOptions = new Map<string, string>();
  const sessionSignatures = new Map([["_station-ui", defaultSignature]]);
  if (options.registered === true) {
    globalOptions.set("@station_popup_ui_route", route);
    globalOptions.set("@station_popup_ui_session_name", "_station-ui");
    globalOptions.set("@station_popup_ui_expected_signature", defaultSignature);
    globalOptions.set("@station_popup_ui_root", root);
    sessionOptions.set("@station_popup_ui_lease", route);
  }
  if (options.malformedRoute !== undefined) {
    globalOptions.set("@station_popup_ui_route", options.malformedRoute);
  }
  if (options.activeClaim === true) {
    const claim = buildPopupActiveClaim({
      actionNonce,
      clientName: "/dev/ttys001",
      clientPid: 1234,
      registrationNonce,
      state: "open",
    });
    globalOptions.set("@station_popup_active_claim", claim);
    globalOptions.set("@station_popup_client", "/dev/ttys001");
    globalOptions.set("@station_popup_focus_client", "/dev/ttys001");
  }
  if (options.devSession !== undefined) {
    globalOptions.set("@station_tui_dev_session_name", options.devSession);
  }
  if (options.devCommand !== undefined) {
    globalOptions.set("@station_tui_dev_command", options.devCommand);
  }
  if (options.devOwner !== undefined) {
    globalOptions.set("@station_tui_dev_owner", options.devOwner);
  }
  if (options.devRoot !== undefined) {
    globalOptions.set("@station_tui_dev_root", options.devRoot);
  }

  let concurrentRoutePending = options.concurrentRouteBeforeCommit;
  let replacementPending = options.replaceClaimBeforeCleanup;
  let displayReplacementPending = options.replaceClaimBeforeDisplay;
  let legacyReplacementPending = options.replaceClaimBeforeLegacyAction;
  let claimCasMisses = options.claimCasMisses ?? 0;

  const runner = async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
    calls.push(input);
    const args = input.args ?? [];
    if (
      args[0] === "display-message" &&
      args.includes("#{client_pid}\t#{client_name}\t#{client_session}")
    ) {
      return tmuxCommandResult(input, `${clientPid}\t${clientName}\touter\n`);
    }
    if (args[0] === "display-message" && args.includes("#{client_name}")) {
      return tmuxCommandResult(input, `${clientName}\n`);
    }
    if (args[0] === "has-session") {
      return tmuxCommandResult(input);
    }
    if (args[0] === "show-options") {
      const optionName = args.at(-1) ?? "";
      if (optionName === "@station_popup_ui_signature") {
        return tmuxCommandResult(input, `${sessionSignatures.get(args[2] ?? "") ?? ""}\n`);
      }
      const value = args.includes("-gqv")
        ? globalOptions.get(optionName)
        : sessionOptions.get(optionName);
      return tmuxCommandResult(input, value === undefined ? "" : `${value}\n`);
    }
    if (args[0] === "set-option") {
      applySetOption(args, globalOptions, sessionOptions, sessionSignatures);
      return tmuxCommandResult(input);
    }
    if (args[0] === "if-shell") {
      const condition = args[args.indexOf("-t") >= 0 ? 4 : 2] ?? "";
      const command = args[args.indexOf("-t") >= 0 ? 5 : 3] ?? "";
      if (command.includes("display-popup") && displayReplacementPending !== undefined) {
        globalOptions.set("@station_popup_active_claim", displayReplacementPending);
        globalOptions.set("@station_popup_client", "/dev/ttys099");
        globalOptions.set("@station_popup_focus_client", "/dev/ttys099");
        displayReplacementPending = undefined;
        const expected = extractComparedValue(condition, "@station_popup_active_claim");
        if ((globalOptions.get("@station_popup_active_claim") ?? "") !== expected) {
          return tmuxCommandResult(input, "STATION_POPUP_CAS_MISS\n");
        }
      }
      if (command.includes("@station_popup_ui_route")) {
        if (concurrentRoutePending !== undefined) {
          globalOptions.set("@station_popup_ui_route", concurrentRoutePending);
          concurrentRoutePending = undefined;
        }
        const expected = condition.includes("hostile###,##}route")
          ? "hostile#,}route"
          : extractComparedValue(condition, "@station_popup_ui_route");
        if ((globalOptions.get("@station_popup_ui_route") ?? "") === expected) {
          setFromTmuxCommand(command, globalOptions);
        }
        return tmuxCommandResult(input);
      }
      if (command.startsWith("set-option -gq @station_popup_active_claim")) {
        if (claimCasMisses > 0) {
          claimCasMisses -= 1;
          return tmuxCommandResult(input);
        }
        const expected = extractComparedValue(condition, "@station_popup_active_claim");
        if ((globalOptions.get("@station_popup_active_claim") ?? "") === expected) {
          setFromTmuxCommand(command, globalOptions);
        }
        return tmuxCommandResult(input);
      }
      if (command.startsWith("set-option -gq -u @station_popup_active_claim")) {
        if (replacementPending !== undefined) {
          globalOptions.set("@station_popup_active_claim", replacementPending);
          globalOptions.set("@station_popup_client", "/dev/ttys099");
          globalOptions.set("@station_popup_focus_client", "/dev/ttys099");
          replacementPending = undefined;
        }
        const expected = extractComparedValue(condition, "@station_popup_active_claim");
        if (globalOptions.get("@station_popup_active_claim") === expected) {
          globalOptions.delete("@station_popup_active_claim");
          const client = extractComparedValue(command, "@station_popup_client");
          if (globalOptions.get("@station_popup_client") === client) {
            globalOptions.delete("@station_popup_client");
          }
          if (globalOptions.get("@station_popup_focus_client") === client) {
            globalOptions.delete("@station_popup_focus_client");
          }
        }
        return tmuxCommandResult(input);
      }
      if (condition.includes("@station_popup_active_claim") && command.includes("display-popup")) {
        const expected = extractComparedValue(condition, "@station_popup_active_claim");
        if ((globalOptions.get("@station_popup_active_claim") ?? "") !== expected) {
          return tmuxCommandResult(input, "STATION_POPUP_CAS_MISS\n");
        }
        for (const optionName of ["@station_popup_client", "@station_popup_focus_client"]) {
          const value = new RegExp(`set-option -gq ${optionName} ([^ ;]+)`).exec(command)?.[1];
          if (value !== undefined) globalOptions.set(optionName, value);
        }
        executedPopupActions.push(command);
        if (options.displayExit !== undefined && !command.trimEnd().endsWith(" -C")) {
          return { ...tmuxCommandResult(input), exitCode: options.displayExit };
        }
        return tmuxCommandResult(input);
      }
      if (args.at(-1) === "display-message -p STATION_POPUP_CAS_MISS") {
        if (legacyReplacementPending !== undefined && command.includes(" -u ")) {
          globalOptions.set("@station_popup_active_claim", legacyReplacementPending);
          globalOptions.set("@station_popup_client", "/dev/ttys099");
          globalOptions.set("@station_popup_focus_client", "/dev/ttys099");
          legacyReplacementPending = undefined;
        }
        const claimAbsent = !globalOptions.has("@station_popup_active_claim");
        const hasActiveComparison = condition.includes("#{==:#{@station_popup_client},");
        const hasFocusComparison = condition.includes("#{==:#{@station_popup_focus_client},");
        const activeClient = extractComparedValue(condition, "@station_popup_client");
        const focusClient = extractComparedValue(condition, "@station_popup_focus_client");
        const activeMatches =
          hasActiveComparison &&
          (globalOptions.get("@station_popup_client") ?? "") === activeClient;
        const focusMatches =
          hasFocusComparison &&
          (globalOptions.get("@station_popup_focus_client") ?? "") === focusClient;
        if (!claimAbsent || (!activeMatches && !focusMatches)) {
          return tmuxCommandResult(input, "STATION_POPUP_CAS_MISS\n");
        }
        if (activeMatches && command.includes(`-u @station_popup_client`)) {
          globalOptions.delete("@station_popup_client");
        }
        if (focusMatches && command.includes(`-u @station_popup_focus_client`)) {
          globalOptions.delete("@station_popup_focus_client");
        }
        const nextActive = /set-option -gq @station_popup_client ([^ ;]+)/.exec(command)?.[1];
        const nextFocus = /set-option -gq @station_popup_focus_client ([^ ;]+)/.exec(command)?.[1];
        if (nextActive !== undefined) {
          globalOptions.set("@station_popup_client", nextActive);
        }
        if (nextFocus !== undefined) {
          globalOptions.set("@station_popup_focus_client", nextFocus);
        }
        return tmuxCommandResult(input);
      }
      return tmuxCommandResult(input);
    }
    if (args[0] === "display-popup" && !args.includes("-C") && options.displayExit !== undefined) {
      throw Object.assign(new Error("popup exited"), {
        exitCode: options.displayExit,
        stderr: "",
        stdout: "",
      });
    }
    if (
      args[0] === "display-popup" &&
      !args.includes("-C") &&
      displayReplacementPending !== undefined
    ) {
      globalOptions.set("@station_popup_active_claim", displayReplacementPending);
      globalOptions.set("@station_popup_client", "/dev/ttys099");
      globalOptions.set("@station_popup_focus_client", "/dev/ttys099");
      displayReplacementPending = undefined;
    }
    return tmuxCommandResult(input);
  };

  return {
    calls,
    claimWrites: () =>
      calls
        .filter((call) => call.args?.[0] === "if-shell")
        .map((call) => call.args?.find((arg) => arg.includes("active_claim v1.")) ?? "")
        .filter((command) => command.length > 0)
        .map((command) => /active_claim (v1\.[^ ;]+)/.exec(command)?.[1] ?? ""),
    devCommand: options.devCommand,
    executedPopupActions,
    globalOptions,
    indexOfSet: (optionName: string) =>
      calls.findIndex((call) => call.args?.includes(optionName) && call.args[0] === "set-option"),
    root,
    runner,
    sessionSignatures,
  };
}

function claimedPopupAction(call: ExternalCommandInput): boolean {
  return (
    call.args?.[0] === "if-shell" &&
    call.args[2]?.includes("@station_popup_active_claim") === true &&
    call.args[3]?.includes("display-popup") === true
  );
}

function applySetOption(
  args: string[],
  globalOptions: Map<string, string>,
  sessionOptions: Map<string, string>,
  sessionSignatures: Map<string, string>,
): void {
  if (args.includes("-gq")) {
    const optionName = args.at(-2);
    const value = args.at(-1);
    if (args.includes("-u")) {
      if (value !== undefined) globalOptions.delete(value);
    } else if (optionName !== undefined && value !== undefined) {
      globalOptions.set(optionName, value);
    }
    return;
  }
  const optionName = args.at(-2);
  const value = args.at(-1);
  if (optionName === "@station_popup_ui_signature" && value !== undefined) {
    sessionSignatures.set(args[2] ?? "", value);
  } else if (optionName !== undefined && value !== undefined) {
    sessionOptions.set(optionName, value);
  }
}

function setFromTmuxCommand(command: string, globalOptions: Map<string, string>): void {
  const match = /set-option -gq (@station_popup_(?:ui_route|active_claim)) ([^ ;]+)/.exec(command);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    globalOptions.set(match[1], match[2]);
  }
}

function extractComparedValue(format: string, optionName: string): string {
  const marker = `#{==:#{${optionName}},`;
  const start = format.indexOf(marker);
  if (start < 0) return "";
  const value = format.slice(start + marker.length).split("}")[0] ?? "";
  return value
    .replaceAll("#}", "}")
    .replaceAll("#;", ";")
    .replaceAll("#,", ",")
    .replaceAll("##", "#");
}
