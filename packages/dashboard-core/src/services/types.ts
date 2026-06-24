export type {
  ClientNotice as TuiToast,
  ObserverService as TuiObserverService,
  StationClientCommandCompletion as TuiCommandCompletion,
} from "@station/client";

export type TuiRunResult = {
  status: "exited";
  code: number;
};
