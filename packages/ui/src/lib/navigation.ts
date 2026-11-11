import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import type { ID, Message } from "@ownbase/protocol";
import { ApiError, isMessageOnScreen, type WorkspaceClient } from "@ownbase/client-core";
import type { AccountSection } from "./accountSections.js";
import type { DraftPlace } from "@ownbase/client-core";
import { requestEdit } from "./editRequest.js";
import {
  ROUTE_VIEWS,
  currentRoute,
  writeRoute,
  type RouteDialog,
  type RouteView,
  type WorkspaceRoute,
} from "./route.js";

/** Only one right-hand panel is open at a time. */
export type Panel =
  | { kind: "none" }
  | { kind: "thread"; rootId: ID; targetId?: ID }
  | { kind: "pins" }
  | { kind: "saved" }
  | { kind: "threads" }
  /** `edit`: a queued message whose unsaved edit to open, from Drafts. */
  | { kind: "scheduled"; edit?: ID }
  | { kind: "drafts" }
  /** `channelId`: a conversation to show the files of, from its menu. */
  | { kind: "files"; channelId?: ID }
  | { kind: "activity" }
  | { kind: "dms" }
  | { kind: "members" };
export type PanelKind = Panel["kind"];

export type Dialog =
  | { kind: "none" }
  | { kind: "friends" }
  | { kind: "new-channel" }
  | { kind: "browse" }
  | { kind: "new-dm"; initialMemberIds?: ID[] }
  | { kind: "invite"; welcome?: boolean }
  | { kind: "switcher" }
  | { kind: "search"; query?: string; inConversation?: boolean }
  | { kind: "account"; section?: AccountSection }
  | { kind: "profile"; userId: ID }
  | { kind: "channel-details"; tab?: "members" | "notifications" }
  | { kind: "shortcuts" }
  | { kind: "diagnostics"; callLog?: boolean }
  | { kind: "apps" }
  | { kind: "people" }
  | { kind: "reports" }
  | { kind: "workspace" }
  | { kind: "guest-account" };
export type DialogKind = Dialog["kind"];

export interface NavigationState {
  channelId: ID | null;
  /** A message flagged after jumping to it; the timeline is anchored on it. */
  highlightId: ID | null;
  panel: Panel;
  dialog: Dialog;
  /** The phone's navigation drawer, which exists only in the drawer layout. */
  drawer: boolean;
  /** Why the screen is not where it was asked to be. */
  error: string | null;
  /** `error`, while it is the note that also points to Drafts. */
  lostDraftsNote: string | null;
  /** A jump to a message is loading its history. */
  navigating: boolean;
  /**
   * What the layout covers, as measured by the screen: a side panel over the
   * conversation on a narrow window, or the call over the chat.
   */
  cover: { panel: boolean; call: boolean };
}

export type Intent =
  | { to: "conversation"; channelId: ID }
  | { to: "message"; channelId: ID; messageId: ID }
  /** With a channel: from a list of threads, so the thread shows at once beside its root. */
  | { to: "thread"; rootId: ID; channelId?: ID }
  | { to: "panel"; panel: Panel }
  | { to: "toggle-panel"; kind: "pins" | "members" }
  /** `replace`: a change within the same place, such as Account settings' section. */
  | { to: "dialog"; dialog: Dialog; replace?: boolean }
  | { to: "toggle-dialog"; kind: "switcher" | "shortcuts" }
  | { to: "drawer" }
  | { to: "draft"; place: DraftPlace }
  /** A channel's details from its row: that channel is opened first. */
  | { to: "details"; channelId: ID; tab?: "members" }
  /** This account left the open conversation; the screen picks another. */
  | { to: "left" };

/** The opposite of the query in theme.css that turns the sidebar into a drawer. */
export const WIDE = "(min-width: 761px) and (min-height: 481px)";

export function drawerLayout(): boolean {
  return typeof window.matchMedia === "function" && !window.matchMedia(WIDE).matches;
}

function dialogFromRoute(dialog: RouteDialog | null | undefined): Dialog {
  if (!dialog) return { kind: "none" };
  if (dialog.name === "account")
    return dialog.section ? { kind: "account", section: dialog.section } : { kind: "account" };
  if (dialog.name === "details") return { kind: "channel-details" };
  return { kind: dialog.name };
}

function panelFromRoute(route: WorkspaceRoute | null): Panel {
  if (route?.threadRootId) return { kind: "thread", rootId: route.threadRootId };
  if (route?.view) return { kind: route.view };
  return { kind: "none" };
}

