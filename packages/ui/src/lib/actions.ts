import { useStore } from "zustand";
import {
  selfIsAdministrator,
  selfMay,
  type WorkspaceClient,
  type WorkspaceState,
} from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import type { IconName } from "../components/Icon.js";
import type { MenuItem } from "../components/Menu.js";
import type { PaletteCommand } from "../components/QuickSwitcher.js";
import { useToast, type ToastRequest } from "../components/Toast.js";
import { useConfirm, type ConfirmRequest } from "../components/Confirm.js";
import { useAppearance } from "./appearance.js";
import { useMediaQuery } from "./useMediaQuery.js";
import { failureText } from "./failure.js";
import { markEverythingRead, unreadEverywhere, unreadSummary } from "./readAll.js";
import { collapsedSections, neighbourConversation } from "./sidebarLayout.js";
import { railTarget } from "./workspaceRail.js";
import { isApple, modKey, shortcutLabel } from "./shortcuts.js";
import { useNavigation, type Navigation, type Panel } from "./navigation.js";
import { useWorkspaceShell, type WorkspaceShell } from "./workspaceShell.js";
import { pageKey, useWindowKeys } from "./keys.js";

/** What an action may read and use when it is offered or run. */
export interface ActionContext {
  client: WorkspaceClient;
  state: WorkspaceState;
  nav: Navigation;
  shell: WorkspaceShell;
  toast: (request: ToastRequest) => () => void;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** The theme on show now, and the way to change it. */
  theme: { dark: boolean; set: (theme: "light" | "dark") => void };
}

export interface Action {
  id: string;
  label: string | ((ctx: ActionContext) => string);
  icon: IconName | ((ctx: ActionContext) => IconName);
  /** Other words someone might type for it in Ctrl+K. */
  keywords?: string | ((ctx: ActionContext) => string);
  /** Ctrl+K's own words and icon, where they differ from the menus'. */
  palette?: { label?: string; icon?: IconName };
  /** Whether this account may do it, here and now. */
  available: (ctx: ActionContext) => boolean;
  run: (ctx: ActionContext) => void;
}

/** Owners and admins always may invite; a member when an admin allowed it; a guest never. */
export function mayInvite(self: WorkspaceState["self"]): boolean {
  return selfMay({ self }, "createInvite") && self?.canInvite === true;
}

const guest = (ctx: ActionContext) => ctx.state.self?.role === "guest";
/**
 * A guest has no profile or settings of its own here: its picture, password,
 * devices and storage are an account's.
 */
const member = (ctx: ActionContext) => !guest(ctx);
const always = () => true;
const admin = (ctx: ActionContext) => selfIsAdministrator(ctx.state);

function panel(id: string, label: string, icon: IconName, keywords: string, kind: Panel["kind"]) {
  return {
    id,
    label,
    icon,
    keywords,
    available: always,
    run: (ctx: ActionContext) => ctx.nav.navigate({ to: "panel", panel: { kind } as Panel }),
  } satisfies Action;
}

/** The account menu's and Settings > Security's Sign out: asks, then ends this device's session. */
async function signOut(ctx: ActionContext) {
  const guestNow = ctx.client.state.self?.role === "guest";
  const ok = await ctx.confirm({
    title: "Sign out of this workspace?",
    body: guestNow
      ? "You joined as a guest, without a password. Signing out ends this visit; coming back takes a new invite link."
      : "You will need your password to sign in again. Your account's saved drafts stay on this device.",
    confirmLabel: "Sign out",
    destructive: guestNow,
  });
  if (!ok) return;
  if (await ctx.client.signOut()) {
    ctx.toast({
      message: "You are still signed in. Check your connection and try again.",
      kind: "error",
    });
    return;
  }
  ctx.shell.onSignedOut();
}

/** Everything read, after asking when it is more than a couple of places. */
async function markAllRead(ctx: ActionContext) {
  const { channels, threads } = unreadEverywhere(ctx.client.state);
  const count = channels.length + threads.length;
  if (count === 0) {
    ctx.toast({ message: "Nothing unread.", kind: "info" });
    return;
  }
  const summary = unreadSummary(channels.length, threads.length);
  if (count > 2) {
    const go = await ctx.confirm({
      title: "Mark everything as read?",
      body: `This marks ${summary} as read.`,
      confirmLabel: "Mark as read",
    });
    if (!go) return;
  }
  markEverythingRead(ctx.client);
  ctx.toast({ message: `Marked ${summary} as read.`, kind: "success" });
}

