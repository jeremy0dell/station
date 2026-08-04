import { randomUUID } from "node:crypto";
import {
  type UiLifecycleClientKind,
  type UiRunContext,
  type UiRunId,
  UiRunContextSchema,
  UiRunIdSchema,
} from "@station/contracts";

export type UiRunIdSlots = {
  __stationUiRunId?: UiRunId;
};

/** Resolve one validated renderer correlation context and preserve direct-dev identity across HMR. */
export function resolveUiRunContext(input: {
  env: NodeJS.ProcessEnv;
  slots: UiRunIdSlots;
  rendererPid?: number;
  clientKind?: UiLifecycleClientKind;
}): UiRunContext {
  const launcherId = UiRunIdSchema.safeParse(input.env.STATION_UI_RUN_ID);
  const uiRunId = launcherId.success
    ? launcherId.data
    : (input.slots.__stationUiRunId ?? `ui_${randomUUID()}`);
  input.slots.__stationUiRunId = uiRunId;

  return UiRunContextSchema.parse({
    uiRunId,
    rendererPid: input.rendererPid ?? process.pid,
    clientKind: input.clientKind ?? "native_renderer",
  });
}
