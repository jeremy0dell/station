import type { CreateGroupFocus, CreateGroupScreenView } from "../../state/types.js";

export type CreateGroupActionId = "name" | "quickSession" | "create" | "cancel";

export type CreateGroupControlContent = {
  actionId: CreateGroupActionId;
  label: string;
  accelerator?: string;
  enabled: boolean;
  focused: boolean;
};

/** Renderer-neutral Create Group controls, focus, availability, values, and helper copy. */
export type CreateGroupSheetContent = {
  name: CreateGroupControlContent;
  quickSession: CreateGroupControlContent & { value: "On" | "Off" };
  create: CreateGroupControlContent;
  cancel: CreateGroupControlContent;
  helper: string;
};

const HELP_BY_FOCUS: Record<CreateGroupFocus, string> = {
  name: "Type name · ↑↓ focus · Esc cancel",
  quickSession: "Enter/Q toggle · ↑↓ focus · Esc cancel",
  create: "←→ action · Enter create · Esc cancel",
  cancel: "←→ action · Enter cancel",
};

/** Builds the renderer-neutral Create Group sheet model from typed screen state. */
export function createGroupSheetContent(screen: CreateGroupScreenView): CreateGroupSheetContent {
  const enabled = !screen.submitting;
  return {
    name: control(screen, "name", "Name", "N", enabled),
    quickSession: {
      ...control(screen, "quickSession", "Quick session", "Q", enabled),
      value: screen.quickSession ? "On" : "Off",
    },
    create: control(
      screen,
      "create",
      screen.submitting ? "Creating…" : "Create Group",
      "C",
      enabled && screen.draftName.value.trim().length > 0,
    ),
    cancel: control(screen, "cancel", "Cancel", "Esc", enabled),
    helper: screen.submitting ? "Creating Group…" : HELP_BY_FOCUS[screen.focus],
  };
}

function control(
  screen: CreateGroupScreenView,
  actionId: CreateGroupActionId,
  label: string,
  accelerator: string,
  enabled: boolean,
): CreateGroupControlContent {
  return {
    actionId,
    label,
    accelerator,
    enabled,
    focused: screen.focus === actionId,
  };
}
