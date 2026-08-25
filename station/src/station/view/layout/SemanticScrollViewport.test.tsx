import { afterEach, describe, expect, it } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { SemanticScrollViewport } from "./SemanticScrollViewport.js";
import {
  createScrollViewportController,
  semanticItemRenderableId,
} from "./scrollViewport.js";

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

describe("SemanticScrollViewport", () => {
  it("uses its renderer index for steady-state scroll and rebuilt semantic nodes", async () => {
    const itemIds = Array.from({ length: 512 }, (_, index) => `item-${index}`);
    const controller = createScrollViewportController<string>();
    let remountItems: (() => void) | undefined;

    function IndexedViewport() {
      const [generation, setGeneration] = useState(0);
      remountItems = () => setGeneration((current) => current + 1);
      return (
        <box width={24} height={6} flexDirection="column">
          <SemanticScrollViewport
            controller={controller}
            itemIds={itemIds}
            viewportId="indexed-semantic-viewport"
          >
            {itemIds.map((itemId, index) => (
              <box
                key={`${generation}:${itemId}`}
                id={semanticItemRenderableId(itemId)}
                height={index % 2 === 0 ? 1 : 2}
                flexShrink={0}
              />
            ))}
          </SemanticScrollViewport>
        </box>
      );
    }

    const setup = await testRender(<IndexedViewport />, { width: 24, height: 6 });
    teardowns.push(() => setup.renderer.destroy());
    await setup.flush();
    const viewport = setup.renderer.root.findDescendantById("indexed-semantic-viewport");
    if (!(viewport instanceof ScrollBoxRenderable)) {
      throw new Error("semantic viewport did not render");
    }

    let recursiveLookups = 0;
    const findDescendantById = viewport.content.findDescendantById.bind(viewport.content);
    viewport.content.findDescendantById = (id) => {
      recursiveLookups += 1;
      return findDescendantById(id);
    };

    controller.scrollBy(400);
    controller.follow("item-400");
    expect(controller.snapshot()).toContain("item-400");
    expect(recursiveLookups).toBe(0);

    const remount = remountItems;
    if (remount === undefined) throw new Error("semantic item remount control was not installed");
    await act(async () => remount());
    await setup.flush();
    controller.follow("item-400");

    expect(controller.snapshot()).toContain("item-400");
    expect(recursiveLookups).toBe(0);
  });

  it("publishes an empty measured window at initial and resized zero height", async () => {
    const itemIds = ["one", "two", "three"] as const;
    const controller = createScrollViewportController<string>();
    const setup = await testRender(
      <box width={20} height={3} flexDirection="column">
        <SemanticScrollViewport
          controller={controller}
          itemIds={itemIds}
          viewportId="zero-height-semantic-viewport"
        >
          {itemIds.map((itemId) => (
            <box
              key={itemId}
              id={semanticItemRenderableId(itemId)}
              height={1}
              flexShrink={0}
            />
          ))}
        </SemanticScrollViewport>
      </box>,
      { width: 20, height: 5 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.flush();
    const viewport = setup.renderer.root.findDescendantById("zero-height-semantic-viewport");
    if (!(viewport instanceof ScrollBoxRenderable)) {
      throw new Error("zero-height semantic viewport did not render");
    }
    let measuredHeight = 0;
    Object.defineProperty(viewport.viewport, "height", {
      configurable: true,
      get: () => measuredHeight,
    });
    controller.detach(viewport);
    controller.attach(viewport, itemIds);
    expect(controller.snapshot()).toEqual([]);

    measuredHeight = 3;
    controller.synchronize();
    expect(controller.snapshot()).toEqual(itemIds);

    measuredHeight = 0;
    controller.synchronize();
    expect(controller.snapshot()).toEqual([]);
  });
});
