import type { ObserverSqliteMigration } from "./migration.js";

export const renameTerminalExternalFocusMigration: ObserverSqliteMigration = {
  version: 20,
  name: "rename_terminal_external_focus",
  sql: `
    UPDATE provider_observations
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.externallyFocusable',
        json(CASE json_type(payload_json, '$.focusable') WHEN 'true' THEN 'true' ELSE 'false' END)
      ),
      '$.focusable'
    )
    WHERE entity_kind = 'terminal_target'
      AND json_type(payload_json, '$.focusable') IN ('true', 'false');

    UPDATE events
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.row.terminal.externallyFocusable',
        json(CASE json_type(payload_json, '$.row.terminal.focusable') WHEN 'true' THEN 'true' ELSE 'false' END)
      ),
      '$.row.terminal.focusable'
    )
    WHERE type = 'worktree.added'
      AND json_type(payload_json, '$.row.terminal.focusable') IN ('true', 'false');

    UPDATE events
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.patch.terminal.externallyFocusable',
        json(CASE json_type(payload_json, '$.patch.terminal.focusable') WHEN 'true' THEN 'true' ELSE 'false' END)
      ),
      '$.patch.terminal.focusable'
    )
    WHERE type = 'worktree.updated'
      AND json_type(payload_json, '$.patch.terminal.focusable') IN ('true', 'false');

    UPDATE events
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.session.terminal.externallyFocusable',
        json(CASE json_type(payload_json, '$.session.terminal.focusable') WHEN 'true' THEN 'true' ELSE 'false' END)
      ),
      '$.session.terminal.focusable'
    )
    WHERE type = 'session.created'
      AND json_type(payload_json, '$.session.terminal.focusable') IN ('true', 'false');

    UPDATE events
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.patch.terminal.externallyFocusable',
        json(CASE json_type(payload_json, '$.patch.terminal.focusable') WHEN 'true' THEN 'true' ELSE 'false' END)
      ),
      '$.patch.terminal.focusable'
    )
    WHERE type = 'session.updated'
      AND json_type(payload_json, '$.patch.terminal.focusable') IN ('true', 'false');
  `,
};
