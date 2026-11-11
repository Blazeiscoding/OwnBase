import {
  ACCESS_POLICIES,
  DEFAULT_WORKSPACE_NAME,
  type AccessPolicy,
  type ID,
} from "@ownbase/protocol";
import type { ExtensionStorage } from "../extensions.js";
import { ulid } from "../ids.js";
import {
  ICON_META_KEYS,
  readStoredIcon,
  storedIconRows,
  type WorkspaceIcon,
} from "../admin/workspaceIcon.js";
import { WORKSPACE_NAME_ROW } from "./workspaceFile.js";

/** The rows of the database's `meta` table, which hold every workspace setting. */
export interface MetaRows {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  listMeta(prefix: string): { key: string; value: string }[];
}

type Row = [key: string, value: string | null];

/** One workspace setting: the rows it is kept in, and what they mean. */
interface Setting<T> {
  /** The setting as its rows hold it, or null when they hold none that is valid. */
  read(row: (key: string) => string | null): T | null;
  /** The rows that hold `value`; a null value removes its row. */
  write(value: T): Row[];
  /** What it is while none is stored. Absent, the first read makes one and keeps it. */
  fallback: T | (() => T);
  /** Made and kept on first read, rather than read as the fallback each time. */
  kept?: true;
}

const isAccessPolicy = (value: unknown): value is AccessPolicy =>
  ACCESS_POLICIES.includes(value as AccessPolicy);

/** Every workspace setting, each declared once. */
export const SETTINGS = {
  /** The workspace's id: made once, kept through renames, moves and restores. */
  workspaceId: {
    read: (row) => row("workspace_id") || null,
    write: (id) => [["workspace_id", id]],
    fallback: () => ulid(),
    kept: true,
  } satisfies Setting<ID>,
  workspaceName: {
    read: (row) => row(WORKSPACE_NAME_ROW) || null,
    write: (name) => [[WORKSPACE_NAME_ROW, name]],
    fallback: DEFAULT_WORKSPACE_NAME,
  } satisfies Setting<string>,
  /**
   * Who may join. The older `invite_only` row is kept in step, since before
   * guest access it alone said who could join, and a workspace from then
   * keeps what it said until someone chooses (see `inviteOnlyBefore`).
   */
  accessPolicy: {
    read: (row) => {
      const policy = row("access_policy");
      return isAccessPolicy(policy) ? policy : null;
    },
    write: (policy) => [
      ["access_policy", policy],
      ["invite_only", policy === "invite_only" ? "1" : "0"],
    ],
    fallback: "invite_only",
  } satisfies Setting<AccessPolicy>,
  /** What a workspace from before guest access said about invites. */
  inviteOnlyBefore: {
    read: (row) => (row("invite_only") === null ? null : row("invite_only") === "1"),
    write: (on) => [["invite_only", on ? "1" : "0"]],
    fallback: false,
  } satisfies Setting<boolean>,
  /** Whether new messages get link previews (E2): on unless an owner or admin turned them off. */
  linkPreviews: {
    read: (row) => {
      const value = row("link_previews");
      return value === null ? null : value !== "off";
    },
    write: (on) => [["link_previews", on ? "on" : "off"]],
    fallback: true,
  } satisfies Setting<boolean>,
  /**
   * The code that claims a workspace nobody owns yet; null once claimed. The
   * claimed row is kept, empty, rather than removed.
   */
  claimCode: {
    read: (row) => row("claim_code") || null,
    write: (code) => [["claim_code", code ?? ""]],
    fallback: null,
  } satisfies Setting<string | null>,
  /** Rows that do not make a whole icon are read as none. */
  icon: {
    read: (row) => readStoredIcon(row),
    write: (icon) =>
      icon ? storedIconRows(icon) : Object.values(ICON_META_KEYS).map((key): Row => [key, null]),
    fallback: null,
  } satisfies Setting<WorkspaceIcon | null>,
};

export type SettingName = keyof typeof SETTINGS;
export type SettingValue<K extends SettingName> =
  (typeof SETTINGS)[K] extends Setting<infer T> ? T : never;

export class Settings {
  constructor(private readonly rows: MetaRows) {}

  /** The setting, or its fallback while none is stored. */
  get<K extends SettingName>(name: K): SettingValue<K> {
    const setting = SETTINGS[name] as unknown as Setting<SettingValue<K>>;
    const stored = this.stored(name);
    if (stored !== null) return stored;
    const value =
      typeof setting.fallback === "function"
        ? (setting.fallback as () => SettingValue<K>)()
        : setting.fallback;
    if (setting.kept) this.set(name, value);
    return value;
  }

  /** The setting as stored, or null when none valid is. */
  stored<K extends SettingName>(name: K): SettingValue<K> | null {
    const setting = SETTINGS[name] as unknown as Setting<SettingValue<K>>;
    return setting.read((key) => this.rows.getMeta(key));
  }

  /** Writes the setting's rows. Call it inside a transaction to write them with other changes. */
  set<K extends SettingName>(name: K, value: SettingValue<K>): void {
    const setting = SETTINGS[name] as unknown as Setting<SettingValue<K>>;
    for (const [key, row] of setting.write(value)) {
      if (row === null) this.rows.deleteMeta(key);
      else this.rows.setMeta(key, row);
    }
  }

  /**
   * What an extension keeps, under keys of its own, apart from other
   * extensions' and from the workspace's settings.
   */
  extensionStorage(extension: string): ExtensionStorage {
    const prefix = `extension:${extension}:`;
    return {
      get: (key) => this.rows.getMeta(prefix + key),
      set: (key, value) => this.rows.setMeta(prefix + key, value),
      delete: (key) => this.rows.deleteMeta(prefix + key),
      list: (start) =>
        this.rows
          .listMeta(prefix + start)
          .map(({ key, value }) => ({ key: key.slice(prefix.length), value })),
    };
  }
}
