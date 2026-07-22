import type { TmuxConfig } from "@station/config";
import type {
  OpenWorkspaceRequest,
  OpenWorkspaceResult,
  ProviderHealth,
  ProviderId,
  TerminalCapabilities,
  TerminalCapture,
  TerminalFocusContext,
  TerminalLaunchProcessRequest,
  TerminalLaunchProcessResult,
  TerminalProvider,
  TerminalTargetId,
  TerminalTargetObservation,
} from "@station/contracts";
import {
  type ExternalCommandRunner,
  pathIsSame,
  pathIsSameOrInside,
  publicSafeErrorFromUnknown,
  type RuntimeClock,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { runTmuxCommand, type TmuxCommandInput } from "./command.js";
import { TmuxTerminalProviderError, tmuxProviderErrorFromUnknown } from "./errors.js";
import { buildRespawnPaneLaunchArgs, resolveLaunchPaneTarget } from "./launch.js";
import { parseTmuxTargetLines, tmuxListTargetsFormat } from "./parse.js";
import { resolveFocusPopupClient } from "./popup/state.js";
import {
  buildTmuxTargetId,
  buildWorkbenchWindowName,
  defaultTmuxWorkbenchSessionOptions,
  parseTmuxTargetId,
  resolveTmuxWorkbenchConfig,
  tmuxNewWindowTarget,
  tmuxPrimaryPaneTarget,
  tmuxSessionOptionArgs,
  tmuxWindowTarget,
} from "./topology.js";

const tmuxPrimaryPaneIdentityFormat = ["#{session_name}", "#{window_id}", "#{pane_id}"].join("\t");
const tmuxLaunchStatusFormat = [
  "#{pane_dead}",
  "#{pane_dead_status}",
  "#{pane_current_command}",
].join("\t");

export type TmuxProviderOptions = {
  command?: string;
  config?: TmuxConfig;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
  clock?: RuntimeClock;
};

const tmuxCapabilities: TerminalCapabilities = {
  canOpenWorkspace: true,
  canFocusTarget: true,
  canCloseTarget: true,
  canCaptureOutput: true,
  canSendInput: true,
  canPersistIdentityBinding: true,
  canDisplayPopup: true,
};

/**
 * ADAPTER
 *
 * Translates Station terminal operations into tmux-owned topology and commands.
 *
 * Operational failures retain diagnostic evidence while provider health exposes only the lean public projection.
 */
export class TmuxProvider implements TerminalProvider {
  readonly id: ProviderId = "tmux";

  readonly #command: string;
  readonly #config: ReturnType<typeof resolveTmuxWorkbenchConfig>;
  readonly #timeoutMs: number;
  readonly #runner: ExternalCommandRunner | undefined;
  readonly #clock: RuntimeClock;

  constructor(options: TmuxProviderOptions = {}) {
    this.#command = options.command ?? process.env.STATION_TMUX_BIN ?? "tmux";
    this.#config = resolveTmuxWorkbenchConfig(options.config);
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
  }

  capabilities(): TerminalCapabilities {
    return tmuxCapabilities;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = toIsoTimestamp(this.#clock.now());
    try {
      await this.#run(["-V"], {
        operation: "provider.tmux.health",
        fallback: {
          code: "TERMINAL_TMUX_UNAVAILABLE",
          message: "tmux is not available.",
        },
        retries: 1,
      });
      return {
        providerId: this.id,
        providerType: "terminal",
        status: "healthy",
        lastCheckedAt: checkedAt,
        capabilities: this.capabilities(),
      };
    } catch (cause) {
      const error = tmuxProviderErrorFromUnknown(cause, {
        code: "TERMINAL_TMUX_UNAVAILABLE",
        message: "tmux is not available.",
        hint: "Install tmux or choose a different terminal provider.",
      });
      return {
        providerId: this.id,
        providerType: "terminal",
        status: "unavailable",
        lastCheckedAt: checkedAt,
        lastError: publicSafeErrorFromUnknown(error, {
          tag: "TerminalProviderError",
          code: "TERMINAL_TMUX_UNAVAILABLE",
          message: "tmux is not available.",
          provider: this.id,
        }),
        capabilities: this.capabilities(),
      };
    }
  }

  async listTargets(): Promise<TerminalTargetObservation[]> {
    const output = await this.#run(["list-panes", "-a", "-F", tmuxListTargetsFormat], {
      operation: "provider.tmux.listTargets",
      fallback: {
        code: "TERMINAL_LIST_FAILED",
        message: "tmux failed to list terminal targets.",
      },
      retries: 1,
    });
    return parseTmuxTargetLines(output.stdout, {
      observedAt: toIsoTimestamp(this.#clock.now()),
    });
  }

  async openWorkspace(request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult> {
    const sessionName = this.#config.workbenchSession;
    let windowName = buildWorkbenchWindowName({
      projectId: request.project.id,
      branch: request.worktree.branch,
      worktreeId: request.worktree.id,
      path: request.worktree.path,
    });
    let windowTarget = tmuxWindowTarget({ sessionId: sessionName, windowNameOrId: windowName });
    let paneTarget = tmuxPrimaryPaneTarget({
      sessionId: sessionName,
      windowNameOrId: windowName,
    });
    const sessionExists = await this.#hasSession(sessionName);

    if (sessionExists) {
      const existing = await this.#findExistingWorkspaceTarget(sessionName, request);
      if (existing === undefined) {
        if (await this.#hasWindow(sessionName, windowName)) {
          windowName = buildWorkbenchWindowName({
            projectId: request.project.id,
            branch: request.worktree.branch,
            worktreeId: request.worktree.id,
            path: request.worktree.path,
            forceHash: true,
          });
          windowTarget = tmuxWindowTarget({ sessionId: sessionName, windowNameOrId: windowName });
          paneTarget = tmuxPrimaryPaneTarget({
            sessionId: sessionName,
            windowNameOrId: windowName,
          });
        }
        const output = await this.#run(
          [
            "new-window",
            "-d",
            "-P",
            "-F",
            tmuxPrimaryPaneIdentityFormat,
            "-t",
            tmuxNewWindowTarget(sessionName),
            "-n",
            windowName,
            "-c",
            request.worktree.path,
          ],
          {
            operation: "provider.tmux.openWorkspace",
            fallback: {
              code: "TERMINAL_OPEN_FAILED",
              message: "tmux failed to create a workbench window.",
            },
          },
        );
        const primaryPane = parsePrimaryPaneIdentity(output.stdout);
        windowTarget = tmuxWindowTarget({
          sessionId: sessionName,
          windowNameOrId: primaryPane.windowId,
        });
        paneTarget = primaryPane.paneId;
      } else {
        windowName = existing.windowName;
        windowTarget = tmuxWindowTarget({
          sessionId: sessionName,
          windowNameOrId: existing.windowId,
        });
        paneTarget = existing.paneId;
      }
    } else {
      await this.#run(
        ["new-session", "-d", "-s", sessionName, "-n", windowName, "-c", request.worktree.path],
        {
          operation: "provider.tmux.openWorkspace",
          fallback: {
            code: "TERMINAL_OPEN_FAILED",
            message: "tmux failed to create the workbench session.",
          },
        },
      );
    }

    await this.#configureWorkbenchSession(sessionName);

    // Write identity into tmux options so listTargets can correlate panes back to station state.
    await this.#setWindowOption(windowTarget, "@station.session_id", request.sessionId ?? "");
    await this.#setWindowOption(windowTarget, "@station.project_id", request.project.id);
    await this.#setWindowOption(windowTarget, "@station.worktree_id", request.worktree.id);
    await this.#setWindowOption(windowTarget, "@station.worktree_path", request.worktree.path);
    await this.#setPaneOption(paneTarget, "@station.role", "main-agent");
    await this.#setPaneOption(paneTarget, "@station.harness", request.harness);

    const primaryPane = await this.#resolvePrimaryPaneIdentity(paneTarget);
    return {
      target: {
        provider: this.id,
        targetId: buildTmuxTargetId(primaryPane),
        projectId: request.project.id,
        worktreeId: request.worktree.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        harnessBinding: {
          role: "main-agent",
          harnessProvider: request.harness,
          worktreePath: request.worktree.path,
        },
        providerData: {
          sessionName,
          windowName,
          windowTarget,
          paneTarget,
          windowId: primaryPane.windowId,
          paneId: primaryPane.paneId,
        },
        confidence: "high",
        reason: "tmux workbench workspace is open and identity binding was written.",
      },
      agentEndpointId: primaryPane.paneId,
      providerData: {
        sessionName,
        windowName,
        windowTarget,
        paneTarget,
        windowId: primaryPane.windowId,
        paneId: primaryPane.paneId,
      },
    };
  }

  async launchProcess(request: TerminalLaunchProcessRequest): Promise<TerminalLaunchProcessResult> {
    const paneTarget = resolveLaunchPaneTarget(request);
    await this.#run(["set-option", "-p", "-t", paneTarget, "remain-on-exit", "on"], {
      operation: "provider.tmux.launchProcess",
      fallback: {
        code: "TERMINAL_LAUNCH_FAILED",
        message: "tmux failed to prepare the harness pane.",
      },
    });
    await this.#run(
      buildRespawnPaneLaunchArgs({
        paneTarget,
        plan: request.launchPlan,
        cwdFallback: request.worktree.path,
      }),
      {
        operation: "provider.tmux.launchProcess",
        fallback: {
          code: "TERMINAL_LAUNCH_FAILED",
          message: "tmux failed to launch the harness process.",
        },
      },
    );
    await this.#assertLaunchRunning(request, paneTarget);
    return {
      terminalTargetId: request.terminalTarget.targetId,
      agentEndpointId: request.agentEndpointId,
      started: true,
      providerData: {
        paneTarget,
      },
    };
  }

  async #assertLaunchRunning(
    request: TerminalLaunchProcessRequest,
    paneTarget: string,
  ): Promise<void> {
    const output = await this.#run(
      ["display-message", "-p", "-t", paneTarget, tmuxLaunchStatusFormat],
      {
        operation: "provider.tmux.launchProcess",
        fallback: {
          code: "TERMINAL_LAUNCH_FAILED",
          message: "tmux failed to inspect the launched harness pane.",
        },
        retries: 1,
      },
    );
    const [paneDead = "", paneDeadStatus = "", paneCommand = ""] = output.stdout.trim().split("\t");
    if (paneDead !== "1") {
      return;
    }

    const options: ConstructorParameters<typeof TmuxTerminalProviderError>[2] = {
      hint: launchExitedHint(paneCommand, paneDeadStatus),
      projectId: request.project.id,
      worktreeId: request.worktree.id,
    };
    if (request.terminalTarget.sessionId !== undefined) {
      options.sessionId = request.terminalTarget.sessionId;
    }
    throw new TmuxTerminalProviderError(
      "TERMINAL_LAUNCH_EXITED",
      "The harness process exited immediately after launch.",
      options,
    );
  }

  // Best-effort lookup of the client the popup launcher registered; a missing
  // option or tmux failure just yields undefined (no client switch).
  async #resolveFocusClient(): Promise<string | undefined> {
    const input: TmuxCommandInput = {
      command: this.#command,
      timeoutMs: this.#timeoutMs,
      clock: this.#clock,
    };
    if (this.#runner !== undefined) {
      input.runner = this.#runner;
    }
    try {
      return await resolveFocusPopupClient(input);
    } catch {
      return undefined;
    }
  }

  async focusTarget(targetId: TerminalTargetId, context?: TerminalFocusContext): Promise<void> {
    const target = parseTargetId(targetId);
    if (context?.origin?.provider === this.id) {
      // The popup launcher publishes the originating client in
      // @station_popup_focus_client; resolve it live when the caller did not
      // supply one (the persistent popup attaches a fresh client per open, so
      // its long-lived UI process can't carry the per-open client). Without
      // switch-client the workbench window is selected in its session but the
      // user's client never moves to it — the dashboard appears to do nothing.
      const clientId = context.origin.clientId ?? (await this.#resolveFocusClient());
      if (clientId !== undefined) {
        await this.#run(["switch-client", "-c", clientId, "-t", target.sessionId], {
          operation: "provider.tmux.focusTarget",
          fallback: {
            code: "TERMINAL_FOCUS_FAILED",
            message: "tmux failed to focus the originating client.",
          },
        });
      }
    }
    await this.#run(
      [
        "select-window",
        "-t",
        tmuxWindowTarget({
          sessionId: target.sessionId,
          windowNameOrId: target.windowId,
        }),
      ],
      {
        operation: "provider.tmux.focusTarget",
        fallback: {
          code: "TERMINAL_FOCUS_FAILED",
          message: "tmux failed to focus the workbench window.",
        },
      },
    );
    await this.#run(["select-pane", "-t", target.paneId], {
      operation: "provider.tmux.focusTarget",
      fallback: {
        code: "TERMINAL_FOCUS_FAILED",
        message: "tmux failed to focus the primary pane.",
      },
    });
  }

  async closeTarget(targetId: TerminalTargetId): Promise<void> {
    const target = parseTargetId(targetId);
    await this.#run(
      [
        "kill-window",
        "-t",
        tmuxWindowTarget({
          sessionId: target.sessionId,
          windowNameOrId: target.windowId,
        }),
      ],
      {
        operation: "provider.tmux.closeTarget",
        fallback: {
          code: "TERMINAL_CLOSE_FAILED",
          message: "tmux failed to close the workbench window.",
        },
      },
    );
  }

  async captureTarget(targetId: TerminalTargetId): Promise<TerminalCapture> {
    const target = parseTargetId(targetId);
    const output = await this.#run(["capture-pane", "-p", "-t", target.paneId, "-S", "-80"], {
      operation: "provider.tmux.captureTarget",
      fallback: {
        code: "TERMINAL_CAPTURE_FAILED",
        message: "tmux failed to capture pane output.",
      },
    });
    return {
      targetId,
      capturedAt: toIsoTimestamp(this.#clock.now()),
      text: output.stdout,
      providerData: {
        sessionName: target.sessionId,
        windowId: target.windowId,
        paneId: target.paneId,
      },
    };
  }

  async sendInput(targetId: TerminalTargetId, input: string): Promise<void> {
    const target = parseTargetId(targetId);
    await this.#run(["send-keys", "-t", target.paneId, input], {
      operation: "provider.tmux.sendInput",
      fallback: {
        code: "TERMINAL_SEND_INPUT_FAILED",
        message: "tmux failed to send input to the pane.",
      },
    });
  }

  async #hasSession(sessionName: string): Promise<boolean> {
    try {
      await this.#run(["has-session", "-t", sessionName], {
        operation: "provider.tmux.hasSession",
        fallback: {
          code: "TERMINAL_TMUX_UNAVAILABLE",
          message: "tmux failed to inspect the workbench session.",
        },
        mapErrors: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  async #hasWindow(sessionName: string, windowName: string): Promise<boolean> {
    try {
      const output = await this.#run(["list-windows", "-t", sessionName, "-F", "#{window_name}"], {
        operation: "provider.tmux.hasWindow",
        fallback: {
          code: "TERMINAL_LIST_FAILED",
          message: "tmux failed to inspect workbench windows.",
        },
        mapErrors: false,
      });
      return output.stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .includes(windowName);
    } catch {
      return false;
    }
  }

  async #findExistingWorkspaceTarget(
    sessionName: string,
    request: OpenWorkspaceRequest,
  ): Promise<{ windowName: string; windowId: string; paneId: string } | undefined> {
    try {
      const output = await this.#run(
        ["list-panes", "-t", sessionName, "-F", tmuxListTargetsFormat],
        {
          operation: "provider.tmux.findExistingWorkspace",
          fallback: {
            code: "TERMINAL_LIST_FAILED",
            message: "tmux failed to inspect existing workspace panes.",
          },
          mapErrors: false,
        },
      );
      const targets = parseTmuxTargetLines(output.stdout, {
        observedAt: toIsoTimestamp(this.#clock.now()),
      });
      const target = targets.find((candidate) => targetMatchesWorkspace(candidate, request));
      if (target === undefined) {
        return undefined;
      }
      const parsed = parseTmuxTargetId(target.id);
      return {
        windowName: target.title ?? parsed.windowId,
        windowId: parsed.windowId,
        paneId: parsed.paneId,
      };
    } catch {
      return undefined;
    }
  }

  async #configureWorkbenchSession(sessionName: string): Promise<void> {
    for (const option of defaultTmuxWorkbenchSessionOptions) {
      await this.#run(tmuxSessionOptionArgs(sessionName, option), {
        operation: "provider.tmux.configureWorkbench",
        fallback: {
          code: "TERMINAL_OPEN_FAILED",
          message: "tmux failed to configure the workbench session.",
        },
      });
    }
  }

  async #setWindowOption(target: string, name: string, value: string): Promise<void> {
    await this.#run(["set-option", "-w", "-t", target, name, value], {
      operation: "provider.tmux.openWorkspace",
      fallback: {
        code: "TERMINAL_OPEN_FAILED",
        message: "tmux failed to write window identity binding.",
      },
    });
  }

  async #setPaneOption(target: string, name: string, value: string): Promise<void> {
    await this.#run(["set-option", "-p", "-t", target, name, value], {
      operation: "provider.tmux.openWorkspace",
      fallback: {
        code: "TERMINAL_OPEN_FAILED",
        message: "tmux failed to write pane identity binding.",
      },
    });
  }

  async #resolvePrimaryPaneIdentity(paneTarget: string): Promise<{
    sessionId: string;
    windowId: string;
    paneId: string;
  }> {
    const output = await this.#run(
      ["display-message", "-p", "-t", paneTarget, tmuxPrimaryPaneIdentityFormat],
      {
        operation: "provider.tmux.openWorkspace",
        fallback: {
          code: "TERMINAL_OPEN_FAILED",
          message: "tmux failed to resolve the primary pane identity.",
        },
      },
    );
    return parsePrimaryPaneIdentity(output.stdout);
  }

  async #run(
    args: string[],
    options: {
      operation: string;
      fallback: {
        code:
          | "TERMINAL_CAPTURE_FAILED"
          | "TERMINAL_CLOSE_FAILED"
          | "TERMINAL_FOCUS_FAILED"
          | "TERMINAL_LAUNCH_FAILED"
          | "TERMINAL_LIST_FAILED"
          | "TERMINAL_OPEN_FAILED"
          | "TERMINAL_SEND_INPUT_FAILED"
          | "TERMINAL_TMUX_UNAVAILABLE";
        message: string;
        hint?: string;
      };
      retries?: number;
      mapErrors?: boolean;
    },
  ) {
    try {
      const input = {
        command: this.#command,
        clock: this.#clock,
        timeoutMs: this.#timeoutMs,
        ...(this.#runner === undefined ? {} : { runner: this.#runner }),
      };
      return await runTmuxCommand(input, {
        args,
        operation: options.operation,
        fallback: {
          tag: "TerminalProviderError",
          code: options.fallback.code,
          message: options.fallback.message,
          provider: this.id,
          ...(options.fallback.hint === undefined ? {} : { hint: options.fallback.hint }),
        },
        timeoutError: {
          tag: "TerminalProviderError",
          code: "TERMINAL_TMUX_TIMEOUT",
          message: "tmux command timed out.",
          provider: this.id,
        },
        retries: options.retries ?? 0,
        delayMs: 10,
        shouldRetry: (error) => error.code !== "TERMINAL_TMUX_TIMEOUT",
        maxOutputChars: 512 * 1024,
      });
    } catch (error) {
      if (options.mapErrors === false) {
        throw error;
      }
      throw tmuxProviderErrorFromUnknown(error, options.fallback);
    }
  }
}