/** The part of an open dialog the address keeps, if it keeps any. */
function routeDialogOf(dialog: Dialog): RouteDialog | null {
  switch (dialog.kind) {
    case "account":
      return dialog.section ? { name: "account", section: dialog.section } : { name: "account" };
    case "channel-details":
      return { name: "details" };
    case "people":
    case "reports":
    case "apps":
    case "workspace":
    case "invite":
    case "shortcuts":
      return { name: dialog.kind };
    default:
      return null;
  }
}

/**
 * What is on screen of the conversation and the thread beside it: a message
 * there is in view, and with no dialog over it, being read.
 */
export function inView(state: NavigationState): { channel: boolean; thread: boolean } {
  return {
    channel: !state.cover.panel && !state.cover.call && !state.drawer,
    thread: !state.drawer,
  };
}

export function reading(state: NavigationState): { channel: boolean; thread: boolean } {
  const view = inView(state);
  const open = state.dialog.kind === "none";
  return { channel: view.channel && open, thread: view.thread && open };
}

const NOT_OPENED =
  "Could not open this message. Someone may have deleted it, or you may no longer have access to it. If you are offline, try again once you reconnect.";

/**
 * Where the workspace screen is: the conversation, the panel beside it, the
 * dialog over it and the phone's drawer. The address and the browser's
 * history follow it, so Back, Forward and a reload return to each place,
 * and Back closes a dialog or the drawer opened over the same place.
 */
export class Navigation {
  readonly store: StoreApi<NavigationState>;
  private readonly put: StoreApi<NavigationState>["setState"];
  /** Bumped by every move, so a slower jump does not land after a newer one. */
  private ticket = 0;
  /** The conversation, thread or panel last written, beneath any dialog. */
  private lastPlace: string | null = null;
  /** The history entry on screen is a step added to open the dialog. */
  private dialogStep = false;
  /** The history entry on screen is a step added to open the phone drawer. */
  private drawerStep = false;
  private replaceNext = false;
  private lastWritten = "";

  constructor(
    private readonly client: WorkspaceClient,
    private readonly serverUrl: string,
    initial: Partial<NavigationState>,
  ) {
    this.store = createStore<NavigationState>(() => ({
      channelId: null,
      highlightId: null,
      panel: { kind: "none" },
      dialog: { kind: "none" },
      drawer: false,
      error: null,
      lostDraftsNote: null,
      navigating: false,
      cover: { panel: false, call: false },
      ...initial,
    }));
    this.put = this.store.setState;
  }

  /**
   * Opening a workspace: a link to a message goes there, otherwise where the
   * address or the history entry left it, including a dialog or the drawer.
   */
  static open(
    client: WorkspaceClient,
    opts: { target: { channelId: ID; messageId: ID } | null; welcome?: boolean },
  ): { navigation: Navigation; fromRoute: boolean } {
    const route = opts.target ? null : currentRoute(client.baseUrl);
    const navigation = new Navigation(client, client.baseUrl, {
      channelId: opts.target?.channelId ?? route?.channelId ?? null,
      highlightId: opts.target?.messageId ?? null,
      panel: panelFromRoute(route),
      dialog: opts.welcome ? { kind: "invite", welcome: true } : dialogFromRoute(route?.dialog),
      drawer: route?.drawer === true && drawerLayout(),
    });
    return { navigation, fromRoute: !!route };
  }

  get state(): NavigationState {
    return this.store.getState();
  }

  private set(patch: Partial<NavigationState>, force = false) {
    this.put(patch);
    this.sync(force);
  }

  /** A newer move: an earlier jump still loading lands nowhere. */
  private move(): number {
    this.client.cancelMessageJump();
    return ++this.ticket;
  }

  current(ticket: number): boolean {
    return ticket === this.ticket;
  }

  get moves(): number {
    return this.ticket;
  }

  navigate(intent: Intent): void {
    const s = this.state;
    switch (intent.to) {
      case "conversation":
        this.move();
        return this.set({
          navigating: false,
          error: null,
          channelId: intent.channelId,
          highlightId: null,
          panel: { kind: "none" },
          dialog: { kind: "none" },
          drawer: false,
        });
      case "message":
        return this.jump(intent.channelId, intent.messageId);
      case "thread":
        if (!intent.channelId)
          return this.set({ panel: { kind: "thread", rootId: intent.rootId } });
        return this.threadIn(intent.channelId, intent.rootId);
      case "panel":
        return this.set({ panel: intent.panel, drawer: false });
      case "toggle-panel":
        return this.set({
          panel: s.panel.kind === intent.kind ? { kind: "none" } : { kind: intent.kind },
        });
      case "dialog":
        if (intent.replace) this.replaceNext = true;
        return this.set(
          intent.dialog.kind === "none"
            ? { dialog: intent.dialog }
            : { dialog: intent.dialog, drawer: false },
        );
      case "toggle-dialog":
        return this.navigate({
          to: "dialog",
          dialog: s.dialog.kind === intent.kind ? { kind: "none" } : { kind: intent.kind },
        });
      case "drawer":
        return this.set({ drawer: true });
      case "draft":
        return this.openDraft(intent.place);
      case "details":
        if (intent.channelId !== s.channelId)
          this.navigate({ to: "conversation", channelId: intent.channelId });
        return this.set({
          drawer: false,
          dialog: intent.tab
            ? { kind: "channel-details", tab: intent.tab }
            : { kind: "channel-details" },
        });
      case "left":
        // Going somewhere else at once, so no step Back to wait for.
        this.dialogStep = false;
        return this.set({ dialog: { kind: "none" }, channelId: null });
    }
  }

