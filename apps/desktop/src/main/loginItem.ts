/**
 * Opening with the computer, per platform. Windows passes the app an argument
 * at sign-in; macOS passes none and says instead that it opened the app at
 * login. Kept apart from Electron so the rules can be tested without it.
 */
/** Passed by Windows at sign-in, so the app can stay in the tray. */
export const HIDDEN_ARG = "--hidden";

/** What to register with the OS: only Windows carries arguments to a login item. */
export function loginItemOptions(platform: NodeJS.Platform): { args?: string[] } {
  return platform === "win32" ? { args: [HIDDEN_ARG] } : {};
}

/** Whether this launch was the OS opening the app at sign-in. */
export function openedAtLogin(
  platform: NodeJS.Platform,
  argv: readonly string[],
  settings: { wasOpenedAtLogin?: boolean },
): boolean {
  if (argv.includes(HIDDEN_ARG)) return true;
  return platform === "darwin" && settings.wasOpenedAtLogin === true;
}

/**
 * What stops a registration just asked for from taking effect, in words the
 * host can act on, or null when it took. macOS can hold a new login item
 * until it is allowed in System Settings.
 */
export function loginItemProblem(
  platform: NodeJS.Platform,
  wanted: boolean,
  settings: { openAtLogin: boolean; status?: string },
): string | null {
  if (!wanted || settings.openAtLogin) return null;
  if (platform === "darwin" && settings.status === "requires-approval")
    return "macOS is waiting for your approval. Allow OwnBase in System Settings, General, Login Items, then turn this on again.";
  return "The system did not add OwnBase to the apps that open when you sign in. Try again, or add it in the system's own settings.";
}
