import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchLinkPreview,
  previewImageType,
  previewLinks,
  readPage,
  PREVIEW_IMAGE_BYTES,
} from "../src/linkPreview.js";
import { getFromUrl, isPrivateAddress, OutboundError } from "../src/outbound.js";

/**
 * Link previews (E2): which links get one, what a page's head says, and the
 * guard every fetch goes through. The pages are served from loopback, which
 * the guard refuses like any private address, so these tests let 127.0.0.1
 * through by hand and nothing else.
 */
const servers: ReturnType<typeof createServer>[] = [];
const onlyLoopback = (address: string) => address !== "127.0.0.1" && isPrivateAddress(address);

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A PNG header naming its size; enough for the server, which never decodes one. */
function png(width: number, height: number, bytes = 64): Buffer {
  const out = Buffer.alloc(Math.max(bytes, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out, 0);
  out.writeUInt32BE(13, 8);
  out.write("IHDR", 12, "ascii");
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}

const page = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("which links get a preview", () => {
  it("takes the first three web addresses, each once, as the app links them", () => {
    expect(
      previewLinks(
        "See https://a.example/one, then <https://b.example/two|the doc> and " +
          "(https://c.example/three) and https://a.example/one again and https://d.example/four",
      ),
    ).toEqual(["https://a.example/one", "https://b.example/two", "https://c.example/three"]);
  });

  it("leaves out code, addresses with a password, links into a workspace, and other schemes", () => {
    expect(
      previewLinks(
        "`https://code.example/inline`\n```\nhttps://code.example/block\n```\n" +
          "https://me:secret@private.example/ http://tandem.example/#/c/C1/m/M1 " +
          "ftp://files.example/ https://kept.example/page?q=1#part",
      ),
    ).toEqual(["https://kept.example/page?q=1#part"]);
  });

  it("keeps brackets that belong to the address", () => {
    expect(previewLinks("https://en.wikipedia.org/wiki/Tandem_(disambiguation).")).toEqual([
      "https://en.wikipedia.org/wiki/Tandem_(disambiguation)",
    ]);
  });
});

describe("what a page says about itself", () => {
  it("prefers Open Graph, then Twitter, then the title and description tags", () => {
    expect(
      readPage(
        page(
          `<title>Plain title</title>
           <meta name="description" content="Plain description">
           <meta property="og:title" content="The &amp; launch &#8212; plan">
           <meta name="twitter:description" content='From "Twitter"'>
           <meta property="og:site_name" content="Example News">
           <meta property="og:image" content="/img/cover.png">`,
        ),
        "https://news.example/story/1",
      ),
    ).toEqual({
      title: "The & launch — plan",
      description: 'From "Twitter"',
      siteName: "Example News",
      imageUrl: "https://news.example/img/cover.png",
    });
    expect(
      readPage(
        page(`<title>
          Only   a <b>title</b>
        </title>`),
        "https://www.plain.example/",
      ),
    ).toEqual({
      title: "Only a title",
      description: "",
      siteName: "plain.example",
      imageUrl: null,
    });
  });

  it("has nothing to show without a title or a description, and reads only the head", () => {
    expect(readPage(page(`<meta charset="utf-8">`), "https://x.example/")).toBeNull();
    expect(
      readPage(page("", `<meta property="og:title" content="In the body">`), "https://x.example/"),
    ).toBeNull();
  });

  it("cuts what is too long, and keeps no picture that is not on the web", () => {
    const long = readPage(
      page(
        `<meta property="og:title" content="${"word ".repeat(100)}">
         <meta property="og:image" content="javascript:alert(1)">`,
      ),
      "https://x.example/",
    )!;
    expect(long.title.length).toBeLessThanOrEqual(200);
    expect(long.title.endsWith("…")).toBe(true);
    expect(long.imageUrl).toBeNull();
  });

  it("knows a picture by its first bytes", () => {
    expect(previewImageType(png(10, 10))).toBe("image/png");
    expect(previewImageType(Buffer.from("GIF89a......"))).toBe("image/gif");
    expect(previewImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });
});

describe("fetching a preview through the guard", () => {
  it("reads a page and keeps its picture, fetched by the server", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/cover.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png(1200, 630));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        page(`<meta property="og:title" content="Launch day">
              <meta property="og:description" content="Everything ships at noon.">
              <meta property="og:image" content="/cover.png">`),
      );
    });
    const preview = await fetchLinkPreview(`${base}/story`, { blocked: onlyLoopback });
    expect(preview).toMatchObject({
      url: `${base}/story`,
      title: "Launch day",
      description: "Everything ships at noon.",
      siteName: "127.0.0.1",
      image: { type: "image/png", width: 1200, height: 630 },
    });
  });

  it("refuses a private address, given or behind a name, without being told to allow it", async () => {
    const base = await serve((_req, res) => res.end(page("<title>Router admin</title>")));
    const port = new URL(base).port;
    expect(await fetchLinkPreview(`${base}/`)).toBeNull();
    await expect(getFromUrl(`${base}/`, { accept: "text/html" })).rejects.toMatchObject({
      code: "blocked_host",
    });
    await expect(
      getFromUrl(`http://localhost:${port}/`, { accept: "text/html" }),
    ).rejects.toMatchObject({ code: "blocked_host" });
  });

  it("checks every redirect again, so a page cannot hand on a private address", async () => {
    let hops = 0;
    const base = await serve((req, res) => {
      hops++;
      if (req.url === "/to-private") {
        res.writeHead(302, { location: "http://10.255.255.1/admin" });
        res.end();
      } else if (req.url === "/to-metadata") {
        res.writeHead(301, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (req.url === "/round") {
        res.writeHead(302, { location: "/round" });
        res.end();
      } else if (req.url === "/to-page") {
        res.writeHead(303, { location: "/final" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page(`<title>Final</title><meta property="og:image" content="pic.png">`));
      }
    });
    const opts = { accept: "text/html", blocked: onlyLoopback };
    await expect(getFromUrl(`${base}/to-private`, opts)).rejects.toMatchObject({
      code: "blocked_host",
    });
    await expect(getFromUrl(`${base}/to-metadata`, opts)).rejects.toMatchObject({
      code: "blocked_host",
    });
    hops = 0;
    await expect(getFromUrl(`${base}/round`, opts)).rejects.toMatchObject({
      code: "unreachable",
    });
    expect(hops).toBe(4);
    const followed = await getFromUrl(`${base}/to-page`, opts);
    expect(followed).toMatchObject({ status: 200, url: `${base}/final` });
    expect(await fetchLinkPreview(`${base}/to-private`, { blocked: onlyLoopback })).toBeNull();
  });

  it("reads only the start of a long page, and keeps no picture that is too large", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/big.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png(800, 600, PREVIEW_IMAGE_BYTES + 1));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        page(
          `<title>Long page</title><meta property="og:image" content="/big.png">`,
          "x".repeat(2_000_000),
        ),
      );
    });
    expect(await fetchLinkPreview(`${base}/long`, { blocked: onlyLoopback })).toMatchObject({
      title: "Long page",
      image: null,
    });
  });

  it("gives up on a page that does not answer in time", async () => {
    const base = await serve(() => {
      // Never answers.
    });
    const started = Date.now();
    expect(
      await fetchLinkPreview(`${base}/slow`, { blocked: onlyLoopback, timeoutMs: 200 }),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(
      getFromUrl(`${base}/slow`, { accept: "text/html", blocked: onlyLoopback, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(OutboundError);
  });

  it("previews only HTML, and keeps no picture whose bytes are not one", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/data.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ title: "Not a page" }));
      } else if (req.url === "/notes.txt") {
        // Text that reads like a page is still not one.
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(page("<title>Plain text notes</title>"));
      } else if (req.url === "/moving.gif") {
        res.writeHead(200, { "content-type": "image/png" });
        const gif = Buffer.alloc(64);
        gif.write("GIF89a", 0, "ascii");
        gif.writeUInt16LE(480, 6);
        gif.writeUInt16LE(270, 8);
        res.end(gif);
      } else if (req.url === "/fake.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
      } else if (req.url === "/huge.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png(100_000, 100_000));
      } else if (req.url === "/missing") {
        res.writeHead(404, { "content-type": "text/html" });
        res.end(page("<title>Not found</title>"));
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        const image =
          req.url === "/claims-huge"
            ? "/huge.png"
            : req.url === "/animated"
              ? "/moving.gif"
              : "/fake.png";
        res.end(page(`<title>A page</title><meta property="og:image" content="${image}">`));
      }
    });
    const opts = { blocked: onlyLoopback };
    expect(await fetchLinkPreview(`${base}/data.json`, opts)).toBeNull();
    expect(await fetchLinkPreview(`${base}/notes.txt`, opts)).toBeNull();
    // Kept as what its bytes are, whatever the site called it.
    expect(await fetchLinkPreview(`${base}/animated`, opts)).toMatchObject({
      image: { type: "image/gif", width: 480, height: 270 },
    });
    expect(await fetchLinkPreview(`${base}/missing`, opts)).toBeNull();
    expect(await fetchLinkPreview(`${base}/page`, opts)).toMatchObject({
      title: "A page",
      image: null,
    });
    expect(await fetchLinkPreview(`${base}/claims-huge`, opts)).toMatchObject({ image: null });
  });

  it("reads a page in the character set it says it uses", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
      res.end(Buffer.from(page("<title>Caf\xe9 menu</title>"), "latin1"));
    });
    expect(await fetchLinkPreview(`${base}/`, { blocked: onlyLoopback })).toMatchObject({
      title: "Café menu",
    });
  });
});
