import { createInMemoryObserverPersistence } from "../../src/persistence/inMemoryAdapter";
import { observerPersistenceContract } from "../support/observerPersistenceContract";

observerPersistenceContract("in-memory", ({ clock, idFactory }) => ({
  persistence: createInMemoryObserverPersistence({ clock, idFactory }),
}));
