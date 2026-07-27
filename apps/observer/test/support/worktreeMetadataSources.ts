import type {
  WorktreeChangeReadRequest,
  WorktreeChangeReadResult,
  WorktreeChangeSource,
  WorktreeMetadataInvalidationSource,
  WorktreeMetadataTarget,
} from "../../src/metadata/ports.js";

export class FakeWorktreeChangeSource implements WorktreeChangeSource {
  readonly requests: WorktreeChangeReadRequest[] = [];
  result: WorktreeChangeReadResult = { status: "unavailable" };
  failure: unknown;
  onRead?: (request: WorktreeChangeReadRequest) => Promise<WorktreeChangeReadResult>;

  async read(request: WorktreeChangeReadRequest): Promise<WorktreeChangeReadResult> {
    this.requests.push(request);
    if (this.failure !== undefined) throw this.failure;
    if (this.onRead !== undefined) return this.onRead(request);
    return this.result;
  }
}

export class FakeWorktreeMetadataInvalidationSource implements WorktreeMetadataInvalidationSource {
  readonly replacements: WorktreeMetadataTarget[][] = [];
  shutdownCount = 0;
  stopped = false;
  onReplace?: (targets: readonly WorktreeMetadataTarget[]) => Promise<void>;
  onShutdown?: () => Promise<void>;

  async replaceWatchedWorktrees(targets: readonly WorktreeMetadataTarget[]): Promise<void> {
    if (this.stopped) return;
    this.replacements.push(targets.map((target) => ({ ...target })));
    await this.onReplace?.(targets);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.shutdownCount += 1;
    await this.onShutdown?.();
  }
}
