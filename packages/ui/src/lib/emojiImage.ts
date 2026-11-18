import {
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_MAX_SIDE,
  CUSTOM_EMOJI_TYPES,
} from "@ownbase/protocol";

/** Why a picture cannot become a custom emoji, said to whoever chose it. */
export class EmojiPictureProblem extends Error {}

/** The largest picture read at all: a bigger one is made smaller, never sent whole. */
const LARGEST_PICTURE = 25 * 1024 * 1024;

const SENT_AS_IS: readonly string[] = CUSTOM_EMOJI_TYPES;

/**
 * Makes a custom emoji's picture from the file someone chose (J12). One the
 * server takes as it is goes as it is, so an animated GIF, PNG or WebP keeps
 * moving. A larger still picture is made to fit `CUSTOM_EMOJI_MAX_SIDE` and
 * sent as PNG, which keeps transparency; the server never resizes. A GIF
 * cannot be made smaller here without losing its frames, so a large one is
 * refused with what to do.
 */
export async function prepareEmojiPicture(file: File): Promise<Blob> {
  if (file.type === "image/svg+xml")
    throw new EmojiPictureProblem("An SVG can't be an emoji. Choose a PNG, GIF or WebP picture.");
  if (!file.type.startsWith("image/"))
    throw new EmojiPictureProblem("Choose a PNG, GIF or WebP picture.");
  if (file.size > LARGEST_PICTURE)
    throw new EmojiPictureProblem("That picture is over 25 MB. Choose a smaller one.");
  let picture: ImageBitmap;
  try {
    picture = await createImageBitmap(file);
  } catch {
    throw new EmojiPictureProblem("OwnBase could not open that picture. Choose another one.");
  }
  try {
    const fits = picture.width <= CUSTOM_EMOJI_MAX_SIDE && picture.height <= CUSTOM_EMOJI_MAX_SIDE;
    if (SENT_AS_IS.includes(file.type) && fits && file.size <= CUSTOM_EMOJI_MAX_BYTES) return file;
    if (file.type === "image/gif")
      throw new EmojiPictureProblem(
        `An emoji is at most ${CUSTOM_EMOJI_MAX_SIDE} pixels a side and ${CUSTOM_EMOJI_MAX_BYTES / 1024} KB. Make the GIF smaller first, or it stops moving.`,
      );
    const scale = Math.min(1, CUSTOM_EMOJI_MAX_SIDE / Math.max(picture.width, picture.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(picture.width * scale));
    canvas.height = Math.max(1, Math.round(picture.height * scale));
    const context = canvas.getContext("2d");
    if (!context)
      throw new EmojiPictureProblem("This browser can't resize pictures. Try another browser.");
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new EmojiPictureProblem("Could not resize that picture. Try another one.");
    if (png.size > CUSTOM_EMOJI_MAX_BYTES)
      throw new EmojiPictureProblem(
        "That picture is too detailed for an emoji. Choose a simpler one.",
      );
    return png;
  } finally {
    picture.close();
  }
}