/** Every workspace-wide action, each declared once. */
export const ACTIONS = [
  {
    id: "new-message",
    label: "New message",
    icon: "edit",
    keywords: "dm direct conversation write",
    available: (ctx) => selfMay(ctx.state, "createChannel"),
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "new-dm" } }),
  },
  {
    id: "new-channel",
    label: "New channel",
    icon: "plus",
    keywords: "new add room",
    palette: { label: "Create a channel" },
    available: (ctx) => selfMay(ctx.state, "createChannel"),
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "new-channel" } }),
  },
  {
    id: "browse",
    label: "Browse channels",
    icon: "compass",
    keywords: "join find explore",
    available: always,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "browse" } }),
  },
  panel("activity", "Activity", "activity", "mentions unread notifications", "activity"),
  panel("threads", "Threads", "thread", "replies following", "threads"),
  panel("saved", "Saved", "bookmark", "bookmarks later", "saved"),
  panel("drafts", "Drafts", "edit", "unsent unsaved writing", "drafts"),
  panel("files", "Files", "file", "attachments images documents uploads shared", "files"),
  {
    id: "invite",
    label: "Invite people",
    icon: "userPlus",
    keywords: "link code join add",
    available: (ctx) => mayInvite(ctx.state.self),
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "invite" } }),
  },
  {
    ...panel("scheduled", "Scheduled messages", "clock", "send later", "scheduled"),
    available: (ctx) => selfMay(ctx.state, "scheduleMessage"),
  },
  {
    id: "search",
    label: "Search messages",
    icon: "search",
    keywords: "find",
    available: always,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "search" } }),
  },
  {
    id: "profile",
    label: "Profile and status",
    icon: "user",
    keywords: "profile name away busy",
    palette: { label: "Set a status" },
    available: member,
    run: (ctx) =>
      ctx.nav.navigate({ to: "dialog", dialog: { kind: "account", section: "profile" } }),
  },
  {
    id: "theme",
    label: (ctx) => (ctx.theme.dark ? "Switch to the White theme" : "Switch to the Onyx theme"),
    icon: (ctx) => (ctx.theme.dark ? "sun" : "moon"),
    keywords: "theme appearance dark light mode colour color",
    available: always,
    run: (ctx) => ctx.theme.set(ctx.theme.dark ? "light" : "dark"),
  },
  {
    id: "account-settings",
    label: "Account settings",
    icon: "settings",
    keywords: "preferences notifications password",
    available: member,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "account" } }),
  },
  {
    id: "people",
    label: "People",
    icon: "members",
    keywords: "members admin roles deactivate",
    palette: { label: "Manage people" },
    available: admin,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "people" } }),
  },
  {
    id: "reports",
    label: "Reported messages",
    icon: "flag",
    keywords: "reports moderation abuse spam queue",
    available: admin,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "reports" } }),
  },
  {
    id: "apps",
    label: "Apps and integrations",
    icon: "grid",
    keywords: "bots webhooks commands",
    available: admin,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "apps" } }),
  },
  {
    id: "workspace-settings",
    label: "Workspace settings",
    icon: "settings",
    keywords: "rename name who can join guests invite only access",
    available: admin,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "workspace" } }),
  },
  {
    id: "create-account",
    label: "Create an account",
    icon: "userPlus",
    keywords: "sign up keep",
    palette: { icon: "user" },
    available: (ctx) => guest(ctx) && !!ctx.shell.onAccountCreated,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "guest-account" } }),
  },
  // This computer's hosting, in the desktop app: for a member or a guest alike.
  {
    id: "hosting",
    label: (ctx) => (ctx.shell.hostingEntry?.running ? "Manage hosting" : "Host a workspace"),
    icon: "screen",
    keywords: (ctx) =>
      ctx.shell.hostingEntry?.running
        ? "host server backup port stop computer"
        : "host server start new computer manage hosting",
    available: (ctx) => !!ctx.shell.hostingEntry,
    run: (ctx) => ctx.shell.hostingEntry?.open(),
  },
  {
    id: "hosting-internet",
    label: "Share on the internet",
    icon: "link",
    keywords: "host public open to all tunnel cloudflare address online",
    available: (ctx) => ctx.shell.hostingEntry?.running === true,
    run: (ctx) => ctx.shell.hostingEntry?.open("internet"),
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: "keyboard",
    keywords: "keys help",
    available: always,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "shortcuts" } }),
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: "gauge",
    available: always,
    run: (ctx) => ctx.nav.navigate({ to: "dialog", dialog: { kind: "diagnostics" } }),
  },
  {
    id: "away",
    label: (ctx) => (ctx.state.self?.away ? "Set yourself active" : "Set yourself away"),
    icon: (ctx) => (ctx.state.self?.away ? "sun" : "moon"),
    available: (ctx) => !!ctx.state.self,
    run: (ctx) => {
      void ctx.client.setAway(!ctx.state.self?.away).then((error) => {
        if (error)
          ctx.toast({
            message: failureText("Could not change whether you show as away.", error),
            kind: "error",
          });
      });
    },
  },
  {
    id: "sign-out",
    label: "Sign out",
    icon: "leave",
    available: always,
    run: (ctx) => void signOut(ctx),
  },
] as const satisfies readonly Action[];

