import { describe, expect, it } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { appMenuTemplate } from "../src/main/appMenu.js";

/** Every role anywhere in the menu, submenus included. */
function roles(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.role ? [item.role.toLowerCase()] : []),
    ...(Array.isArray(item.submenu) ? roles(item.submenu) : []),
  ]);
}

describe("installed app menu", () => {
  it.each(["win32", "linux", "darwin"] as const)(
    "has no close, reload or developer tools keys on %s",
    (platform) => {
      const all = roles(appMenuTemplate(platform));
      for (const role of ["close", "reload", "forcereload", "toggledevtools", "windowmenu"])
        expect(all).not.toContain(role);
      expect(all).toEqual(expect.arrayContaining(["copy", "paste", "selectall", "undo"]));
    },
  );

  it("keeps Hide and Quit on a Mac, where Cmd+Q is how an app is left", () => {
    expect(roles(appMenuTemplate("darwin"))).toEqual(expect.arrayContaining(["hide", "quit"]));
    expect(roles(appMenuTemplate("win32"))).not.toContain("quit");
  });
});
