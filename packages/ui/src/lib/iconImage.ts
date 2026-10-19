import {
  WORKSPACE_ICON_MAX_BYTES,
  WORKSPACE_ICON_PIXELS,
  WORKSPACE_ICON_TYPES,
} from "@slackoss/protocol";
import { squareCanvas } from "./workspaceIcon.js";

/** Why a picture cannot become the workspace's icon, said to whoever chose it. */
export class IconProblem extends Error {}

/** The largest picture read at all: an icon is cut down from it, never sent whole. */
const LARGEST_PICTURE = 25 * 1024 * 1024;

function encoded(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Makes the workspace's icon from a picture someone chose (UX-60): its
 * middle square, at `WORKSPACE_ICON_PIXELS` a side, as WebP where the browser
 * can write it and PNG where not. The server keeps what it is sent and never
 * resizes it, so the work is done here. Throws `IconProblem`, saying why,
 * for a picture that cannot become one.
 */
export async function prepareIcon(file: File): Promise<Blob> {
  if (!(WORKSPACE_ICON_TYPES as readonly string[]).includes(file.type))
    throw new IconProblem(
      file.type === "image/svg+xml"
        ? "An SVG can't be an icon. Choose a PNG, JPEG or WebP picture."
        : "Choose a PNG, JPEG or WebP picture.",
    );
  if (file.size > LARGEST_PICTURE)
    throw new IconProblem("That picture is over 25 MB. Choose a smaller one.");
  let picture: ImageBitmap;
  try {
    picture = await createImageBitmap(file);
  } catch {
    throw new IconProblem("That picture could not be read. Choose another PNG, JPEG or WebP.");
  }
  try {
    const canvas = squareCanvas(picture, WORKSPACE_ICON_PIXELS);
    if (!canvas) throw new IconProblem("This browser can't prepare pictures. Try another one.");
    const webp = await encoded(canvas, "image/webp", 0.9);
    const image = webp?.type === "image/webp" ? webp : await encoded(canvas, "image/png");
    if (!image) throw new IconProblem("That picture could not be prepared. Try another one.");
    if (image.size > WORKSPACE_ICON_MAX_BYTES)
      throw new IconProblem("That picture is too detailed for an icon. Choose a simpler one.");
    return image;
  } finally {
    picture.close();
  }
}