export type ActionId = (typeof ACTIONS)[number]["id"];

const BY_ID = new Map<string, Action>(ACTIONS.map((action) => [action.id, action]));

export function action(id: ActionId): Action {
  return BY_ID.get(id)!;
}

const text = (value: string | ((ctx: ActionContext) => string), ctx: ActionContext) =>
  typeof value === "function" ? value(ctx) : value;
const iconOf = (value: IconName | ((ctx: ActionContext) => IconName), ctx: ActionContext) =>
  typeof value === "function" ? value(ctx) : value;

/** Ctrl+K's actions, in its order: every sidebar destination and the common tasks. */
export const PALETTE: readonly ActionId[] = [
  "new-message",
  "new-channel",
  "browse",
  "activity",
  "threads",
  "saved",
  "drafts",
  "files",
  "invite",
  "scheduled",
  "search",
  "profile",
  "theme",
  "account-settings",
  "people",
  "reports",
  "apps",
  "workspace-settings",
  "create-account",
  "hosting",
  "hosting-internet",
  "shortcuts",
];

/** One entry of a menu made from actions. */
export interface MenuPlace {
  id: ActionId;
  /** Starts a group of its own, with a line above it. */
  section?: true;
  hint?: (ctx: ActionContext) => string | undefined;
}

/** The workspace's menu, on its name: bringing people in and running it. */
export const WORKSPACE_MENU: readonly MenuPlace[] = [
  { id: "create-account" },
  { id: "invite" },
  { id: "people" },
  {
    id: "reports",
    hint: (ctx) => (ctx.state.openReports ? `${ctx.state.openReports} waiting` : undefined),
  },
  { id: "apps" },
  { id: "workspace-settings" },
  // This computer's, not the workspace's: it goes with the workspace's own
  // settings, before the other workspaces.
  { id: "hosting" },
];

/** The account menu, after the status presets: what concerns only you. */
export const ACCOUNT_MENU: readonly MenuPlace[] = [
  { id: "away", section: true },
  { id: "create-account" },
  { id: "profile", section: true },
  { id: "account-settings" },
  { id: "scheduled" },
  // Help: the shortcut sheet opened only with Ctrl+/, and nothing said so.
  { id: "shortcuts", section: true },
  { id: "diagnostics" },
  // Where people look for it, rather than at the foot of Settings > Security only.
  { id: "sign-out", section: true },
];

/** A menu's items from its places, those this account may use now. */
export function menuItems(places: readonly MenuPlace[], ctx: ActionContext): MenuItem[] {
  const items: MenuItem[] = [];
  for (const place of places) {
    const a = action(place.id);
    if (!a.available(ctx)) continue;
    const binding = KEY_BINDINGS.find((b) => b.action === place.id);
    items.push({
      id: a.id,
      label: text(a.label, ctx),
      icon: iconOf(a.icon, ctx),
      ...(place.section ? { section: true as const } : {}),
      ...(place.hint?.(ctx) ? { hint: place.hint(ctx) } : {}),
      ...(binding?.combo ? { keys: binding.keys } : {}),
      onSelect: () => a.run(ctx),
    });
  }
  return items;
}