function parseTargetId(targetId: TerminalTargetId): {
  sessionId: string;
  windowId: string;
  paneId: string;
} {
  try {
    return parseTmuxTargetId(targetId);
  } catch (cause) {
    throw new TmuxTerminalProviderError(
      "TERMINAL_TARGET_INVALID",
      "The terminal target id is not a valid tmux target.",
      { cause },
    );
  }
}

function targetMatchesWorkspace(
  target: TerminalTargetObservation,
  request: OpenWorkspaceRequest,
): boolean {
  if (target.harnessBinding?.role !== "main-agent") {
    return false;
  }
  if (target.projectId !== request.project.id) {
    return false;
  }
  const boundPath = target.harnessBinding.worktreePath;
  if (boundPath !== undefined) {
    return pathIsSame(boundPath, request.worktree.path);
  }
  if (target.worktreeId === request.worktree.id) {
    return true;
  }
  return target.cwd !== undefined && pathIsSameOrInside(target.cwd, request.worktree.path);
}

function parsePrimaryPaneIdentity(stdout: string): {
  sessionId: string;
  windowId: string;
  paneId: string;
} {
  const [sessionId = "", windowId = "", paneId = ""] = stdout.trim().split("\t");
  if (sessionId.length === 0 || windowId.length === 0 || paneId.length === 0) {
    throw new TmuxTerminalProviderError(
      "TERMINAL_OPEN_FAILED",
      "tmux returned an invalid primary pane identity.",
    );
  }
  return { sessionId, windowId, paneId };
}

function launchExitedHint(command: string, status: string): string {
  const commandText = command.length === 0 ? "The harness command" : `The ${command} command`;
  const statusText = status.length === 0 ? "" : ` with exit status ${status}`;
  return `${commandText} exited${statusText}. Check the harness config, credentials, and pane output.`;
}
