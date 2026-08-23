import type {
  HostHandoffFidelity,
  ObserverLifecycleFailure,
  ProviderHookReconciliationResult,
  UpdateChannelId,
  UpdateCommandArgv,
} from "@station/contracts";
import type { ExecutableArgv } from "../selfExec.js";

export type UpdateRecoveryCommandInput = {
  cli: ExecutableArgv;
  channel: UpdateChannelId;
  drivePackageManager: boolean;
  handoff?: HostHandoffFidelity;
};

/**
 * DRIVEN PORT
 *
 * Defines safe Observer, hook, and reconcile child mutations plus recovery argv for update
 * convergence.
 */
export interface UpdateRuntimeConvergencePort {
  reconcileHook(cli: ExecutableArgv, provider: string): Promise<ProviderHookReconciliationResult>;
  convergeObserver(
    cli: ExecutableArgv,
    action: "start" | "restart",
  ): Promise<ObserverLifecycleFailure | undefined>;
  reconcile(cli: ExecutableArgv): Promise<void>;
  recoveryCommands(input: UpdateRecoveryCommandInput): UpdateCommandArgv[];
}
