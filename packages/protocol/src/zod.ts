import { z } from "zod";

// Zod compiles a fast parser for each object schema with `new Function`, and
// probes for that once, as the first schema is built. The app's content
// security policy forbids eval, so in a browser the probe only fails, and
// Firefox reports it as a policy violation on every load. Every schema here
// is built from this `z`, so the setting is in place before the first one.
// The server keeps the compiled parsers.
if (typeof document !== "undefined") z.config({ jitless: true });

export { z };
