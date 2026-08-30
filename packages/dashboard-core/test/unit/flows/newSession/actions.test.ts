import { describe, expect, it } from "vitest";
import {
  newSessionIntentForAction,
  newSessionIntentForInput,
} from "../../../../src/flows/newSession/actions.js";
import {
  chooseNewSessionAgentById,
  createNewSessionFlow,
  transitionNewSessionFlow,
} from "../../../../src/flows/newSession/flow.js";
import { applyInput, createHarnessSnapshot, input, typeName } from "./support.js";

describe("New Session actions", () => {
  it("cycles review focus with arrows and activates the focused field with Enter", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    expect(opened.reviewFocus).toBe("create");

    expect(newSessionIntentForInput(opened, input("\r", { return: true }))).toEqual({
      type: "submit",
    });
    expect(newSessionIntentForInput(opened, input("", { downArrow: true }))).toEqual({
      type: "transition",
      action: { type: "reviewFocus", dir: 1 },
    });
    const onProject = transitionNewSessionFlow(opened, { type: "reviewFocus", dir: 1 });
    if (onProject?.mode !== "review") throw new Error("expected review");
    expect(onProject.reviewFocus).toBe("project");
    expect(newSessionIntentForInput(onProject, input("\r", { return: true }))).toEqual({
      type: "transition",
      action: { type: "pickProject" },
    });

    const onName = transitionNewSessionFlow(onProject, { type: "reviewFocus", dir: 1 });
    if (onName?.mode !== "review") throw new Error("expected review");
    expect(onName.reviewFocus).toBe("name");
    expect(newSessionIntentForInput(onName, input("\r", { return: true }))).toEqual({
      type: "transition",
      action: { type: "editName" },
    });
    expect(newSessionIntentForInput(onName, input("A"))).toEqual({
      type: "transition",
      action: { type: "pickAgent" },
    });
    expect(newSessionIntentForInput(onName, input("C"))).toEqual({ type: "submit" });
  });

  it("keeps input interpretation out of the app input handler", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    expect(newSessionIntentForInput(opened, input("P"))).toEqual({
      type: "transition",
      action: { type: "pickProject" },
    });
    expect(newSessionIntentForInput(opened, input("N"))).toEqual({
      type: "transition",
      action: { type: "editName" },
    });
    expect(newSessionIntentForInput(opened, input("G"))).toEqual({
      type: "transition",
      action: { type: "pickGroup" },
    });
    expect(newSessionIntentForInput(opened, input("E"))).toEqual({ type: "none" });
    expect(newSessionIntentForInput(opened, input("p"))).toEqual({ type: "none" });
    expect(newSessionIntentForInput(opened, input("a"))).toEqual({ type: "none" });
    expect(newSessionIntentForInput(opened, input("\r", { return: true }))).toEqual({
      type: "submit",
    });

    const picker = transitionNewSessionFlow(opened, { type: "pickAgent" });
    if (picker?.mode !== "pickAgent") throw new Error("expected agent picker");
    expect(newSessionIntentForInput(picker, input("2"))).toEqual({ type: "none" });
    expect(chooseNewSessionAgentById(picker, snapshot, "opencode")).toMatchObject({
      mode: "review",
      selectedHarness: "opencode",
    });
  });

  it("yields no pick-step intent for any key because the selection engine owns them", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const picker = transitionNewSessionFlow(opened, { type: "pickProject" });
    if (picker?.mode !== "pickProject") throw new Error("expected project picker");

    for (const key of [
      input("0"),
      input("2"),
      input("j"),
      input("", { downArrow: true }),
      input("", { upArrow: true }),
      input("\r", { return: true }),
    ]) {
      expect(newSessionIntentForInput(picker, key)).toEqual({ type: "none" });
    }
  });

  it("uses vertical movement into the action row and horizontal movement within it", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");
    expect(editing.editNameFocus).toBe("name");

    const saveIntent = newSessionIntentForInput(editing, input("", { downArrow: true }));
    expect(saveIntent).toEqual({
      type: "transition",
      action: { type: "editNameFocusSet", focus: "save" },
    });
    if (saveIntent.type !== "transition") throw new Error("expected transition");
    const saveFocused = transitionNewSessionFlow(editing, saveIntent.action);
    expect(saveFocused).toMatchObject({ mode: "editName", editNameFocus: "save" });
    if (saveFocused?.mode !== "editName") throw new Error("expected edit mode");

    expect(newSessionIntentForInput(saveFocused, input("x"))).toEqual({ type: "none" });
    expect(newSessionIntentForInput(saveFocused, input("\r", { return: true }))).toEqual({
      type: "transition",
      action: { type: "commitName" },
    });

    const backIntent = newSessionIntentForInput(saveFocused, input("", { rightArrow: true }));
    expect(backIntent).toEqual({
      type: "transition",
      action: { type: "editNameFocusSet", focus: "back" },
    });
    if (backIntent.type !== "transition") throw new Error("expected transition");
    const backFocused = transitionNewSessionFlow(saveFocused, backIntent.action);
    if (backFocused?.mode !== "editName") throw new Error("expected edit mode");
    expect(backFocused.editNameFocus).toBe("back");
    expect(newSessionIntentForInput(backFocused, input("\r", { return: true }))).toEqual({
      type: "transition",
      action: { type: "cancel" },
    });
    expect(newSessionIntentForInput(backFocused, input("", { upArrow: true }))).toEqual({
      type: "transition",
      action: { type: "editNameFocusSet", focus: "name" },
    });
    expect(newSessionIntentForInput(backFocused, input("", { escape: true }))).toEqual({
      type: "transition",
      action: { type: "cancel" },
    });
  });

  it("resolves visible controls directly without generated input paths", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    expect(newSessionIntentForAction(opened, "review.project")).toEqual({
      type: "transition",
      action: { type: "pickProject" },
    });
    expect(newSessionIntentForAction(opened, "review.create")).toEqual({ type: "submit" });

    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");
    const saveFocused = transitionNewSessionFlow(editing, {
      type: "editNameFocusSet",
      focus: "save",
    });
    if (saveFocused?.mode !== "editName") throw new Error("expected edit mode");
    const focusName = newSessionIntentForAction(saveFocused, "editName.name");
    expect(focusName).toEqual({
      type: "transition",
      action: { type: "editNameFocusSet", focus: "name" },
    });
    if (focusName.type !== "transition") throw new Error("expected transition");
    expect(transitionNewSessionFlow(saveFocused, focusName.action)).toMatchObject({
      mode: "editName",
      editNameFocus: "name",
    });
    expect(newSessionIntentForAction(saveFocused, "editName.save")).toEqual({
      type: "transition",
      action: { type: "commitName" },
    });
    expect(newSessionIntentForAction(saveFocused, "editName.back")).toEqual({
      type: "transition",
      action: { type: "cancel" },
    });
  });

  it("keeps Enter and Ctrl-S as predictable name-save paths", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");

    expect(newSessionIntentForInput(editing, input("\r", { return: true }))).toEqual({
      type: "transition",
      action: { type: "commitName" },
    });
    expect(newSessionIntentForInput(editing, input("s", { ctrl: true }))).toEqual({
      type: "transition",
      action: { type: "commitName" },
    });
  });

  it("moves the edit-name cursor and edits at the insertion point", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");

    const typed = typeName(editing, "feature/foo");
    const movedOnce = applyInput(typed, "", { leftArrow: true });
    const movedTwice = applyInput(movedOnce, "", { leftArrow: true });
    const movedLeft = applyInput(movedTwice, "", { leftArrow: true });
    if (movedLeft.mode !== "editName") throw new Error("expected edit mode");
    expect(movedLeft.draftName.cursor).toBe(8);

    const inserted = applyInput(movedLeft, "-bar");
    expect(inserted).toMatchObject({
      mode: "editName",
      draftName: { value: "feature/-barfoo", cursor: 12 },
    });

    const backspaced = applyInput(inserted, "", { backspace: true });
    expect(backspaced).toMatchObject({
      mode: "editName",
      draftName: { value: "feature/-bafoo", cursor: 11 },
    });

    const deleted = applyInput(backspaced, "", { delete: true });
    expect(deleted).toMatchObject({
      mode: "editName",
      draftName: { value: "feature/-baoo", cursor: 11 },
    });
  });

  it("treats Ctrl-U as delete-before-cursor in edit-name", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");

    const typed = typeName(editing, "featurefoo");
    const movedOnce = applyInput(typed, "", { leftArrow: true });
    const movedTwice = applyInput(movedOnce, "", { leftArrow: true });
    const movedLeft = applyInput(movedTwice, "", { leftArrow: true });

    expect(newSessionIntentForInput(movedLeft, input("u", { ctrl: true }))).toEqual({
      type: "transition",
      action: { type: "editNameInput", action: { type: "deleteBeforeCursor" } },
    });
    expect(applyInput(movedLeft, "u", { ctrl: true })).toMatchObject({
      mode: "editName",
      draftName: { value: "foo", cursor: 0 },
    });
  });

  it("maps left and right arrows to edit-name cursor movement", () => {
    const snapshot = createHarnessSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");
    const editing = transitionNewSessionFlow(opened, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit mode");

    expect(newSessionIntentForInput(editing, input("", { leftArrow: true }))).toEqual({
      type: "transition",
      action: { type: "editNameInput", action: { type: "moveCursor", delta: -1 } },
    });
    expect(newSessionIntentForInput(editing, input("", { rightArrow: true }))).toEqual({
      type: "transition",
      action: { type: "editNameInput", action: { type: "moveCursor", delta: 1 } },
    });
  });
});
