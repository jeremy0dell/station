import type { KeyedChoice, NewSessionHarnessOption } from "@station/dashboard-core";
import { providerHealthStatusColor } from "../theme.js";
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
        return (
          <SheetChoiceLine
            key={choice.value.id}
            choiceKey={choice.key}
            label={choice.value.label}
            detail={choice.value.status}
            color={providerHealthStatusColor(choice.value.status)}
            width={width}
            current={current}
            {...(current && pending ? { note: "updating…" } : {})}
          />
        );
      })}
    </>
  );
}
