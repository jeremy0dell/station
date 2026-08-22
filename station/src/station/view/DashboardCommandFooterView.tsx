import { TextAttributes } from "@opentui/core";
import type { DashboardFooterCommandModel } from "@station/dashboard-core/selectors";
import { createContext, useContext, type ReactNode } from "react";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationColor,
  type StationTheme,
} from "../../theme/index.js";

type ShortcutInteraction = DashboardFooterCommandModel["interaction"];
type ShortcutLayout = "full" | "compact" | "minimal";
type ShortcutTextRole =
  | "badge"
  | "key"
  | "label"
  | "value"
  | "warning"
  | "description"
  | "divider";

const INPUT_WIDTH = 3;

const SHORTCUT_ATTRIBUTES: Record<
  ShortcutInteraction,
  Record<ShortcutTextRole, number>
> = {
  active: {
    badge: TextAttributes.BOLD,
    key: TextAttributes.BOLD,
    label: TextAttributes.BOLD,
    value: TextAttributes.NONE,
    warning: TextAttributes.BOLD,
    description: TextAttributes.NONE,
    divider: TextAttributes.NONE,
  },
  inactive: {
    badge: TextAttributes.NONE,
    key: TextAttributes.NONE,
    label: TextAttributes.NONE,
    value: TextAttributes.NONE,
    warning: TextAttributes.NONE,
    description: TextAttributes.NONE,
    divider: TextAttributes.NONE,
  },
};

const CURSOR: Record<ShortcutInteraction, string> = {
  active: "▌",
  inactive: " ",
};

type ShortcutFooterContextValue = {
  model: DashboardFooterCommandModel;
  layout: ShortcutLayout;
};

const ShortcutFooterContext = createContext<ShortcutFooterContextValue | undefined>(undefined);

export function DashboardCommandFooterView({
  model,
  columns,
}: {
  model: DashboardFooterCommandModel;
  columns: number;
}) {
  const theme = useStationTheme();
  return (
    <ShortcutFooterContext.Provider value={{ model, layout: shortcutLayout(columns) }}>
      <box
        height={1}
        width="100%"
        flexDirection="row"
        overflow="hidden"
        backgroundColor={toOpenTuiOpaqueColor(theme.filter.editorSurface)}
      >
        <ShortcutBadge />
        <ShortcutInput />
        <ShortcutPreview />
        <box height={1} flexGrow={1} />
        <ShortcutControls />
      </box>
    </ShortcutFooterContext.Provider>
  );
}

function useShortcutFooter(): ShortcutFooterContextValue {
  const context = useContext(ShortcutFooterContext);
  if (context === undefined) {
    throw new Error("Shortcut footer components require ShortcutFooterContext.");
  }
  return context;
}

function ShortcutBadge() {
  return <ShortcutText role="badge" text=" SHORTCUT " />;
}

function ShortcutInput() {
  const { model, layout } = useShortcutFooter();
  const labeled = layout !== "minimal";
  const text = `${model.input}${CURSOR[model.interaction]}${" ".repeat(Math.max(0, INPUT_WIDTH - model.input.length))}`;
  return (
    <box height={1} flexDirection="row" flexShrink={0}>
      <ShortcutText role="description" text={labeled ? "  " : " "} />
      {labeled ? <ShortcutText role="label" text="INPUT " /> : null}
      <ShortcutText role="key" text={text} />
    </box>
  );
}

function ShortcutPreview() {
  const { layout } = useShortcutFooter();
  return (
    <box height={1} flexDirection="row" flexShrink={1} overflow="hidden">
      {layout === "minimal" ? null : (
        <ShortcutText role="divider" text={previewDivider(layout)} />
      )}
      <ShortcutPreviewContent />
    </box>
  );
}

function ShortcutPreviewContent(): ReactNode {
  const { model, layout } = useShortcutFooter();
  if (layout === "minimal") return null;
  switch (model.preview.kind) {
    case "guide":
      return <ShortcutGuidePreview />;
    case "session":
      return (
        <ShortcutResolvedPreview
          label="SESSION"
          value={layout === "full" ? ` open session ${model.preview.code}` : ` open ${model.preview.code}`}
        />
      );
    case "command":
      return (
        <ShortcutResolvedPreview label="COMMAND" value={` ${model.preview.action}`} />
      );
    case "noMatch":
      return <ShortcutNoMatchPreview />;
  }
}

function ShortcutGuidePreview() {
  const { layout } = useShortcutFooter();
  return (
    <>
      <ShortcutText role="label" text="SESSION" />
      <ShortcutText role="value" text=" 1-zzz" />
      <ShortcutText role="divider" text={layout === "full" ? "  ·  " : " · "} />
      <ShortcutText role="label" text="COMMAND" />
      <ShortcutText
        role="value"
        text={layout === "full" ? " uppercase key" : " uppercase"}
      />
    </>
  );
}

