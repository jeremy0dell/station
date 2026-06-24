// The pure toast presentation — title by kind, border color name by kind,
// detail assembly, text width. Render adapters map the color names to their
// own palette (Ink color names, Station theme hex).
import type { TuiToastEntry } from "../../state/types.js";

export type ToastBorderColorName = "red" | "gray" | "green";

export function toastDetail(entry: TuiToastEntry): string | undefined {
  const details: string[] = [];
  const { toast } = entry;
  if (toast.hint !== undefined) {
    details.push(toast.hint);
  }
  if (toast.traceId !== undefined) {
    details.push(`trace ${toast.traceId}`);
  }
  if (toast.diagnosticId !== undefined) {
    details.push(`diagnostic ${toast.diagnosticId}`);
  }
  return details.length === 0 ? undefined : details.join(" | ");
}

export function toastTitle(entry: TuiToastEntry): string {
  if (entry.toast.kind === "error") {
    return "needs attention";
  }
  if (entry.toast.kind === "info") {
    return "notice";
  }
  return entry.toast.message === "Observer reconnected." ? "connected" : "saved";
}

export function toastBorderColor(entry: TuiToastEntry): ToastBorderColorName {
  if (entry.toast.kind === "error") {
    return "red";
  }
  if (entry.toast.kind === "info") {
    return "gray";
  }
  return "green";
}

export function toastTextWidth(contentWidth: number): number {
  return Math.max(1, contentWidth - 2);
}
