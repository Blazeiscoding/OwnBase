import { formatWhen } from "../lib/format.js";
import { useToday } from "../lib/today.js";

/** When something happened, as formatWhen says it, said again when the day turns. */
export function When({ at }: { at: number }) {
  useToday();
  return <>{formatWhen(at)}</>;
}
