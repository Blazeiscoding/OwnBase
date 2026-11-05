/**
 * The order of this device's workspaces on the rail: by name, then account,
 * then address. It stays put as people move between them, so each keeps its
 * place (and its Ctrl/Cmd+number in the desktop app) rather than the one just
 * opened jumping to the top.
 */
export function railOrder<T extends { url: string; workspaceName: string; handle: string }>(
  servers: readonly T[],
): T[] {
  return [...servers].sort(
    (a, b) =>
      a.workspaceName.localeCompare(b.workspaceName, undefined, { sensitivity: "base" }) ||
      a.handle.localeCompare(b.handle) ||
      a.url.localeCompare(b.url),
  );
}

/** The workspace a Ctrl/Cmd+1–9 goes to: the nth on the rail, this one in its place. */
export function railTarget<T>(others: readonly T[], place: number, n: number): T | "here" | null {
  const index = n - 1;
  if (index === place) return "here";
  const other = others[index < place ? index : index - 1];
  return other ?? null;
}
