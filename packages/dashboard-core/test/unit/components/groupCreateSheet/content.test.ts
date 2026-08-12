import { describe, expect, it } from "vitest";
import { createGroupSheetContent } from "../../../../src/components/GroupCreateSheet/content.js";

describe("createGroupSheetContent", () => {
  it("exposes renderer-neutral controls and disables submission while blank", () => {
    const content = createGroupSheetContent({
      name: "createGroup",
      projectId: "web",
      draftName: { value: "", cursor: 0 },
      quickSession: false,
      focus: "name",
      submitting: false,
      returnTo: "projectMenu",
    });

    expect(content.name).toMatchObject({ actionId: "name", focused: true, enabled: true });
    expect(content.quickSession).toMatchObject({
      actionId: "quickSession",
      value: "Off",
      focused: false,
    });
    expect(content.create).toMatchObject({ actionId: "create", enabled: false });
    expect(content.cancel).toMatchObject({ actionId: "cancel", enabled: true });
  });

  it("makes every control inert while submission is pending", () => {
    const content = createGroupSheetContent({
      name: "createGroup",
      projectId: "web",
      draftName: { value: "Group", cursor: 5 },
      quickSession: true,
      focus: "create",
      submitting: true,
      returnTo: "projectMenu",
    });

    expect(
      [content.name, content.quickSession, content.create, content.cancel].every(
        (item) => !item.enabled,
      ),
    ).toBe(true);
  });
});
