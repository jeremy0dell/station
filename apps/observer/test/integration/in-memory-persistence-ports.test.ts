import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence";
import { observerPersistenceContract } from "../support/observerPersistenceContract";

observerPersistenceContract("in-memory", ({ clock, idFactory }) => ({
  persistence: createInMemoryObserverPersistence({ clock, idFactory }),
}));
