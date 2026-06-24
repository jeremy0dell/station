import type {
  CommandId,
  CommandReceipt,
  CommandRecord,
  DiagnosticCollectionOptions,
  DiagnosticSnapshot,
  DoctorOptions,
  DoctorReport,
  EventFilter,
  HarnessEventReport,
  HarnessEventReportReceipt,
  ObserverHealth,
  ObserverStopReceipt,
  ProviderHookEvent,
  ProviderHookReceipt,
  ReconcileReceipt,
  StationCommand,
  StationEvent,
  StationSnapshot,
} from "@station/contracts";
import type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
} from "./messages.js";

export type ObserverApi = {
  health(): Promise<ObserverHealth>;
  stop(): Promise<ObserverStopReceipt>;
  getSnapshot(options?: { includeDebug?: boolean }): Promise<StationSnapshot>;
  subscribe(filter?: EventFilter): AsyncIterable<StationEvent>;
  dispatch(command: StationCommand): Promise<CommandReceipt>;
  getCommand(commandId: CommandId): Promise<CommandRecord | undefined>;
  reconcile(reason?: string): Promise<ReconcileReceipt>;
  ingestProviderHookEvent(event: ProviderHookEvent): Promise<ProviderHookReceipt>;
  ingestHookEvent(event: ProviderHookEvent): Promise<ProviderHookReceipt>;
  reportHarnessEvent(report: HarnessEventReport): Promise<HarnessEventReportReceipt>;
  prepareExternalLaunch(
    params: AgentPrepareExternalLaunchParams,
  ): Promise<AgentPrepareExternalLaunchResult>;
  reportExternalExit(params: AgentReportExternalExitParams): Promise<AgentReportExternalExitResult>;
  runDoctor(options?: DoctorOptions): Promise<DoctorReport>;
  collectDiagnostics(options?: DiagnosticCollectionOptions): Promise<DiagnosticSnapshot>;
};
