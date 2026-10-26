// Loaded with `node --import` before the server, for the visual check only.
// The server's clock stands still at OWNBASE_FROZEN_AT and its random bytes
// come from a fixed seed, so seeding the same workspace gives the same ids,
// and with them the same avatar colours, and the same times on every run.
// A clock that moved would put a different millisecond into each id.
//
// Never use this for anything but a throwaway test server: its session
// tokens and password salts are the same every time.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const crypto = require("node:crypto");

const frozenAt = Number(process.env.OWNBASE_FROZEN_AT);
if (!Number.isFinite(frozenAt)) throw new Error("Set OWNBASE_FROZEN_AT to a time in milliseconds.");
Date.now = () => frozenAt;

// xorshift32: the same bytes, in the same order, every run.
let state = 0x9e3779b9;
const next = () => {
  state = (state ^ (state << 13)) >>> 0;
  state = (state ^ (state >>> 17)) >>> 0;
  state = (state ^ (state << 5)) >>> 0;
  return state;
};
crypto.randomBytes = (size, callback) => {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = next() & 0xff;
  if (!callback) return bytes;
  process.nextTick(callback, null, bytes);
};
// The bundled server imports randomBytes by name; this hands it the one above.
syncBuiltinESMExports();
