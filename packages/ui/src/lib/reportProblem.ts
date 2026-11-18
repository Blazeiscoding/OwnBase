import { operatingSystem } from "./account.js";

/**
 * The link to the project's bug form, with the fields the app can fill
 * itself. GitHub fills an issue form's fields from the query string by each
 * field's `id` (`.github/ISSUE_TEMPLATE/bug_report.yml`). Only the version,
 * where and the system travel in the address: the diagnostics report names
 * the workspace's address and people, so it is pasted by hand or not at all.
 */
export const BUG_FORM = "https://github.com/Blazeiscoding/OwnBase/issues/new";

/** The form's "Where it happens" options this app can be, word for word. */
export const REPORT_WHERE = ["Desktop app", "In a web browser", "On a phone's browser"] as const;
export type ReportWhere = (typeof REPORT_WHERE)[number];

export function bugReportUrl(fields: {
  version: string;
  where: ReportWhere;
  system: string;
}): string {
  const query = new URLSearchParams({ template: "bug_report.yml", ...fields });
  return `${BUG_FORM}?${query.toString()}`;
}

const phone = (agent: string) => /Android|iPhone|iPad|Mobile/.test(agent);

/** Which of the form's places this client is. */
export function reportWhere(kind: "desktop" | "web", agent: string): ReportWhere {
  if (kind === "desktop") return "Desktop app";
  return phone(agent) ? "On a phone's browser" : "In a web browser";
}

function browser(agent: string): string | null {
  if (/Edg\//.test(agent)) return "Edge";
  if (/Firefox\/|FxiOS\//.test(agent)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(agent)) return "Chrome";
  if (/Safari\//.test(agent)) return "Safari";
  return null;
}

/** The operating system and the browser, as the form's examples put it. */
export function reportSystem(kind: "desktop" | "web", agent: string): string {
  const system = operatingSystem(agent);
  const client = kind === "desktop" ? "desktop app" : (browser(agent) ?? "a browser");
  return system ? `${system}, ${client}` : client;
}

/**
 * The version the form asks for: the diagnostics report's "Server" line, or
 * the app's own line when no server answered.
 */
export function reportVersion(report: string): string {
  const line = (name: string) => report.split("\n").find((l) => l.startsWith(`${name}: `));
  const server = line("Server");
  if (server && !server.startsWith("Server: not reachable")) return server;
  return line("App") ?? "";
}
