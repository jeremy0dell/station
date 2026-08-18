import { isReturnKey, type TuiKey } from "./keys.js";

export type SettingsPanelNavigationItem<ItemId extends string> = {
  id: ItemId;
  shortcut?: string;
};

export type SettingsPanelListIntent<ItemId extends string> =
  | { type: "none" }
  | { type: "close" }
  | { type: "select"; itemId: ItemId }
  | { type: "openDetail" };

export type ResolveSettingsPanelListIntentOptions = {
  closeOnLeft: boolean;
};

/** Resolves shared settings-list navigation without owning feature drafts or detail behavior. */
export function resolveSettingsPanelListIntent<ItemId extends string>(
  items: readonly SettingsPanelNavigationItem<ItemId>[],
  activeId: ItemId,
  key: TuiKey,
  options: ResolveSettingsPanelListIntentOptions,
): SettingsPanelListIntent<ItemId> {
  if (key.escape === true || (options.closeOnLeft && key.leftArrow === true)) {
    return { type: "close" };
  }
  const direct = items.find((item) => item.shortcut === key.input);
  if (direct !== undefined && direct.id !== activeId) {
    return { type: "select", itemId: direct.id };
  }
  if (key.upArrow === true || key.downArrow === true) {
    const currentIndex = Math.max(
      0,
      items.findIndex((item) => item.id === activeId),
    );
    const nextIndex = Math.min(
      items.length - 1,
      Math.max(0, currentIndex + (key.upArrow === true ? -1 : 1)),
    );
    const next = items[nextIndex];
    return next === undefined || next.id === activeId
      ? { type: "none" }
      : { type: "select", itemId: next.id };
  }
  if (key.rightArrow === true || isReturnKey(key)) {
    return { type: "openDetail" };
  }
  return { type: "none" };
}