  /** Closes the dialog: Back through the step that opened it, if one did. */
  closeDialog(): void {
    if (this.dialogStep) {
      // The entry before this one is the same place without the dialog.
      this.dialogStep = false;
      window.history.back();
      return;
    }
    this.set({ dialog: { kind: "none" } });
  }

  /** Closes the phone drawer: Back through the step that opened it, if one did. */
  closeDrawer(): void {
    if (this.drawerStep) {
      this.drawerStep = false;
      window.history.back();
      return;
    }
    this.set({ drawer: false });
  }

  closePanel(): void {
    if (this.state.panel.kind !== "none") this.set({ panel: { kind: "none" } });
  }

  /** Escape outside any dialog: the drawer first, then the side panel. */
  escape(): void {
    if (this.state.drawer) this.closeDrawer();
    else this.closePanel();
  }

  /** The person moved off the message a jump flagged, to the newest. */
  clearHighlight(): void {
    this.set({ highlightId: null });
  }

  dismissError(): void {
    this.set({ error: null });
  }

  /** The screen saw a dialog close that this account may not open; the entry is rewritten. */
  refuseDialog(): void {
    this.replaceNext = true;
    this.set({ dialog: { kind: "none" } });
  }

  showError(error: string): void {
    this.set({ error, lostDraftsNote: null });
  }

  /**
   * Where the screen moves on its own, not the person: the conversation it
   * restores or picks, or one it moves away from that has gone. Arriving
   * there rewrites the history entry, so Back does not lead somewhere
   * unavailable.
   */
  settle(channelId: ID, lost?: { note: string; drafts: boolean }): void {
    this.replaceNext = true;
    this.set({
      channelId,
      ...(lost
        ? {
            error: lost.note,
            lostDraftsNote: lost.drafts ? lost.note : null,
            panel: this.state.panel.kind === "thread" ? { kind: "none" } : this.state.panel,
          }
        : {}),
    });
  }

  setCover(cover: NavigationState["cover"]): void {
    const was = this.state.cover;
    if (was.panel !== cover.panel || was.call !== cover.call) this.put({ cover });
  }

  /** Whether a message is in view in this window, which has focus. */
  onScreen(msg: Message): boolean {
    const s = this.state;
    const view = inView(s);
    return isMessageOnScreen(msg, {
      focused: document.hasFocus() && document.visibilityState !== "hidden",
      channelId: s.channelId,
      channelVisible: view.channel,
      threadRootId: s.panel.kind === "thread" ? s.panel.rootId : null,
      threadVisible: view.thread,
    });
  }

  /**
   * Opens a channel scrolled to one message, from search, pins or Saved.
   * A link opened at start anchors the conversation on its message before
   * the jump, and an anchored timeline never reads its own history; without
   * the message it reads its newest instead.
   */
  private jump(channelId: ID, messageId: ID) {
    const ticket = this.move();
    this.set({ dialog: { kind: "none" }, error: null, navigating: true });
    void this.client.jumpToMessage(channelId, messageId).then((rootId) => {
      if (!this.current(ticket)) return;
      if (rootId instanceof ApiError) {
        const s = this.state;
        this.set({
          highlightId: s.highlightId === messageId ? null : s.highlightId,
          error: NOT_OPENED,
          lostDraftsNote: null,
          navigating: false,
        });
        return;
      }
      if (rootId !== undefined)
        this.set(
          {
            channelId,
            highlightId: rootId ?? messageId,
            panel: rootId ? { kind: "thread", rootId, targetId: messageId } : { kind: "none" },
          },
          true,
        );
      this.set({ navigating: false });
    });
  }

