import { attributesWithLink, type OptimizedBuffer } from "@opentui/core";

const OPEN_TUI_LINK_URI_MAX_BYTES = 512;
const OPEN_TUI_LINK_ID_MAX = 0xffffff;
const ABSOLUTE_URI_STRUCTURE =
  /^[A-Za-z][A-Za-z0-9+.-]*:[^?#]*(?:\?[^#]*)?(?:#[^#]*)?$/u;
const INVALID_URI_CHARACTER =
  /[^A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%+\-\u00a0-\u{10ffff}]/u;
const INVALID_PERCENT_ESCAPE = /%(?![A-Fa-f0-9]{2})/u;
const UTF8_ENCODER = new TextEncoder();

type OpenTuiLinkAllocator = {
  linkAlloc?(uri: string): number;
};

/**
 * Validates an exact URI and packs a native OpenTUI 0.4.1 link ID into SGR attributes.
 * OpenTUI accepts at most 512 UTF-8 bytes; IDs are allocated for each draw and never cached in
 * TypeScript so the native generation and per-buffer refcount lifecycle owns reuse and cleanup.
 */
export function attributesWithOpenTuiHyperlink(
  buffer: OptimizedBuffer,
  attributes: number,
  uri: string,
): number {
  if (!isValidOpenTuiHyperlink(uri)) {
    return attributes;
  }

  try {
    // `OptimizedBuffer.lib.linkAlloc` exists in OpenTUI 0.4.1 at runtime but is
    // omitted from its RenderLib declaration; keep that pinned cast at this adapter.
    const linkId = (buffer.lib as OpenTuiLinkAllocator).linkAlloc?.(uri);
    if (
      linkId === undefined ||
      !Number.isInteger(linkId) ||
      linkId <= 0 ||
      linkId > OPEN_TUI_LINK_ID_MAX
    ) {
      return attributes;
    }
    return attributesWithLink(attributes, linkId);
  } catch {
    return attributes;
  }
}

function isValidOpenTuiHyperlink(uri: string): boolean {
  if (uri.length > OPEN_TUI_LINK_URI_MAX_BYTES) {
    return false;
  }
  if (
    !ABSOLUTE_URI_STRUCTURE.test(uri) ||
    INVALID_URI_CHARACTER.test(uri) ||
    INVALID_PERCENT_ESCAPE.test(uri) ||
    hasMalformedSurrogate(uri) ||
    !URL.canParse(uri)
  ) {
    return false;
  }
  return UTF8_ENCODER.encode(uri).byteLength <= OPEN_TUI_LINK_URI_MAX_BYTES;
}

function hasMalformedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
