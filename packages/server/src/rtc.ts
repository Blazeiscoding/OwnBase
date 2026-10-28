import { z } from "zod";
import { ConfigError } from "./config.js";

const iceUrl = z
  .string()
  .max(500)
  .regex(/^(stun|stuns|turn|turns):[^\s]+$/);
export const iceServersSchema = z
  .array(
    z.object({
      urls: z.union([iceUrl, z.array(iceUrl).min(1).max(8)]),
      username: z.string().max(256).optional(),
      credential: z.string().max(512).optional(),
    }),
  )
  .max(8);

export function parseIceServers(value: string | undefined) {
  try {
    return iceServersSchema.parse(JSON.parse(value ?? "[]"));
  } catch {
    throw new ConfigError("OWNBASE_ICE_SERVERS must be a JSON array of STUN/TURN configurations");
  }
}
