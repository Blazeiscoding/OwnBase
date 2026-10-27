import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";

const require = createRequire(import.meta.url);

/** The upgrade listener sees a raw request target, before Fastify's routing. */
function upgradeTarget(port: number, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`The malformed upgrade was not closed: ${target}`));
    }, 2000);
    socket.once("connect", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n` +
          "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    socket.on("data", () => {});
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

it("refuses malformed upgrade targets without ending the server process", async () => {
  // This must run outside the test process: a throw in the raw upgrade event
  // is an uncaught exception, rather than a rejected request or promise.
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(require.resolve("tsx")).href,
      "--input-type=module",
      "-e",
      `import { createWorkspaceServer } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
       const server = await createWorkspaceServer({dataDir: ":memory:", host: "127.0.0.1", port: 0, mdns: false});
       process.on("message", async (message) => {
         if (message === "stop") {
           await server.stop();
           process.disconnect();
         }
       });
       console.log(JSON.stringify({port: server.port}));`,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout! });
  const port = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${stderr}`)), 5000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve((JSON.parse(line) as { port: number }).port);
    });
    void exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with ${code}: ${stderr}`));
    });
    child.once("error", reject);
  });
  let ws: WebSocket | undefined;
  try {
    const actualPort = await port;
    const base = `http://127.0.0.1:${actualPort}`;
    expect((await fetch(`${base}/api/health`)).status).toBe(200);

    for (const target of ["http://[::1/ws", "//[::1/ws", "http://%zz/ws", "/ws%zz"]) {
      await upgradeTarget(actualPort, target);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Malformed target ended the server: ${target}\n${stderr}`);
      }
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
    }

    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    });
    expect(registered.status).toBe(201);
    const { token } = (await registered.json()) as { token: string };
    ws = new WebSocket(`ws://127.0.0.1:${actualPort}/ws?client=regression`);
    const ready = await new Promise<ServerToClient>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Valid socket did not authenticate")), 2000);
      ws!.once("open", () => {
        ws!.send(
          JSON.stringify({
            type: "hello",
            token,
            lastSeq: null,
            protocolVersion: PROTOCOL_VERSION,
          }),
        );
      });
      ws!.on("message", (data) => {
        const message = JSON.parse(String(data)) as ServerToClient;
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve(message);
        }
      });
      ws!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(ready.type).toBe("ready");
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  } finally {
    ws?.terminate();
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send("stop", () => {});
      else child.kill("SIGKILL");
      const forced = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(forced);
    }
  }
}, 15_000);
