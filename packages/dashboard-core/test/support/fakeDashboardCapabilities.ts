import type { SessionActivationRequest } from "../../src/state/capabilities/activation.js";
import type {
  DashboardCapabilities,
  DashboardExecutionHandle,
} from "../../src/state/capabilities/execution.js";
import { dashboardExecution } from "../../src/state/capabilities/execution.js";
import type {
  CreateManagedSessionRequest,
  ForkManagedSessionRequest,
} from "../../src/state/capabilities/managedSessions.js";
import type { OpenDashboardShellRequest } from "../../src/state/capabilities/shell.js";
import type { RemoveWorktreeRequest } from "../../src/state/capabilities/worktreeRemoval.js";

export class FakeDashboardCapabilities implements DashboardCapabilities {
  readonly activationRequests: SessionActivationRequest[] = [];
  readonly createRequests: CreateManagedSessionRequest[] = [];
  readonly quickCreateRequests: CreateManagedSessionRequest[] = [];
  readonly forkRequests: ForkManagedSessionRequest[] = [];
  readonly removeWorktreeRequests: RemoveWorktreeRequest[] = [];
  readonly shellRequests: OpenDashboardShellRequest[] = [];
  readonly rendererExitCodes: number[] = [];
  dashboardDismissals = 0;

  activationHandle: (request: SessionActivationRequest) => DashboardExecutionHandle = () =>
    dashboardExecution({ kind: "success" });
  createHandle: (request: CreateManagedSessionRequest) => DashboardExecutionHandle = () =>
    dashboardExecution({ kind: "success" });
  quickCreateHandle: (request: CreateManagedSessionRequest) => DashboardExecutionHandle = () =>
    dashboardExecution({ kind: "success" }, { optimistic: "pending-create" });
  forkHandle: (request: ForkManagedSessionRequest) => DashboardExecutionHandle = () =>
    dashboardExecution({ kind: "success" });
  removeWorktreeHandle: (request: RemoveWorktreeRequest) => DashboardExecutionHandle = () =>
    dashboardExecution({ kind: "success" }, { successDisposition: "wait-for-canonical" });
  shellHandle: (request: OpenDashboardShellRequest) => DashboardExecutionHandle = () =>
    dashboardExecution({ kind: "success" });
  dismissHandle: () => DashboardExecutionHandle = () => dashboardExecution({ kind: "success" });
  exitHandle: (exitCode: number) => DashboardExecutionHandle = () =>
    dashboardExecution({ kind: "success" });

  readonly activation = {
    activate: (request: SessionActivationRequest): DashboardExecutionHandle => {
      this.activationRequests.push(request);
      return this.activationHandle(request);
    },
  };

  readonly managedSessions = {
    create: (request: CreateManagedSessionRequest): DashboardExecutionHandle => {
      this.createRequests.push(request);
      return this.createHandle(request);
    },
    quickCreate: (request: CreateManagedSessionRequest): DashboardExecutionHandle => {
      this.quickCreateRequests.push(request);
      return this.quickCreateHandle(request);
    },
    fork: (request: ForkManagedSessionRequest): DashboardExecutionHandle => {
      this.forkRequests.push(request);
      return this.forkHandle(request);
    },
  };

  readonly worktreeRemoval = {
    remove: (request: RemoveWorktreeRequest): DashboardExecutionHandle => {
      this.removeWorktreeRequests.push(request);
      return this.removeWorktreeHandle(request);
    },
  };

  readonly shell = {
    open: (request: OpenDashboardShellRequest): DashboardExecutionHandle => {
      this.shellRequests.push(request);
      return this.shellHandle(request);
    },
  };

  readonly dismissal = {
    dismissDashboard: (): DashboardExecutionHandle => {
      this.dashboardDismissals += 1;
      return this.dismissHandle();
    },
    exitRenderer: ({ exitCode }: { exitCode: number }): DashboardExecutionHandle => {
      this.rendererExitCodes.push(exitCode);
      return this.exitHandle(exitCode);
    },
  };
}

export function createFakeDashboardCapabilities(): FakeDashboardCapabilities {
  return new FakeDashboardCapabilities();
}
