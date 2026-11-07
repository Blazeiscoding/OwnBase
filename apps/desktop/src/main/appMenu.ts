/**
 * The installed app's menu. Its bar is hidden, but Electron's default menu
 * still answered Ctrl+W (closing the window, which quits when not hosting),
 * Ctrl+R (reloading the page) and Ctrl+Shift+I (developer tools). The
 * installed app keeps only what people press on purpose: editing, full
 * screen, and on a Mac the app menu's Hide and Quit. Zoom keys are the
 * window's own (zoomKeys.ts). A development build keeps Electron's menu.
 */
import type { MenuItemConstructorOptions } from "electron";

export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const edit: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "selectAll" },
    ],
  };
  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [{ role: "togglefullscreen" }],
  };
  if (platform !== "darwin") return [edit, view];
  return [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    edit,
    view,
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
  ];
}
