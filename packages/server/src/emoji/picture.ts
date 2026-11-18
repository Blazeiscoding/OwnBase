import {
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_MAX_SIDE,
  CUSTOM_EMOJI_NAME,
  CUSTOM_EMOJI_TYPES,
  type CustomEmojiType,
} from "@ownbase/protocol";
import { HttpError } from "../httpError.js";
import { emojiForSlackName } from "../import/slackEmoji.js";
import { imageSize, imageTypeOf } from "../imageSize.js";

const NAMES: Record<CustomEmojiType, string> = {
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WebP",
};

/**
 * Checks a custom emoji's picture as the workspace icon's is checked: the
 * type from the file's first bytes, agreeing with what the request said, and
 * the size its header claims held to a bound. The server never decodes it.
 */
export function checkedEmojiPicture(
  bytes: Buffer,
  declared: string | undefined,
): { type: CustomEmojiType; bytes: Buffer } {
  const said = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(CUSTOM_EMOJI_TYPES as readonly string[]).includes(said))
    throw new HttpError(415, "unsupported_emoji_type", "An emoji is a PNG, GIF or WebP image.");
  if (bytes.length > CUSTOM_EMOJI_MAX_BYTES)
    throw new HttpError(
      413,
      "emoji_too_large",
      `An emoji has at most ${CUSTOM_EMOJI_MAX_BYTES / 1024} KB.`,
    );
  const type = imageTypeOf(bytes);
  if (type === null || type === "image/jpeg")
    throw new HttpError(400, "invalid_emoji", "That file is not a PNG, GIF or WebP image.");
  if (type !== said)
    throw new HttpError(
      400,
      "invalid_emoji",
      `That file says it is ${NAMES[said as CustomEmojiType]} but holds a ${NAMES[type]} image.`,
    );
  const size = imageSize(bytes);
  if (!size || size.width < 1 || size.height < 1)
    throw new HttpError(400, "invalid_emoji", `That ${NAMES[type]} image could not be read.`);
  if (size.width > CUSTOM_EMOJI_MAX_SIDE || size.height > CUSTOM_EMOJI_MAX_SIDE)
    throw new HttpError(
      400,
      "emoji_too_large",
      `An emoji is at most ${CUSTOM_EMOJI_MAX_SIDE} pixels on either side.`,
    );
  return { type, bytes };
}

/**
 * The name as given, or a refusal that says the rule. A name a standard
 * emoji already has is refused, so `:smile:` always means the same face.
 */
export function checkedEmojiName(name: string): string {
  if (!CUSTOM_EMOJI_NAME.test(name))
    throw new HttpError(
      400,
      "invalid_emoji_name",
      "An emoji name has 1 to 32 lowercase letters, digits, dashes or underscores.",
    );
  if (emojiForSlackName(name) !== null)
    throw new HttpError(
      409,
      "emoji_name_taken",
      `:${name}: is already a standard emoji. Choose another name.`,
    );
  return name;
}
