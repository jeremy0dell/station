import type {
  HostHandoffFidelity,
  ObserverLifecycleFailure,
  ProviderHookFollowUp,
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

export type UpdateHookFailureRecoveryInput = UpdateRecoveryCommandInput & {
  failures: readonly { provider: string; followUp: ProviderHookFollowUp }[];
};

/**
 * DRIVEN PORT
 *
 * Defines exact-target Observer mutation, provider hook reconciliation, runtime reconcile, and
 * ordered channel-neutral recovery guidance for update convergence. Observer success requires the
 * admitted build and configured socket; hook failures retain provider-owned follow-up intent
 * without granting automatic takeover.
 */
export interface UpdateRuntimeConvergencePort {
  reconcileHook(cli: ExecutableArgv, provider: string): Promise<ProviderHookReconciliationResult>;
  convergeObserver(
    cli: ExecutableArgv,
    action: "start" | "restart",
  ): Promise<ObserverLifecycleFailure | undefined>;
  reconcile(cli: ExecutableArgv): Promise<void>;
  hookFailureRecoveryCommands(input: UpdateHookFailureRecoveryInput): UpdateCommandArgv[];
  recoveryCommands(input: UpdateRecoveryCommandInput): UpdateCommandArgv[];
}
