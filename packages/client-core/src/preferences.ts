import {
  DEFAULT_CHANNEL_PREFS,
  type ChannelPrefs,
  type ID,
  type NotifyLevel,
  type SidebarSection,
} from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import { answerOf, doneOf, notConnected } from "./answers.js";
import type { Api, ApiError } from "./api.js";
import type { OptimisticWrites, WriteSpec } from "./optimisticWrites.js";
import type { WorkspaceState } from "./workspaceState.js";

function omitKeys<T extends object>(values: T, keys: string[]): Partial<T> {
  const out: Partial<T> = { ...values };
  for (const key of keys) delete out[key as keyof T];
  return out;
}

/**
 * This account's own choices about its workspace: its sidebar sections and
 * what notifies it, shown at once and saved after (see `OptimisticWrites`).
 */
export class Preferences {
  constructor(
    private readonly api: Api,
    private readonly store: StoreApi<WorkspaceState>,
    private readonly writes: OptimisticWrites,
    private readonly isStopped: () => boolean,
  ) {}

  private get state(): WorkspaceState {
    return this.store.getState();
  }

  private get stopped(): boolean {
    return this.isStopped();
  }

  createSidebarSection(name: string): Promise<SidebarSection | ApiError> {
    return answerOf(async () => {
      const { section, sections } = await this.api.createSidebarSection(name);
      this.keepSections(sections);
      return section;
    });
  }

  renameSidebarSection(id: ID, name: string): Promise<ApiError | null> {
    return doneOf(async () =>
      this.keepSections((await this.api.renameSidebarSection(id, name)).sections),
    );
  }

  deleteSidebarSection(id: ID): Promise<ApiError | null> {
    return doneOf(async () =>
      this.keepSections((await this.api.deleteSidebarSection(id)).sections),
    );
  }

  orderSidebarSections(ids: ID[]): Promise<ApiError | null> {
    return this.writes.write<SidebarSection[], ID[]>({ kind: "sectionOrder" }, ids, {
      read: () => this.state.sidebarSections,
      show: (sidebarSections) => this.store.setState({ sidebarSections }),
      send: async (order) => (await this.api.orderSidebarSections(order)).sections,
      apply: (sections, order) => {
        const byId = new Map(sections.map((section) => [section.id, section]));
        return order.flatMap((id) => byId.get(id) ?? []);
      },
    });
  }

  private keepSections(sections: SidebarSection[]): void {
    if (this.stopped) return;
    if (!this.writes.heard({ kind: "sectionOrder" }, sections))
      this.store.setState({ sidebarSections: sections });
  }

  setChannelPrefs(channelId: ID, patch: Partial<ChannelPrefs>): Promise<ApiError | null> {
    // A level chosen here is this conversation's own from now on, as the
    // server will say; shown so at once.
    if (patch.notifyLevel !== undefined && patch.notifyChosen === undefined)
      patch = { ...patch, notifyChosen: true };
    return this.writes.write({ kind: "prefs", channelId }, patch, this.prefsSpec(channelId));
  }

  retryChannelPrefs(channelId: ID): void {
    void this.writes.retry({ kind: "prefs", channelId });
  }

  private prefsSpec(channelId: ID): WriteSpec<ChannelPrefs, Partial<ChannelPrefs>> {
    return {
      read: () => this.state.prefs[channelId] ?? DEFAULT_CHANNEL_PREFS,
      show: (prefs, { saving, failed }) =>
        this.store.setState((s) => {
          const prefsWrites = { ...s.prefsWrites };
          const unsaved = failed && Object.keys(failed).length > 0 ? failed : null;
          if (saving || unsaved) prefsWrites[channelId] = { saving, failed: unsaved };
          else delete prefsWrites[channelId];
          return { prefs: { ...s.prefs, [channelId]: prefs }, prefsWrites };
        }),
      send: async (change) => (await this.api.setChannelPrefs(channelId, change)).prefs,
      merge: (earlier, later) => ({ ...earlier, ...later }),
      apply: (prefs, change) => ({ ...prefs, ...change }),
      unreplaced: (change, replacement) => {
        const rest = omitKeys(change, Object.keys(replacement));
        return Object.keys(rest).length > 0 ? rest : null;
      },
      keepFailed: true,
      same: (a, b) =>
        Object.keys({ ...a, ...b }).every(
          (key) => a[key as keyof ChannelPrefs] === b[key as keyof ChannelPrefs],
        ),
    };
  }

  snoozeNotifications(minutes: number | null): Promise<ApiError | null> {
    return this.snoozeNotificationsUntil(minutes === null ? null : Date.now() + minutes * 60_000);
  }

  snoozeNotificationsUntil(dndUntil: number | null): Promise<ApiError | null> {
    if (!this.state.self) return Promise.resolve(notConnected());
    return this.writes.write({ kind: "dnd" }, dndUntil, {
      read: () => this.state.self?.dndUntil ?? null,
      show: (until) =>
        this.store.setState((s) => {
          if (!s.self || s.self.dndUntil === until) return {};
          const self = { ...s.self, dndUntil: until };
          return { self, users: { ...s.users, [self.id]: self } };
        }),
      send: async (until) => (await this.api.updateMe({ dndUntil: until })).user.dndUntil,
    });
  }

  setNotifyDefault(level: NotifyLevel): Promise<ApiError | null> {
    if (!this.state.self) return Promise.resolve(notConnected());
    return this.writes.write<NotifyLevel>({ kind: "notifyDefault" }, level, {
      read: () => this.state.notifyDefault,
      show: (notifyDefault) => this.store.setState({ notifyDefault }),
      send: async (chosen) => (await this.api.setNotifyDefault(chosen)).level,
    });
  }
}
