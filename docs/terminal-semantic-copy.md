# Terminal Semantic Copy

Status: Station protocol version 1 is implemented; child-renderer adoption is opt-in.

Station pane drag selection distinguishes terminal-generated wraps, cooperating
application wraps, and hard line boundaries without inspecting provider events or
transcripts. The producing renderer is the only layer that knows whether a painted
row continues source text, so Station accepts a bounded row-boundary protocol rather
than guessing from pane width or output content.

## Product behavior

Plain drag-copy inside a native Station pane:

- joins xterm-native soft wraps without a newline;
- joins marked application continuations without a newline;
- preserves genuine hard boundaries as newlines;
- preserves unmarked child-TUI rows rather than guessing.

OpenTUI's global selection and an outer terminal's Shift/Ctrl selection do not use
pane row metadata. Application-owned copy commands, including Pi's whole-message
`Ctrl-X`, are unchanged.

## Capability

Every newly spawned Station-owned child PTY receives:

```text
TERM_PROGRAM=Station
STATION_SEMANTIC_COPY=1
```

Both values are generated at the final local, Bun, or Station Host PTY boundary.
They are not user configuration and launch input cannot replace them. Existing PTYs
retain the environment captured when they were spawned.

A cooperating child must require both exact values. It must not emit Station markers
through a known but unverified intervening multiplexer. Old and unsupported children
ignore the capability and retain hard-row copy behavior.

## Version 1 wire marker

A renderer writes this sequence immediately before semantic content on each
synthetic continuation row:

```text
OSC 6973 ; station-copy ; 1 ; <separator-space-count> ST
```

`separator-space-count` is an ASCII decimal integer from `0` through `1024`.
Station derives the semantic content column from xterm's cursor when the marker is
parsed. Visual indentation, borders, list markers, and component padding therefore
remain visible before the marker but cannot be claimed as arbitrary hidden text.

The marker can only:

- identify the current row as continuing the previous row;
- omit the visible prefix before the marker when the previous selected row is also
  selected;
- right-trim renderer padding from the previous row;
- restore the declared count of consumed ASCII spaces.

It cannot insert arbitrary text or copy by itself. Malformed, unsupported, and
oversized OSC 6973 payloads are consumed invisibly and ignored. Diagnostics must not
include the payload.

Native xterm `isWrapped` state has precedence over an application marker. No marker
means a hard line boundary.

## VT and replay ownership

One semantic-copy state helper is installed on both the pane's `StationVtScreen` and
the Station Host's headless semantic terminal. It uses xterm-owned line markers so
metadata follows normal scrollback, alternate-buffer scrolling, line insertion,
line deletion, resize reflow, and eviction. Row erase, display erase, DECSTR, RIS,
and buffer clearing remove stale state.

Complete Host replay contains the original OSC bytes, so it carries no separate
sidecar. When raw history has been evicted, Host protocol 6 sends exact serialized
VT followed by exactly one `semantic-copy` event containing only bounded normal- and
alternate-buffer row numbers, prefix columns, and separator counts. An explicit empty
sidecar clears stale state. Station applies the sidecar after VT reaches idle and
before queued live frames or pane-geometry recovery.

A sidecar row that no longer maps to the restored buffer is dropped with a
content-free terminal diagnostic; the live PTY remains attached. Control-only live
reset recovery uses RIS and contains no history or semantic-copy event.

## Privacy and security

- Selected text never enters Observer, Station Host metadata, provider integrations,
  or lifecycle events.
- Semantic snapshots contain bounded integers only.
- Core and Station UI code never branch on harness or provider identity.
- The Pi lifecycle extension continues carrying correlation and lifecycle metadata
  only; it does not read session files or send transcript bodies.
- A marker affects only user-initiated pane selection and never invokes a clipboard
  sink itself.

## Child renderer guidance

The renderer that performs wrapping should mark synthetic continuation segments at
render time. Literal `\n`, `\r\n`, and `\r` boundaries remain unmarked. Long-token
splits use zero separator spaces; word wrapping reports the exact number of consumed
ASCII spaces. ANSI styles and OSC 8 hyperlinks may surround the marker because it is
zero-width.

Pi support belongs in `@earendil-works/pi-tui`'s wrapping implementation, not in
Station's Pi extension. Station's currently pinned Pi 0.80.10 fixture does not emit
this protocol; it remains launchable with existing row-preserving drag copy and
`Ctrl-X` whole-message copy. Station should pin and document a supporting Pi release
only after that upstream release exists.

## Manual verification

In a compatible child TUI inside a newly spawned native Station pane, drag-select a
long wrapped shell command and inspect the clipboard:

```bash
pbpaste | python3 -c 'import sys; s=sys.stdin.read(); print("line breaks:", s.count("\n") + s.count("\r")); print(repr(s))'
```

The wrapped command should report zero line breaks. A two-source-line block should
report exactly one. Repeat after scrolling into history, resizing, complete Host
reattach, and semantic recovery after the 256 KiB raw replay budget is exceeded.
