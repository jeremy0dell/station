import type {
  HostHandoffFidelity,
  ObserverLifecycleFailure,
  ProviderHookReconciliationResult,
  UpdateChannelId,
  UpdateCommandArgv,
  UpdateHostConvergenceCommitment,
  UpdateHostConvergenceReceipt,
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
 * Defines safe child-command mutations and recovery argv for update convergence. Host replacement
 * and handoff remain distinct operations bound to one exact planned build and PTY commitment.
 */
export interface UpdateRuntimeConvergencePort {
  reconcileHook(cli: ExecutableArgv, provider: string): Promise<ProviderHookReconciliationResult>;
  convergeObserver(
    cli: ExecutableArgv,
    action: "start" | "restart",
  ): Promise<ObserverLifecycleFailure | undefined>;
  replaceIdleHost(
    cli: ExecutableArgv,
    commitment: UpdateHostConvergenceCommitment,
  ): Promise<UpdateHostConvergenceReceipt>;
  handoffHost(
    cli: ExecutableArgv,
    fidelity: HostHandoffFidelity,
    commitment: UpdateHostConvergenceCommitment,
  ): Promise<UpdateHostConvergenceReceipt>;
  reconcile(cli: ExecutableArgv): Promise<void>;
  recoveryCommands(input: UpdateRecoveryCommandInput): UpdateCommandArgv[];
}
