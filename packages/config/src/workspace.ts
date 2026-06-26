import { z } from "zod";

/**
 * Native Station workspace settings. These live in the `[workspace]` section of
 * the runtime config (`~/.config/station/config.toml`) and are consumed only by
 * the native Station TUI; the observer and CLI ignore them. Keys stay snake_case
 * (matching the TOML) because the global normalizer does not recurse into this
 * section — see normalize.ts.
 */

/**
 * While scrolled up: `freeze` preserves visible lines, `shift` preserves bottom
 * distance, and `follow` snaps live. At bottom, all modes track live output.
 */
export const SCROLL_ON_OUTPUT_MODES = ["freeze", "shift", "follow"] as const;
export type ScrollOnOutputMode = (typeof SCROLL_ON_OUTPUT_MODES)[number];

/**
 * One automation pane: split from `origin` or `previous`, write or execute its
 * command, and optionally focus it.
 */
const AutomationStepSchema = z
  .object({
    split: z.enum(["right", "below"]).default("right"),
    anchor: z.enum(["origin", "previous"]).default("previous"),
    command: z.string().min(1),
    run: z.enum(["execute", "write"]).default("execute"),
    focus: z.boolean().default(false),
  })
  .strict();

export type AutomationStep = z.infer<typeof AutomationStepSchema>;

/**
 * Named user-triggerable pane layout for the focused worktree; `enabled:false`
 * hides it from the context menu.
 */
const AutomationSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean().default(true),
    steps: z.array(AutomationStepSchema).min(1),
  })
  .strict();

export type Automation = z.infer<typeof AutomationSchema>;

// diffnav's default watch command omits untracked files, so Station supplies one.
const DEFAULT_DIFF_WATCH_COMMAND = [
  'base="$(git merge-base origin/main HEAD 2>/dev/null || true)"',
  '[ -n "$base" ] || base=HEAD',
  '{ git diff --no-color "$base" -- . || true; git ls-files --others --exclude-standard -- . | while IFS= read -r file; do [ -e "$file" ] || continue; printf "\\n"; git diff --no-color --no-index -- /dev/null "$file" || true; done; }',
].join("; ");

const DEFAULT_DIFF_COMMAND = [
  "diffnav --unified --watch",
  `--watch-cmd '${DEFAULT_DIFF_WATCH_COMMAND}'`,
  "--watch-interval 2s",
].join(" ");

const DEFAULT_DIFF_AUTOMATION: Automation = {
  id: "see-diff",
  label: "See diff (split right)",
  enabled: true,
  steps: [
    {
      split: "right",
      anchor: "origin",
      command: DEFAULT_DIFF_COMMAND,
      run: "execute",
      focus: true,
    },
  ],
};

// Strict so a typo'd key or value surfaces (as a section diagnostic / fallback to
// defaults) instead of silently reverting. Every field carries a default, so an
// empty or missing `[workspace]` section parses to a fully-populated config.
export const WorkspaceConfigSchema = z
  .object({
    scroll_on_output: z.enum(SCROLL_ON_OUTPUT_MODES).default("freeze"),
    // Show the welcome screen as an intro over the restored layout on every cold
    // boot; dismiss it to drop into your sessions. Off boots straight in.
    welcome_on_boot: z.boolean().default(true),
    // Named pane layouts in the pane context menu; defaults to the single diff automation so an empty
    // section still ships it. Ids must be unique: they key the menu rows and run-dispatch lookup, so a
    // duplicate would shadow a row and collide keys — reject (warn + defaults) rather than ship a dead item.
    automations: z
      .array(AutomationSchema)
      .superRefine((automations, ctx) => {
        const seen = new Set<string>();
        for (const automation of automations) {
          if (seen.has(automation.id)) {
            ctx.addIssue({
              code: "custom",
              message: `duplicate automation id "${automation.id}"`,
            });
          }
          seen.add(automation.id);
        }
      })
      .default([DEFAULT_DIFF_AUTOMATION]),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = WorkspaceConfigSchema.parse({});
