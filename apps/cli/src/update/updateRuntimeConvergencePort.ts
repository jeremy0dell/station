import type {
  HostHandoffCommandResult,
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
 * Defines the safe child-command mutations and recovery argv required by update convergence.
 */
export interface UpdateRuntimeConvergencePort {
  reconcileHook(cli: ExecutableArgv, provider: string): Promise<ProviderHookReconciliationResult>;
  convergeObserver(
    cli: ExecutableArgv,
    action: "start" | "restart",
  ): Promise<ObserverLifecycleFailure | undefined>;
  convergeHost(
    cli: ExecutableArgv,
    fidelity: HostHandoffFidelity,
  ): Promise<HostHandoffCommandResult>;
  reconcile(cli: ExecutableArgv): Promise<void>;
  recoveryCommands(input: UpdateRecoveryCommandInput): UpdateCommandArgv[];
}