  /**
   * A thread from the Threads list. The row already names its root, so unlike
   * a jump the thread shows at once. The conversation beside it is anchored
   * on the root, and a timeline anchored on a message does not read its own
   * history, so the history around the root is read here; should that fail,
   * the anchor goes and the conversation reads its newest.
   */
  private threadIn(channelId: ID, rootId: ID) {
    const ticket = this.move();
    this.set({
      error: null,
      navigating: false,
      dialog: { kind: "none" },
      channelId,
      highlightId: rootId,
      panel: { kind: "thread", rootId },
    });
    void this.client.jumpToMessage(channelId, rootId).then((answer) => {
      if (answer instanceof ApiError && this.current(ticket)) this.set({ highlightId: null });
    });
  }

  private openDraft(place: DraftPlace) {
    switch (place.kind) {
      case "conversation":
        return this.navigate({ to: "conversation", channelId: place.channelId });
      case "thread":
        return this.threadIn(place.channelId, place.rootId);
      case "edit":
        // The message's row opens its editor as it appears.
        requestEdit(place.messageId);
        return this.jump(place.channelId, place.messageId);
      case "scheduled-edit":
        return this.set({ panel: { kind: "scheduled", edit: place.scheduledId } });
    }
  }

  /** Writes the address and history entry for where the screen is now. */
  private sync(force: boolean) {
    const s = this.state;
    if (!s.channelId) return;
    const thread = s.panel.kind === "thread" ? s.panel.rootId : null;
    const view = (ROUTE_VIEWS as readonly string[]).includes(s.panel.kind)
      ? (s.panel.kind as RouteView)
      : null;
    const dialog = routeDialogOf(s.dialog);
    const key = JSON.stringify([s.channelId, thread, view, dialog, s.drawer]);
    if (!force && !this.replaceNext && key === this.lastWritten) return;
    this.lastWritten = key;
    // Going somewhere from the drawer takes the drawer's step's place, so Back
    // from there returns to where things were before the drawer opened.
    const leavingDrawer = this.drawerStep && !s.drawer;
    const replace = this.replaceNext || leavingDrawer;
    this.replaceNext = false;
    const place = `${s.channelId}/${thread ?? ""}/${view ?? ""}`;
    // Only a dialog or the drawer opening over the same place makes a step
    // of its own to go Back through.
    const samePlace = this.lastPlace === place;
    const openingDialog = dialog !== null && !this.dialogStep && samePlace;
    const openingDrawer = s.drawer && !this.drawerStep && samePlace && !dialog;
    this.lastPlace = place;
    const step = writeRoute(
      this.serverUrl,
      {
        channelId: s.channelId,
        threadRootId: thread,
        ...(view ? { view } : {}),
        ...(dialog ? { dialog } : {}),
        ...(s.drawer ? { drawer: true } : {}),
      },
      replace ? "replace" : "auto",
    );
    // A dialog opened from the drawer replaces the drawer's step, which was
    // over this same place: closing it goes Back through it as well.
    const stepped = step === "push" || (leavingDrawer && step === "replace");
    if (!dialog) this.dialogStep = false;
    else if (stepped) this.dialogStep = openingDialog;
    if (!s.drawer) this.drawerStep = false;
    else if (step === "push") this.drawerStep = openingDrawer;
  }

  /** Follows Back and Forward, and writes where the screen is now; returns the way to stop. */
  attach(): () => void {
    this.sync(true);
    const onPopState = () => {
      const route = currentRoute(this.serverUrl);
      if (!route) return;
      this.move();
      const s = this.state;
      const panel = panelFromRoute(route);
      this.dialogStep = false;
      this.drawerStep = false;
      this.set(
        {
          navigating: false,
          error: null,
          channelId: route.channelId,
          highlightId: null,
          panel:
            s.panel.kind === panel.kind &&
            (panel.kind !== "thread" ||
              (s.panel.kind === "thread" && s.panel.rootId === panel.rootId))
              ? s.panel
              : panel,
          dialog: dialogFromRoute(route.dialog),
          drawer: route.drawer === true && drawerLayout(),
        },
        true,
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      this.ticket++;
      this.client.cancelMessageJump();
    };
  }
}

/** The navigation of each workspace on screen, so the app around it can ask for a place. */
const byClient = new WeakMap<WorkspaceClient, Navigation>();

export function registerNavigation(client: WorkspaceClient, navigation: Navigation): () => void {
  byClient.set(client, navigation);
  return () => {
    if (byClient.get(client) === navigation) byClient.delete(client);
  };
}

export function navigationOf(client: WorkspaceClient): Navigation | undefined {
  return byClient.get(client);
}

export const NavigationContext = createContext<Navigation | null>(null);

export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("NavigationContext missing");
  return navigation;
}

export function useNavigationState<T>(selector: (s: NavigationState) => T): T {
  return useStore(useNavigation().store, selector);
}