/** Ctrl+K's actions this account may use now. */
export function paletteCommands(ctx: ActionContext): PaletteCommand[] {
  return PALETTE.map(action)
    .filter((a) => a.available(ctx))
    .map((a) => {
      const binding = KEY_BINDINGS.find((b) => b.action === a.id);
      return {
        id: a.id,
        label: a.palette?.label ?? text(a.label, ctx),
        icon: a.palette?.icon ?? iconOf(a.icon, ctx),
        keywords: a.keywords && text(a.keywords, ctx),
        ...(binding?.combo ? { shortcut: shortcutLabel(binding.combo) } : {}),
        run: () => a.run(ctx),
      };
    });
}

const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
const ALT = () => (isApple() ? "⌥" : "Alt");

/** A key that does something wherever focus is, and how the shortcut list names it. */
export interface KeyBinding {
  id: string;
  /** The action it runs, whose menu item and Ctrl+K row then show this key. */
  action?: ActionId;
  group: "Getting around" | "Huddles";
  /** The keys as the list shows them, one keycap each. */
  keys: string[];
  /** Written for code, as `shortcutLabel` reads it, where Ctrl+K shows the key. */
  combo?: string;
  describe: string;
  /** Works inside a dialog and over a busy form too. */
  anywhere?: true;
  match: (e: KeyboardEvent, ctx: ActionContext) => boolean;
  /**
   * Does it, and says whether the press was used: a key with nothing to do
   * lets the browser have it.
   */
  run: (ctx: ActionContext, e: KeyboardEvent) => boolean;
}

function walk(step: -1 | 1, unreadOnly: boolean) {
  return (ctx: ActionContext) => {
    const next = neighbourConversation(
      ctx.client.state,
      collapsedSections.getState().collapsed,
      ctx.nav.state.channelId,
      step,
      unreadOnly,
    );
    if (next) ctx.nav.navigate({ to: "conversation", channelId: next });
    return !!next;
  };
}

const altArrow = (key: "ArrowUp" | "ArrowDown", shift: boolean) => (e: KeyboardEvent) =>
  e.altKey && !mod(e) && e.shiftKey === shift && e.key === key;

