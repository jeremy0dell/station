import type { ObserverSqliteMigration } from "./index.js";

export const nativeBindingIngressClaimsMigration: ObserverSqliteMigration = {
  version: 14,
  name: "native_binding_ingress_claims",
  sql: `
    -- Earlier claims did not cover native binding or derived state; replay them once.
    DELETE FROM hook_ingress_dedupe
    WHERE kind IN ('harness_report', 'hook_processing');
  `,
};
