import { afterAll } from "vitest";
import type { ClientToServer, ServerToClient } from "@ownbase/protocol";

/**
 * Stands where the network does between a test file's clients and their
 * server, so a test does to a client only what a network or a server could:
 * drop its connection or keep it down, hold back what the server says, hand
 * it a frame as its server would, or lose what it sends. A connection is known
 * by the session token its hello carries.
 *
 * Offline, sockets never leave the process: nothing opens, and only frames the
 * test hands over arrive. That is a client with a server the test plays.
 *
 * Call it at the top of a test file, before any client connects. It puts the
 * real WebSocket back after the file's tests.
 */
export interface Network {
  /** Closes the connections of the client with `token`, as a dropped network does. */
  drop(token: string): void;
  /** Like `drop`, and every later try fails until `restore`. */
  keepDown(token: string): void;
  restore(token: string): void;
  /**
   * The device's network is back: a client waiting out its backoff tries
   * again at once, as it does on the browser's `online` event.
   */
  networkBack(): void;
  /** Holds what the server sends the client with `token` that `which` names, until released. */
  hold(
    token: string,
    which: (frame: ServerToClient) => boolean,
  ): { held(): number; release(): void };
  /**
   * Hands a frame to every connection of `token`'s account, as its server
   * would. Without a token, to the newest socket, which suits a file with one
   * client.
   */
  deliver(frame: ServerToClient, token?: string): void;
  /** What the client with `token` sent, in order, whether or not it arrived. */
  sent(token: string): ClientToServer[];
  /** What the client with `token` was told, in order, held or not. */
  heard(token: string): ServerToClient[];
  /** What the client with `token` sends that `which` names never reaches the server. */
  lose(token: string, which?: (frame: ClientToServer) => boolean): void;
}

interface Line {
  socket: WebSocket;
  token: string | null;
  /** The client's own `onmessage`. */
  handler: ((event: MessageEvent) => void) | null;
  sent: ClientToServer[];
  heard: ServerToClient[];
}

interface Hold {
  token: string;
  which: (frame: ServerToClient) => boolean;
  frames: { line: Line; event: MessageEvent }[];
}

export function network(options: { offline?: boolean } = {}): Network {
  const Real = globalThis.WebSocket;
  const lines: Line[] = [];
  const down = new Set<string>();
  const holds: Hold[] = [];
  const losing = new Map<string, (frame: ClientToServer) => boolean>();

  const parse = <T>(data: unknown): T | null => {
    try {
      return JSON.parse(String(data)) as T;
    } catch {
      return null;
    }
  };

  /** Takes over `onmessage`, so what arrives passes here before the client hears it. */
  function tap(socket: WebSocket): Line {
    const line: Line = { socket, token: null, handler: null, sent: [], heard: [] };
    lines.push(line);
    Object.defineProperty(socket, "onmessage", {
      configurable: true,
      get: () => line.handler,
      set: (handler: ((event: MessageEvent) => void) | null) => {
        line.handler = handler;
        const arrive = handler ? (event: MessageEvent) => arrived(line, event) : null;
        if (!options.offline) Reflect.set(Real.prototype, "onmessage", arrive, socket);
      },
    });
    return line;
  }

  function arrived(line: Line, event: MessageEvent): void {
    const frame = parse<ServerToClient>(event.data);
    if (frame) line.heard.push(frame);
    const hold = frame && holds.find((h) => h.token === line.token && h.which(frame));
    if (hold) hold.frames.push({ line, event });
    else line.handler?.call(line.socket, event);
  }

  /** Records what the client sends, and says whether it goes on to the server. */
  function sending(line: Line, data: unknown): boolean {
    const frame = parse<ClientToServer>(data);
    if (!frame) return true;
    if (frame.type === "hello") {
      line.token = frame.token;
      if (down.has(frame.token)) {
        line.socket.close();
        return false;
      }
    }
    line.sent.push(frame);
    return !(line.token && losing.get(line.token)?.(frame));
  }

  class TappedSocket extends Real {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      tap(this);
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const line = lines.find((l) => l.socket === this)!;
      if (sending(line, data)) super.send(data);
    }
  }

  /** Never connects: the test is the server. */
  class OfflineSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    declare onmessage: ((event: MessageEvent) => void) | null;
    constructor(readonly url: string) {
      super();
      tap(this as unknown as WebSocket);
    }
    send(): void {}
    close(): void {
      this.readyState = 3;
    }
  }

  globalThis.WebSocket = (options.offline ? OfflineSocket : TappedSocket) as typeof WebSocket;
  // The client listens for the browser's `online` event only where there is a window.
  const hadWindow = "window" in globalThis;
  if (!hadWindow) (globalThis as { window?: EventTarget }).window = new EventTarget();
  afterAll(() => {
    globalThis.WebSocket = Real;
    if (!hadWindow) delete (globalThis as { window?: EventTarget }).window;
  });

  const linesOf = (token: string) => lines.filter((line) => line.token === token);
  const open = (line: Line) => line.socket.readyState === 0 || line.socket.readyState === Real.OPEN;

  return {
    drop(token) {
      for (const line of linesOf(token)) if (open(line)) line.socket.close();
    },
    keepDown(token) {
      down.add(token);
      this.drop(token);
    },
    restore(token) {
      down.delete(token);
    },
    networkBack() {
      (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(new Event("online"));
    },
    hold(token, which) {
      const hold: Hold = { token, which, frames: [] };
      holds.push(hold);
      return {
        held: () => hold.frames.length,
        release() {
          const at = holds.indexOf(hold);
          if (at < 0) return;
          holds.splice(at, 1);
          for (const { line, event } of hold.frames) line.handler?.call(line.socket, event);
        },
      };
    },
    deliver(frame, token) {
      const to = token === undefined ? lines.slice(-1) : linesOf(token).filter(open);
      if (!to.length) throw new Error("No connection to hand that frame to.");
      for (const line of to) {
        line.heard.push(frame);
        const event = new MessageEvent("message", { data: JSON.stringify(frame) });
        line.handler?.call(line.socket, event);
      }
    },
    sent: (token) => linesOf(token).flatMap((line) => line.sent),
    heard: (token) => linesOf(token).flatMap((line) => line.heard),
    lose(token, which = () => true) {
      losing.set(token, which);
    },
  };
}
