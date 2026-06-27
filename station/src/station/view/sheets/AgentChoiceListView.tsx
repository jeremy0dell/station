import type { KeyedChoice, NewSessionHarnessOption } from "@station/dashboard-core";
import { providerHealthStatusColor } from "../theme.js";
import { SheetChoiceLine } from "./parts.js";

export type AgentChoiceListViewProps = {
  choices: readonly KeyedChoice<NewSessionHarnessOption>[];
  width: number;
};

export function AgentChoiceListView({ choices, width }: AgentChoiceListViewProps) {
  return (
    <>
      {choices.map((choice) => (
        <SheetChoiceLine
          key={choice.value.id}
          choiceKey={choice.key}
          label={choice.value.label}
          detail={choice.value.status}
          color={providerHealthStatusColor(choice.value.status)}
          width={width}
        />
      ))}
    </>
  );
}
