import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { getLinkId, OptimizedBuffer, RGBA, TextAttributes } from "@opentui/core";
import { attributesWithOpenTuiHyperlink } from "./openTuiHyperlinks.js";

const buffers: OptimizedBuffer[] = [];

afterEach(() => {
  for (const buffer of buffers.splice(0)) {
    buffer.destroy();
  }
});

function allocatingBuffer(allocated: string[], linkId = 42): OptimizedBuffer {
  return {
    lib: {
      linkAlloc: (uri: string) => {
        allocated.push(uri);
        return linkId;
      },
    },
  } as unknown as OptimizedBuffer;
}

describe("attributesWithOpenTuiHyperlink", () => {
  it("preserves accepted hierarchical and opaque URIs exactly", () => {
    const allocated: string[] = [];
    const buffer = allocatingBuffer(allocated);
    const uris = [
      "https://example.com/A%2Fb?q=One%20Two#Exact",
      "file:///tmp/Station%20Link",
      "mailto:Person+Station@example.com?subject=Exact%20Case",
      "custom+opaque:Value/That?Must=Remain#Exact",
    ];

    for (const uri of uris) {
      const attributes = attributesWithOpenTuiHyperlink(buffer, TextAttributes.BOLD, uri);
      expect(getLinkId(attributes)).toBe(42);
      expect(attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    }
    expect(allocated).toEqual(uris);
  });

  it("accepts exactly 512 UTF-8 bytes and rejects larger values", () => {
    const allocated: string[] = [];
    const buffer = allocatingBuffer(allocated);
    const asciiBoundary = `x:${"a".repeat(510)}`;
    const unicodeBoundary = `x:${"é".repeat(255)}`;

    expect(getLinkId(attributesWithOpenTuiHyperlink(buffer, 0, asciiBoundary))).toBe(42);
    expect(getLinkId(attributesWithOpenTuiHyperlink(buffer, 0, unicodeBoundary))).toBe(42);
    expect(attributesWithOpenTuiHyperlink(buffer, TextAttributes.ITALIC, `${asciiBoundary}a`)).toBe(
      TextAttributes.ITALIC,
    );
    expect(attributesWithOpenTuiHyperlink(buffer, TextAttributes.ITALIC, `${unicodeBoundary}é`)).toBe(
      TextAttributes.ITALIC,
    );
    expect(allocated).toEqual([asciiBoundary, unicodeBoundary]);
  });

  it("rejects malformed absolute URIs", () => {
    const allocated: string[] = [];
    const buffer = allocatingBuffer(allocated);
    const invalidUris = [
      "https:",
      "https://exa mple.com/path",
      "https://example.com/%ZZ",
      "https://example.com/percent%",
      "x:{not-a-uri}",
      "x:pipe|tail",
      "x:fragment#one#two",
      "https://example.com/bell\u0007tail",
      "https://example.com/escape\u001btail",
      "https://example.com/del\u007ftail",
      "https://example.com/c1\u0085tail",
      "https://example.com/high\ud800tail",
      "https://example.com/low\udc00tail",
      "//example.com/no-scheme",
      "1invalid:scheme",
      ":empty",
    ];

    for (const uri of invalidUris) {
      expect(attributesWithOpenTuiHyperlink(buffer, TextAttributes.UNDERLINE, uri)).toBe(
        TextAttributes.UNDERLINE,
      );
    }
    expect(allocated).toEqual([]);
  });

  it("pins OpenTUI 0.4.1 native allocation, reuse, and refcount-owned generation", async () => {
    const packageJson = JSON.parse(
      await readFile(
        new URL("../../node_modules/@opentui/core/package.json", import.meta.url),
        "utf8",
      ),
    ) as { version?: string };
    expect(packageJson.version).toBe("0.4.1");

    const buffer = OptimizedBuffer.create(4, 1, "unicode");
    buffers.push(buffer);
    const uri = "https://example.com/native-lifetime";
    const firstAttributes = attributesWithOpenTuiHyperlink(buffer, TextAttributes.BOLD, uri);
    const firstId = getLinkId(firstAttributes);
    expect(firstId).toBeGreaterThan(0);

    buffer.drawText("A", 0, 0, RGBA.fromValues(1, 1, 1, 1), undefined, firstAttributes);
    const reusedId = getLinkId(attributesWithOpenTuiHyperlink(buffer, 0, uri));
    expect(reusedId).toBe(firstId);
    const nativeLib = buffer.lib as unknown as { linkGetUrl(linkId: number): string };
    expect(nativeLib.linkGetUrl(firstId)).toBe(uri);

    buffer.clear();
    const nextGenerationId = getLinkId(attributesWithOpenTuiHyperlink(buffer, 0, uri));
    expect(nextGenerationId).toBeGreaterThan(0);
    expect(nextGenerationId).not.toBe(firstId);
    expect(nativeLib.linkGetUrl(nextGenerationId)).toBe(uri);
  });

  it("fails closed when the pinned runtime allocator is unavailable", () => {
    const buffer = { lib: {} } as OptimizedBuffer;
    expect(attributesWithOpenTuiHyperlink(buffer, TextAttributes.DIM, "https://example.com")).toBe(
      TextAttributes.DIM,
    );
  });
});
