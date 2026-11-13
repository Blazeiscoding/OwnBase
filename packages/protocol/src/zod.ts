import { z } from "zod";

// Zod compiles a fast parser for each object schema with `new Function`, and
// probes for that once, as the first schema is built. The app's content
// security policy forbids eval, so in a browser the probe only fails, and
// Firefox reports it as a policy violation. Every schema here is built from
// this `z`, so the setting is in place before the first one. package.json
// names this file as having side effects: otherwise the bundler follows the
// re-export straight to zod and drops the setting. The server keeps the
// compiled parsers.
if ("document" in globalThis) z.config({ jitless: true });

export { z };
