import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";

/**
 * Opening with the computer, per platform. Windows passes the app an argument
 * at sign-in; macOS passes none and says instead that it opened the app at
 * login. Linux has no setting Electron manages, so the app writes the entry
 * its desktop reads at sign-in itself, with the same argument as Windows.
 * Kept apart from Electron so the rules can be tested without it.
 */
/** Passed by Windows and Linux at sign-in, so the app can stay in the tray. */
export const HIDDEN_ARG = "--hidden";

/**
 * Where a Linux desktop looks for apps to start at sign-in: the XDG
 * autostart folder, under $XDG_CONFIG_HOME or ~/.config. A relative
 * $XDG_CONFIG_HOME is invalid, and the spec says to ignore it.
 */
export function autostartFile(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const config =
    env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : posix.join(home, ".config");
  return posix.join(config, "autostart", "ownbase.desktop");
}

/**
 * A path as one argument of a desktop entry's Exec line. Inside the quotes,
 * `"`, `` ` ``, `$` and `\` take a backslash; a literal `%` is `%%`, since
 * `%` starts a field code; then, the value being a string, every backslash is
 * doubled again. A line break cannot be written at all.
 */
export function desktopExec(path: string): string {
  if (/[\n\r]/.test(path)) throw new Error("A path with a line break cannot start at sign-in.");
  const quoted = path.replace(/["`$\\]/g, "\\$&").replaceAll("%", "%%");
  return `"${quoted.replaceAll("\\", "\\\\")}"`;
}

/**
 * The Linux sign-in entry for the app at `exec`: the AppImage the person
 * opened, or the installed app. Turned off in the desktop's own settings
 * (Hidden, or GNOME's X-GNOME-Autostart-enabled), it counts as off.
 */
export function linuxLoginItem(file: string, exec: string) {
  return {
    get: (): boolean => {
      if (!existsSync(file)) return false;
      const entry = readFileSync(file, "utf8");
      return (
        !/^Hidden=true\s*$/m.test(entry) && !/^X-GNOME-Autostart-enabled=false\s*$/m.test(entry)
      );
    },
    set: (open: boolean): void => {
      if (!open) {
        rmSync(file, { force: true });
        return;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        [
          "[Desktop Entry]",
          "Type=Application",
          "Name=OwnBase",
          "Comment=Keeps the workspaces you host running after you sign in.",
          `Exec=${desktopExec(exec)} ${HIDDEN_ARG}`,
          "Icon=ownbase",
          "Terminal=false",
          "X-GNOME-Autostart-enabled=true",
          "",
        ].join("\n"),
      );
    },
  };
}

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