/** Every global key, in the order the shortcut list shows them. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: "switcher",
    group: "Getting around",
    keys: [modKey(), "K"],
    describe: "Jump to a channel or person",
    match: (e) => mod(e) && e.key.toLowerCase() === "k",
    run: (ctx) => {
      ctx.nav.navigate({ to: "toggle-dialog", kind: "switcher" });
      return true;
    },
  },
  {
    id: "search",
    action: "search",
    group: "Getting around",
    keys: [modKey(), "F"],
    combo: "Mod+F",
    describe: "Search this conversation",
    match: (e) => mod(e) && e.key.toLowerCase() === "f",
    // Within the open conversation, as the header's field does; the dialog
    // widens it to everywhere in one press.
    run: (ctx) => {
      ctx.nav.navigate({
        to: "dialog",
        dialog: { kind: "search", inConversation: !!ctx.nav.state.channelId },
      });
      return true;
    },
  },
  // Alt+Up/Down walk the sidebar, and with Shift only what is unread, as in Slack.
  {
    id: "previous",
    group: "Getting around",
    keys: [ALT(), "↑"],
    describe: "Previous conversation in the sidebar",
    match: altArrow("ArrowUp", false),
    run: walk(-1, false),
  },
  {
    id: "next",
    group: "Getting around",
    keys: [ALT(), "↓"],
    describe: "Next conversation in the sidebar",
    match: altArrow("ArrowDown", false),
    run: walk(1, false),
  },
  {
    id: "previous-unread",
    group: "Getting around",
    keys: [ALT(), "Shift", "↑"],
    describe: "Previous unread conversation",
    match: altArrow("ArrowUp", true),
    run: walk(-1, true),
  },
  {
    id: "next-unread",
    group: "Getting around",
    keys: [ALT(), "Shift", "↓"],
    describe: "Next unread conversation",
    match: altArrow("ArrowDown", true),
    run: walk(1, true),
  },
  // Ctrl/Cmd+1–9 open the workspace at that place on the rail, as in Slack's
  // app. A browser keeps those keys for its own tabs.
  {
    id: "workspace-at",
    group: "Getting around",
    keys: [modKey(), "1–9"],
    describe: "Go to the workspace at that place on the left, in the desktop app",
    match: (e, ctx) =>
      ctx.shell.platform.kind === "desktop" &&
      mod(e) &&
      !e.shiftKey &&
      !e.altKey &&
      /^Digit[1-9]$/.test(e.code),
    run: (ctx, e) => {
      const { otherWorkspaces, railPlace, onOpenWorkspace } = ctx.shell;
      const place = Math.min(railPlace, otherWorkspaces.length);
      const target = railTarget(otherWorkspaces, place, Number(e.code.slice(5)));
      if (target && target !== "here") onOpenWorkspace?.(target.url);
      return !!target;
    },
  },
  {
    id: "mark-all-read",
    group: "Getting around",
    keys: ["Shift", "Esc"],
    describe: "Mark everything as read",
    match: (e) => e.key === "Escape" && e.shiftKey && !mod(e) && !e.altKey,
    run: (ctx) => {
      void markAllRead(ctx);
      return true;
    },
  },
  // Dialogs close themselves on Escape; this closes the phone drawer, or with
  // none open, the side panel, and leaves the key to anything else that wants it.
  {
    id: "escape",
    group: "Getting around",
    keys: ["Esc"],
    describe: "Close the open panel or dialog",
    match: (e) => e.key === "Escape" && !e.shiftKey,
    run: (ctx) => {
      ctx.nav.escape();
      return false;
    },
  },
  {
    id: "shortcuts",
    action: "shortcuts",
    group: "Getting around",
    keys: [modKey(), "/"],
    combo: "Mod+/",
    describe: "Show this list",
    match: (e) => mod(e) && e.key === "/",
    run: (ctx) => {
      ctx.nav.navigate({ to: "toggle-dialog", kind: "shortcuts" });
      return true;
    },
  },
  // Mute in a huddle, as Slack's Ctrl/Cmd+Shift+Space: from anywhere, a dialog
  // included, since the call goes on behind it.
  {
    id: "toggle-mic",
    group: "Huddles",
    keys: [modKey(), "Shift", "Space"],
    describe: "Mute or unmute your microphone",
    anywhere: true,
    match: (e, ctx) => mod(e) && e.shiftKey && e.code === "Space" && !!ctx.client.state.huddle,
    run: (ctx) => {
      ctx.client.toggleMic();
      return true;
    },
  },
];

/** The context actions run in, for the workspace on screen. */
export function useActionContext(): ActionContext {
  const client = useClient();
  const nav = useNavigation();
  const shell = useWorkspaceShell();
  const toast = useToast();
  const confirm = useConfirm();
  const appearance = useAppearance();
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  // What `available` and the labels read, so a change to it draws the menus again.
  useWorkspace((s) => s.self);
  useWorkspace((s) => s.openReports);
  useStore(nav.store, (s) => s.channelId);
  return {
    client,
    state: client.state,
    nav,
    shell,
    toast,
    confirm,
    theme: {
      dark: appearance.theme === "dark" || (appearance.theme === "system" && prefersDark),
      set: (theme) => void appearance.set({ theme }),
    },
  };
}

/** An action's name, as its menus show it now. */
export function actionLabel(ctx: ActionContext, id: ActionId): string {
  return text(action(id).label, ctx);
}

/** Whether this account may use an action now: what a control that runs it is shown by. */
export function offered(ctx: ActionContext, id: ActionId): boolean {
  return action(id).available({ ...ctx, state: ctx.client.state });
}

/** Runs an action by id, if this account may. */
export function runAction(ctx: ActionContext, id: ActionId): void {
  if (offered(ctx, id)) action(id).run(ctx);
}

/** The workspace's global keys, as `KEY_BINDINGS` lists them. */
export function useGlobalKeys(): void {
  const ctx = useActionContext();
  useWindowKeys((event) => {
    for (const binding of KEY_BINDINGS) {
      if (binding.anywhere ? event.defaultPrevented : !pageKey(event)) continue;
      if (!binding.match(event, ctx)) continue;
      if (binding.run(ctx, event)) event.preventDefault();
      return;
    }
  });
}
