export type CodexAppServerEvent =
  | {
      kind: "thread-status-changed";
      method: "thread/status/changed";
      threadId: string;
      threadStatusType: string;
      activeFlags: string[];
    }
  | {
      kind: "turn-started" | "turn-completed";
      method: "turn/started" | "turn/completed";
      threadId: string;
      turnId: string;
      turnStatus: string;
    }
  | {
      kind: "item-completed";
      method: "item/completed";
      threadId: string;
      turnId: string;
      itemId: string;
      itemType: string;
    }
  | {
      kind: "plan-delta";
      method: "item/plan/delta";
      threadId: string;
      turnId: string;
      itemId: string;
    }
  | {
      kind: "turn-plan-updated";
      method: "turn/plan/updated";
      threadId: string;
      turnId: string;
      planStepCount: number;
      completedPlanStepCount: number;
    }
  | {
      kind: "server-request";
      method:
        | "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval"
        | "item/tool/requestUserInput"
        | "tool/requestUserInput";
      requestId: string | number | undefined;
      threadId: string;
      turnId: string;
      itemId: string;
    }
  | {
      kind: "server-request-resolved";
      method: "serverRequest/resolved";
      threadId: string;
      requestId: string | number;
    }
  | {
      kind: "error";
      method: "error";
      message: string | undefined;
    }
  | {
      kind: "unsupported";
      method: string;
      requestId: string | number | undefined;
    };

export type CodexAppServerObservationContext = {
  observedAt: string;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  cwd?: string;
  harnessRunId?: string;
};
