import type { StationCommand } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import type { TuiFolderService } from "../../services/folderService.js";
import type { ObserverService } from "../../services/types.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import { replaceSnapshot } from "../screen.js";
import {
  applyAddProjectFolderLoaded,
  applyAddProjectFolderLoadFailed,
  applyAddProjectFolderReviewed,
  applyAddProjectFolderReviewFailed,
  applyAddProjectFolderSearchFailed,
  applyAddProjectFolderSearchLoaded,
  applyAddProjectSubmitFailed,
  applyAddProjectSubmitted,
} from "../screens/addProjectScreen.js";
import type { DashboardState } from "../types.js";
import { executeDashboardCommandError } from "./commandExecutionError.js";

type ProjectPathOperationInput = {
  store: StoreApi<DashboardState>;
  folderService: TuiFolderService;
  path: string;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
};

export async function runLoadProjectDirectoryOperation(
  input: ProjectPathOperationInput,
): Promise<void> {
  const { store, folderService, path, clientLabel, scope } = input;
  await runFolderRequest(
    scope,
    () => folderService.readDirectory(path),
    (result) => store.setState(applyAddProjectFolderLoaded(store.getState(), result)),
    (error) =>
      store.setState(applyAddProjectFolderLoadFailed(store.getState(), path, error, clientLabel)),
  );
}

export async function runReviewProjectFolderOperation(
  input: ProjectPathOperationInput,
): Promise<void> {
  const { store, folderService, path, clientLabel, scope } = input;
  await runFolderRequest(
    scope,
    () => folderService.reviewFolder(path),
    (review) => store.setState(applyAddProjectFolderReviewed(store.getState(), review)),
    (error) =>
      store.setState(applyAddProjectFolderReviewFailed(store.getState(), path, error, clientLabel)),
  );
}

export async function runSearchProjectDirectoriesOperation(input: {
  store: StoreApi<DashboardState>;
  folderService: TuiFolderService;
  query: string;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, folderService, query, clientLabel, scope } = input;
  await runFolderRequest(
    scope,
    () => folderService.searchDirectories(query),
    (result) => store.setState(applyAddProjectFolderSearchLoaded(store.getState(), result)),
    (error) =>
      store.setState(
        applyAddProjectFolderSearchFailed(store.getState(), query, error, clientLabel),
      ),
  );
}

async function runFolderRequest<Result>(
  scope: DashboardRuntimeEffectScope,
  request: () => Promise<Result>,
  commitResult: (result: Result) => void,
  commitError: (error: unknown) => void,
): Promise<void> {
  try {
    const result = await request();
    scope.commit(() => commitResult(result));
  } catch (error: unknown) {
    scope.commit(() => commitError(error));
  }
}

export async function runAddProjectOperation(input: {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  command: Extract<StationCommand, { type: "project.add" }>;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, service, command, clientLabel, scope } = input;
  try {
    const reviewedProject = currentReviewedProject(store.getState());
    const failure = await executeDashboardCommandError({
      service,
      command,
      clientLabel,
      rejectedFallback: (error) => ({
        ...error,
        tag: "CommandDispatchError",
        code: "PROJECT_ADD_REJECTED",
        message: "Project add was rejected.",
      }),
    });
    if (failure !== undefined) {
      scope.commit(() => store.setState(applyAddProjectSubmitFailed(store.getState(), failure)));
      return;
    }
    const snapshot = await service.loadSnapshot();
    scope.commit(() => {
      const withSnapshot = replaceSnapshot(store.getState(), snapshot);
      store.setState(
        applyAddProjectSubmitted(withSnapshot, {
          label: reviewedProject?.label ?? command.payload.label ?? command.payload.id ?? "project",
          root: reviewedProject?.gitRoot ?? command.payload.path,
        }),
      );
    });
  } catch (error: unknown) {
    scope.commit(() =>
      store.setState(applyAddProjectSubmitFailed(store.getState(), error, clientLabel)),
    );
  }
}

function currentReviewedProject(state: DashboardState):
  | {
      label: string;
      gitRoot?: string;
    }
  | undefined {
  if (state.screen.name !== "addProject" || state.screen.flow.mode !== "review") {
    return undefined;
  }
  const result: { label: string; gitRoot?: string } = { label: state.screen.flow.label };
  if (state.screen.flow.gitRoot !== undefined) {
    result.gitRoot = state.screen.flow.gitRoot;
  }
  return result;
}
