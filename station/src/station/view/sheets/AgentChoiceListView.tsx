import type { KeyedChoice, NewSessionHarnessOption } from "@station/dashboard-core";
import { useState } from "react";
import { STATION_COLORS } from "../theme.js";
import { useStationMouse, stationMouseProps } from "../stationMouseContext.js";
import { spaces } from "./parts.js";

export type AgentChoiceListViewProps = {
  choices: readonly KeyedChoice<NewSessionHarnessOption>[];
  width: number;
};

export function AgentChoiceListView({ choices, width }: AgentChoiceListViewProps) {
  return (
    <>
      {choices.map((choice) => (
        <AgentChoiceLine
          key={choice.value.id}
          choiceKey={choice.key}
          label={choice.value.label}
          detail={choice.value.status}
          color={statusColor(choice.value.status)}
          width={width}
        />
      ))}
    </>
  );
}

function AgentChoiceLine({
  choiceKey,
  label,
  detail,
  color,
  width,
}: {
  choiceKey: string;
  label: string;
  detail: string;
  color?: string | undefined;
  width: number;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  const prefix = ` ${choiceKey} `;
  const detailPrefix = `${label} `;
  const detailWidth = Math.max(0, width - prefix.length - detailPrefix.length);
  const visibleDetail = detail.slice(0, detailWidth);
  const padding = spaces(Math.max(0, detailWidth - visibleDetail.length));
  return (
    <text
      fg={hover ? STATION_COLORS.green : STATION_COLORS.foreground}
      {...stationMouseProps(dispatch, { kind: "sheetChoice", choiceKey })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {prefix}
      {detailPrefix}
      <span {...(color === undefined ? {} : { fg: color })}>{visibleDetail}</span>
      {padding}
    </text>
  );
}

function statusColor(status: string | undefined): string | undefined {
  if (status === "unavailable") {
    return STATION_COLORS.red;
  }
  if (status === "degraded") {
    return STATION_COLORS.yellow;
  }
  return undefined;
}