function ShortcutResolvedPreview({ label, value }: {
  label: "COMMAND" | "SESSION";
  value: string;
}) {
  return (
    <>
      <ShortcutText role="label" text={label} />
      <ShortcutText role="value" text={value} />
    </>
  );
}

function ShortcutNoMatchPreview() {
  const { layout } = useShortcutFooter();
  return (
    <>
      <ShortcutText role="warning" text="NO MATCH" />
      <ShortcutText
        role="description"
        text={layout === "full" ? " use 1-zzz or a registered command" : " 1-zzz or command"}
      />
    </>
  );
}

function ShortcutControls() {
  const { model, layout } = useShortcutFooter();
  const canRun = model.preview.kind === "session" || model.preview.kind === "command";
  const canEdit = model.input.length > 0;
  const showEdit = canEdit && (layout !== "minimal" || !canRun);
  return (
    <box height={1} flexDirection="row" flexShrink={0}>
      {layout === "minimal" ? null : (
        <ShortcutText role="divider" text={controlDivider(layout)} />
      )}
      {layout === "full" ? <ShortcutText role="label" text="KEYS " /> : null}
      <ShortcutControl keyText="?" description=" help" />
      {canRun ? (
        <>
          <ShortcutControlSeparator />
          <ShortcutControl
            keyText={layout === "full" ? "Enter" : "↵"}
            description={layout === "minimal" ? "" : " run"}
          />
        </>
      ) : null}
      {showEdit ? (
        <>
          <ShortcutControlSeparator />
          <ShortcutControl
            keyText={layout === "full" ? "Backspace" : "⌫"}
            description={layout === "minimal" ? "" : " edit"}
          />
        </>
      ) : null}
      <ShortcutControlSeparator />
      <ShortcutControl
        keyText="Esc"
        description={layout === "full" ? " close" : ""}
      />
    </box>
  );
}

function ShortcutControl({
  keyText,
  description,
}: {
  keyText: string;
  description: string;
}) {
  return (
    <>
      <ShortcutText role="key" text={keyText} />
      {description.length > 0 ? (
        <ShortcutText role="description" text={description} />
      ) : null}
    </>
  );
}

function ShortcutControlSeparator() {
  const { layout } = useShortcutFooter();
  return (
    <ShortcutText role="divider" text={layout === "full" ? "  ·  " : " · "} />
  );
}

function ShortcutText({ role, text }: {
  role: ShortcutTextRole;
  text: string;
}) {
  const { model } = useShortcutFooter();
  const theme = useStationTheme();
  const foreground = shortcutForeground(theme, model.interaction);
  const background: Record<ShortcutTextRole, StationColor> = {
    badge: theme.filter.editorRail,
    key: theme.filter.editorSurface,
    label: theme.filter.editorSurface,
    value: theme.filter.editorSurface,
    warning: theme.filter.editorSurface,
    description: theme.filter.editorSurface,
    divider: theme.filter.editorSurface,
  };
  return (
    <text
      flexShrink={0}
      selectable={false}
      fg={toOpenTuiColor(foreground[role])}
      bg={toOpenTuiColor(background[role])}
      attributes={SHORTCUT_ATTRIBUTES[model.interaction][role]}
    >
      {text}
    </text>
  );
}

function shortcutForeground(
  theme: StationTheme,
  interaction: ShortcutInteraction,
): Record<ShortcutTextRole, StationColor> {
  const foreground: Record<ShortcutInteraction, Record<ShortcutTextRole, StationColor>> = {
    active: {
      badge: theme.text.inverse,
      key: theme.text.primary,
      label: theme.text.muted,
      value: theme.text.primary,
      warning: theme.status.warning,
      description: theme.text.muted,
      divider: theme.interaction.hairline,
    },
    inactive: {
      badge: theme.text.muted,
      key: theme.text.muted,
      label: theme.text.muted,
      value: theme.text.muted,
      warning: theme.text.muted,
      description: theme.text.muted,
      divider: theme.interaction.hairline,
    },
  };
  return foreground[interaction];
}

function shortcutLayout(columns: number): ShortcutLayout {
  if (columns >= 110) return "full";
  if (columns >= 48) return "compact";
  return "minimal";
}

function previewDivider(layout: ShortcutLayout): string {
  const divider: Record<ShortcutLayout, string> = {
    full: "  │  ",
    compact: " │ ",
    minimal: "",
  };
  return divider[layout];
}

function controlDivider(layout: ShortcutLayout): string {
  const divider: Record<ShortcutLayout, string> = {
    full: "│  ",
    compact: "│ ",
    minimal: "",
  };
  return divider[layout];
}
