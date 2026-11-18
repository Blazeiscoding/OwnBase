// Optional maintainer command: pnpm exec playwright install chromium, then
// node scripts/generate-icons.mjs. Generated assets are checked in so packaging
// itself never needs a browser download or an image processing dependency.
//
// Every icon is drawn from scripts/icon-art.mjs, the cabin on its pixel grid,
// at sizes that are whole multiples of the grid wherever a platform allows.
import { chromium } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { svg } from "./icon-art.mjs";

const root = new URL("../", import.meta.url);
const destination = new URL("apps/desktop/build/", root);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch();

/** `art` drawn `size` pixels across, in the middle of a transparent `canvas`. */
async function png(art, size, canvas = size, over = "") {
  const page = await browser.newPage({ viewport: { width: canvas, height: canvas } });
  try {
    await page.setContent(
      `<style>body{margin:0;display:grid;place-items:center;width:${canvas}px;height:${canvas}px}` +
        `svg{width:${size}px;height:${size}px;display:block}</style>${art}${over}`,
    );
    return await page.screenshot({ omitBackground: true });
  } finally {
    await page.close();
  }
}

/** An ICO file holding each entry's PNG. */
function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    // A width and height of zero mean 256.
    header.writeUInt8(size % 256, at);
    header.writeUInt8(size % 256, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map(({ data }) => data)]);
}

/** The taskbar overlay: the accent circle, ringed, with `text` in white, or none for a dot. */
function badge(text) {
  const words =
    text &&
    `<text x="16" y="17" dominant-baseline="middle" text-anchor="middle" fill="#fff" ` +
      `font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="700" ` +
      `font-size="${text.length > 1 ? 15 : 20}">${text}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<circle cx="16" cy="16" r="${text ? 15 : 10}" fill="#f97316" stroke="#7c2d12" stroke-width="2"/>` +
    `${words}</svg>`
  );
}

try {
  const large = svg();
  const small = svg({ small: true });
  await writeFile(new URL("icon.png", destination), await png(large, 256));

  // Windows picks the entry nearest the size it shows: 16 to 32 in the tray and
  // the taskbar as the display scales, 256 in Explorer. Under 24 it gets the
  // 16-pixel drawing. Each entry is a PNG, which ICO allows since Vista.
  const entries = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256])
    entries.push({ size, data: await png(size < 24 ? small : large, size) });
  await writeFile(new URL("icon.ico", destination), ico(entries));

  // What waits, outside the window (J16). Windows puts an overlay on the
  // taskbar button, drawn 16 pixels across from these 32: a circle in the
  // accent with a dark ring, so it reads on a light taskbar and a dark one,
  // and a white number, "9+" past nine, or none for unread without a mention.
  for (const text of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "9+", ""])
    await writeFile(
      new URL(`badge-${text === "9+" ? "9plus" : text || "dot"}.png`, destination),
      await png(badge(text), 32),
    );
  // The tray icon with a dot in its corner, at the tray's sizes.
  const dot = (size) =>
    `<div style="position:fixed;right:0;top:0;width:${Math.round(size * 0.45)}px;height:${Math.round(size * 0.45)}px;border-radius:50%;background:#f97316;box-shadow:0 0 0 ${Math.max(1, Math.round(size / 16))}px #7c2d12 inset"></div>`;
  await writeFile(new URL("tray-unread.png", destination), await png(large, 256, 256, dot(256)));
  const unreadEntries = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64])
    unreadEntries.push({ size, data: await png(size < 24 ? small : large, size, size, dot(size)) });
  await writeFile(new URL("tray-unread.ico", destination), ico(unreadEntries));

  // macOS sets app icons on a 1024px canvas, the shape in the middle 824px; a
  // shape that fills the canvas is shrunk onto a grey plate. 832 is the nearest
  // whole multiple of the grid, 26 pixels to each of its 32.
  await writeFile(new URL("icon-mac.png", destination), await png(large, 832, 1024));

  // The browser client's home-screen icons. A maskable icon fills its square for
  // the launcher to cut its own shape, so the scene runs to the edges and the
  // cabin stays inside the middle 80%, which every shape shows. iOS cuts the
  // touch icon to its own shape too: there the grid is 36, 5 pixels to each.
  const web = new URL("apps/web/public/", root);
  const shots = [
    { file: "icon-192.png", size: 192, art: large },
    { file: "icon-512.png", size: 512, art: large },
    { file: "icon-maskable-512.png", size: 512, art: svg({ rounded: false }) },
    { file: "apple-touch-icon.png", size: 180, art: svg({ size: 36, rounded: false }) },
  ];
  for (const { file, size, art } of shots)
    await writeFile(new URL(file, web), await png(art, size));
} finally {
  await browser.close();
}
