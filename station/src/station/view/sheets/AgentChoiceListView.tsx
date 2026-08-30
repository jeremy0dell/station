import type {
  NewSessionHarnessOption,
  SelectionChoice,
} from "@station/dashboard-core/selectors";
import { providerHealthColor, useStationTheme } from "../../../theme/index.js";
import { SheetChoiceLine } from "../controls/sheetPicker.js";

export type AgentChoiceListViewProps = {
  choices: readonly SelectionChoice<NewSessionHarnessOption>[];
  width: number;
  /** The option to mark as current (a project's default harness), if any. */
  currentId?: NewSessionHarnessOption["id"];
  /** The option under the keyboard cursor (the shared selection engine's cursor). */
  selectedId?: NewSessionHarnessOption["id"];
  /** When true, the current option shows an "updating…" cue (change in flight). */
  pending?: boolean;
};

export function AgentChoiceListView({
  choices,
  width,
  currentId,
  selectedId,
  pending = false,
}: AgentChoiceListViewProps) {
  const theme = useStationTheme();
  return (
    <>
      {choices.map((choice) => {
        const option = choice.value;
        const current = option.id === currentId;
        // Problem statuses stay as the row detail; only healthy/unknown rows may
        // show an update nudge.
        const update =
          option.status === "healthy" || option.status === "unknown" ? option.update : undefined;
        let detail: string = option.status;
        let color = providerHealthColor(theme, option.status);
        if (update !== undefined) {
          detail = `● update v${update.installed} → v${update.latest}`;
          color = theme.status.success;
        }
        return (
          <SheetChoiceLine
            key={option.id}
            choiceKey={choice.key}
            label={option.label}
            detail={detail}
            color={color}
            width={width}
            current={current}
            selected={choice.value.id === selectedId}
            itemId={choice.value.id}
            {...(current && pending ? { note: "updating…" } : {})}
          />
        );
      })}
    </>
  );
}
