import { useCallback, useRef } from "react";
import type { ID } from "@ownbase/protocol";
import { usePlatform } from "../context.js";
import { writeWorkspaceStorage } from "@ownbase/client-core";
import { useAccountKey, useAccountRead } from "./accountStorage.js";

/** Channel ids never contain anything else. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

const channelIdOf = (value: unknown): ID | null =>
  typeof value === "string" && TOKEN.test(value) ? value : null;

/**
 * The conversation this account last had open in this workspace, on this
 * device. `remembered` is undefined while it is being read, and null when
 * there is none or it could not be read, since #general is a fine answer.
 */
export function useLastConversation() {
  const platform = usePlatform();
  const key = useAccountKey("last-conversation");
  const remembered = useAccountRead(key, channelIdOf, null);
  const written = useRef<string | null>(null);

  const remember = useCallback(
    (channelId: ID) => {
      if (!key || written.current === `${key.key}\n${channelId}`) return;
      written.current = `${key.key}\n${channelId}`;
      // Losing this costs one click on the next start; nothing to report.
      writeWorkspaceStorage(platform, key, channelId).catch(() => {
        written.current = null;
      });
    },
    [platform, key],
  );

  return { remembered, remember };
}
