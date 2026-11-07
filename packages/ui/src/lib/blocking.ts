import type { ReportReason } from "@ownbase/protocol";

/** Each reason for a report as people would put it (E12). */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Harassment or bullying",
  inappropriate: "Inappropriate or offensive",
  other: "Something else",
};
