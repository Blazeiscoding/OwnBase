import { createHash } from "node:crypto";
import {
  WORKSPACE_ICON_MAX_BYTES,
  WORKSPACE_ICON_TYPES,
  type WorkspaceIconType,
} from "@ownbase/protocol";
import { imageSize } from "./imageSize.js";

/**
 * The workspace's icon: a small picture its owner and admins choose, shown to
 * everyone who opens the workspace or finds it to join.
 *
 * The server keeps the bytes a client sends and never decodes or resizes them,
 * since that would need a native image library. So it trusts nothing about
 * them that it cannot read cheaply: the type comes from the file's own first
 * bytes rather than from what the request says, and the size its header
 * claims is held to a bound, so no icon makes every client that shows it
 * decode a picture of enormous size.
 */
export interface WorkspaceIcon {
  type: WorkspaceIconType;
  bytes: Buffer;
  /** Changes whenever the image does, and only then: it names the bytes. */
  version: string;
}

/** The most pixels either side may have. Clients send 256 square. */
export const WORKSPACE_ICON_MAX_SIDE = 1024;

/** Where the icon is kept: three rows of the database's `meta` table, written together. */
export const ICON_META_KEYS = {
  type: "workspace_icon_type",
  version: "workspace_icon_version",
  data: "workspace_icon_data",
} as const;

/** The type a file's first bytes say it is, of the types an icon may be, or null. */
export function iconTypeOf(bytes: Uint8Array): WorkspaceIconType | null {
  const at = (offset: number, ...expected: number[]) =>
    bytes.length >= offset + expected.length && expected.every((b, i) => bytes[offset + i] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  // "RIFF", four bytes of length, "WEBP".
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** Names a version for these bytes: the same picture always has the same one. */
export function iconVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Why an icon was refused, as an HTTP answer. */
export interface IconRefusal {
  status: number;
  code: string;
  message: string;
}

const NAMES: Record<WorkspaceIconType, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

/**
 * Checks an icon someone sent, with the type their request declared, and
 * gives back the icon to keep or why it is refused. The declared type must
 * be one an icon may be and must agree with the bytes.
 */
export function checkIcon(
  bytes: Buffer,
  declared: string | undefined,
  /** What the picture is, as its refusals name it: a profile picture keeps the same rules (E9). */
  noun = "workspace icon",
): { icon: WorkspaceIcon } | { refused: IconRefusal } {
  const said = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(WORKSPACE_ICON_TYPES as readonly string[]).includes(said))
    return {
      refused: {
        status: 415,
        code: "unsupported_icon_type",
        message: `A ${noun} is a PNG, JPEG or WebP image.`,
      },
    };
  if (bytes.length > WORKSPACE_ICON_MAX_BYTES)
    return {
      refused: {
        status: 413,
        code: "icon_too_large",
        message: `A ${noun} has at most ${WORKSPACE_ICON_MAX_BYTES / 1024} KB.`,
      },
    };
  const type = iconTypeOf(bytes);
  if (!type)
    return {
      refused: {
        status: 400,
        code: "invalid_icon",
        message: "That file is not a PNG, JPEG or WebP image.",
      },
    };
  if (type !== said)
    return {
      refused: {
        status: 400,
        code: "invalid_icon",
        message: `That file says it is ${NAMES[said as WorkspaceIconType]} but holds a ${NAMES[type]} image.`,
      },
    };
  const size = imageSize(bytes);
  if (!size || size.width < 1 || size.height < 1)
    return {
      refused: {
        status: 400,
        code: "invalid_icon",
        message: `That ${NAMES[type]} image could not be read.`,
      },
    };
  if (size.width > WORKSPACE_ICON_MAX_SIDE || size.height > WORKSPACE_ICON_MAX_SIDE)
    return {
      refused: {
        status: 400,
        code: "icon_too_large",
        message: `A ${noun} is at most ${WORKSPACE_ICON_MAX_SIDE} pixels on either side.`,
      },
    };
  return { icon: { type, bytes, version: iconVersion(bytes) } };
}

/**
 * The icon the database holds, read through `meta`, or null when it has none
 * or what it holds is not a whole icon: a row missing, a type an icon cannot
 * be, or bytes that do not match their version.
 */
export function readStoredIcon(meta: (key: string) => string | null): WorkspaceIcon | null {
  const type = meta(ICON_META_KEYS.type);
  const version = meta(ICON_META_KEYS.version);
  const data = meta(ICON_META_KEYS.data);
  if (!type || !version || !data) return null;
  if (!(WORKSPACE_ICON_TYPES as readonly string[]).includes(type)) return null;
  const bytes = Buffer.from(data, "base64");
  if (iconTypeOf(bytes) !== type || iconVersion(bytes) !== version) return null;
  return { type: type as WorkspaceIconType, bytes, version };
}

/** The `meta` rows that hold `icon`. */
export function storedIconRows(icon: WorkspaceIcon): [key: string, value: string][] {
  return [
    [ICON_META_KEYS.type, icon.type],
    [ICON_META_KEYS.version, icon.version],
    [ICON_META_KEYS.data, icon.bytes.toString("base64")],
  ];
}
