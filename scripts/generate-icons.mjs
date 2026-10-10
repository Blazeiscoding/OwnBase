// Optional maintainer command: pnpm exec playwright install chromium, then
// node scripts/generate-icons.mjs. Generated assets are checked in so packaging
// itself never needs a browser download or an image processing dependency.
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = new URL("apps/web/public/tandem.svg", root);
const destination = new URL("apps/desktop/build/", root);
await mkdir(destination, { recursive: true });
await mkdir(new URL("apps/desktop/src/renderer/public/", root), { recursive: true });
await copyFile(source, new URL("apps/desktop/src/renderer/public/tandem.svg", root));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 256, height: 256 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<style>body{margin:0}svg{width:256px;height:256px;display:block}</style>${await readFile(source, "utf8")}`,
  );
  const png = await page.screenshot({ omitBackground: true });
  await writeFile(new URL("icon.png", destination), png);
  // ICO directory with a single 256px PNG image (width/height zero means 256).
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  await writeFile(new URL("icon.ico", destination), Buffer.concat([header, png]));

  // macOS sets app icons on a 1024px canvas, the mark in the middle 824px with
  // its corner radius; a mark that fills the canvas is shrunk onto a grey plate.
  const svg = await readFile(source, "utf8");
  const macSvg = svg.replace('rx="12"', 'rx="9"');
  if (macSvg === svg) throw new Error('tandem.svg no longer has rx="12"; update the macOS icon.');
  const mac = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await mac.setContent(
    `<style>body{margin:0;display:grid;place-items:center;width:1024px;height:1024px}svg{width:824px;height:824px;display:block}</style>${macSvg}`,
  );
  await writeFile(
    new URL("icon-mac.png", destination),
    await mac.screenshot({ omitBackground: true }),
  );
  await mac.close();

  // The browser client's home-screen icons. The maskable one fills its square
  // and keeps the mark inside the middle 80%, where every launcher shape shows it.
  const web = new URL("apps/web/public/", root);
  const shots = [
    { file: "icon-192.png", size: 192, maskable: false },
    { file: "icon-512.png", size: 512, maskable: false },
    { file: "icon-maskable-512.png", size: 512, maskable: true },
    { file: "apple-touch-icon.png", size: 180, maskable: true },
  ];
  for (const { file, size, maskable } of shots) {
    const shot = await browser.newPage({ viewport: { width: size, height: size } });
    const mark = maskable ? Math.round(size * 0.8) : size;
    await shot.setContent(
      `<style>body{margin:0;display:grid;place-items:center;width:${size}px;height:${size}px;` +
        `background:${maskable ? "#f97316" : "transparent"}}svg{width:${mark}px;height:${mark}px;display:block}</style>${svg}`,
    );
    await writeFile(new URL(file, web), await shot.screenshot({ omitBackground: !maskable }));
    await shot.close();
  }
} finally {
  await browser.close();
}
