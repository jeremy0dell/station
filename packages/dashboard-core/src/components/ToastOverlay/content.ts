// Pure toast presentation: title, readable copy text, detail assembly, and
// border color. Render adapters map color names to their own palette.
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

/** The complete readable notice copied by the explicit toast action. */
export function toastCopyText(entry: TuiToastEntry): string {
  const lines = [toastTitle(entry), entry.toast.message];
  const detail = toastDetail(entry);
  if (detail !== undefined) {
    lines.push(detail);
  }
  return lines.join("\n");
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
