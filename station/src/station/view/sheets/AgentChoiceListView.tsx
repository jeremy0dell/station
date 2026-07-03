import type { KeyedChoice, NewSessionHarnessOption } from "@station/dashboard-core";
import { providerHealthStatusColor, STATION_COLORS } from "../theme.js";
import { SheetChoiceLine } from "./parts.js";

export type AgentChoiceListViewProps = {
  choices: readonly KeyedChoice<NewSessionHarnessOption>[];
  width: number;
  /** The option to mark as current (a project's default harness), if any. */
  currentId?: NewSessionHarnessOption["id"];
  /** When true, the current option shows an "updating…" cue (change in flight). */
  pending?: boolean;
};

export function AgentChoiceListView({
  choices,
  width,
  currentId,
  pending = false,
}: AgentChoiceListViewProps) {
  return (
    <>
      {choices.map((choice) => {
        const current = choice.value.id === currentId;
        // The update nudge never displaces a problem status — unavailable or
        // degraded providers keep their state as the row's detail.
        const update =
          choice.value.status === "healthy" || choice.value.status === "unknown"
            ? choice.value.update
            : undefined;
        return (
          <SheetChoiceLine
            key={choice.value.id}
            choiceKey={choice.key}
            label={choice.value.label}
            detail={
              update === undefined
                ? choice.value.status
                : `● update v${update.installed} → v${update.latest}`
            }
            color={
              update === undefined
                ? providerHealthStatusColor(choice.value.status)
                : STATION_COLORS.green
            }
            width={width}
            current={current}
            {...(current && pending ? { note: "updating…" } : {})}
          />
        );
      })}
    </>
  );
}
