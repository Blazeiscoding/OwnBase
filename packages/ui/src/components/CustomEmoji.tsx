import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { customEmojiName, isAdministrator, type CustomEmoji } from "@ownbase/protocol";
import { ClientContext } from "../context.js";

const NONE: Record<string, CustomEmoji> = {};
const unsubscribed = () => undefined;

/** The workspace's custom emoji by name (J12), or none outside a workspace. */
export function useCustomEmoji(): Record<string, CustomEmoji> {
  const client = useContext(ClientContext);
  const read = () => client?.store.getState().customEmoji ?? NONE;
  return useSyncExternalStore(
    (changed) => client?.store.subscribe(changed) ?? unsubscribed,
    read,
    read,
  );
}

/** The custom emoji a `:name:` token stands for, if the workspace has it. */
export function customEmojiFor(
  known: Record<string, CustomEmoji>,
  token: string,
): CustomEmoji | null {
  const name = customEmojiName(token);
  return name !== null && Object.hasOwn(known, name) ? known[name]! : null;
}

/**
 * A custom emoji's picture as an object URL once fetched, or null meanwhile.
 * The server serves it only to someone signed in, which an <img> cannot
 * say, so it is fetched as profile pictures are.
 */
function useEmojiPicture(emoji: CustomEmoji): string | null {
  const client = useContext(ClientContext);
  const { id } = emoji;
  const [url, setUrl] = useState(() => client?.emojiPictures.peek(id, id) ?? null);
  useEffect(() => {
    if (!client) return;
    const known = client.emojiPictures.peek(id, id);
    setUrl(known);
    if (known) return;
    let live = true;
    void client.emojiPictures.load(id, id).then((loaded) => {
      if (live) setUrl(loaded);
    });
    return () => {
      live = false;
    };
  }, [client, id]);
  return url;
}

/**
 * A custom emoji drawn the height of the text around it, named `:name:` for
 * screen readers and on hover. An animated picture plays as its file says:
 * showing a still frame under reduced motion would need decoding it.
 */
export function CustomEmojiImage({ emoji }: { emoji: CustomEmoji }) {
  const url = useEmojiPicture(emoji);
  const label = `:${emoji.name}:`;
  return url ? (
    <img src={url} alt={label} title={label} draggable={false} className="custom-emoji" />
  ) : (
    <span role="img" aria-label={label} title={label} className="custom-emoji" />
  );
}

/**
 * Whether this account may add custom emoji: any member, unless the workspace
 * keeps adding to its owner and admins. Guests never.
 */
export function useMayAddEmoji(): boolean {
  const client = useContext(ClientContext);
  const read = () => {
    const state = client?.store.getState();
    const role = state?.self?.role;
    if (!role || role === "guest") return false;
    return !state.emojiAddingAdminsOnly || isAdministrator(role);
  };
  return useSyncExternalStore(
    (changed) => client?.store.subscribe(changed) ?? unsubscribed,
    read,
    read,
  );
}
