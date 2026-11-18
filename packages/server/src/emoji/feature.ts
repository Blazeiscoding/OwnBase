import { CUSTOM_EMOJI_LIMIT, endpoints, isAdministrator } from "@ownbase/protocol";
import { declaredPictureType, type ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { checkedEmojiName, checkedEmojiPicture } from "./picture.js";

/**
 * The workspace's own emoji (J12): added by any member unless the workspace
 * keeps that to its owner and admins, removed by whoever added one or by an
 * admin, each change written to the audit log and told to everyone.
 */
export function registerEmoji(ctx: ServerContext) {
  const { store, settings, gateway, route, ration } = ctx;

  route(endpoints.customEmoji, async () => ({ emoji: store.emoji.list() }));

  route(endpoints.addCustomEmoji, async ({ req, user: me, query, body }) => {
    if (settings.get("emojiAddingAdminsOnly") && !isAdministrator(me.role))
      throw new HttpError(403, "emoji_adding_restricted", "Only admins can add emoji here.");
    ration("upload", me.id);
    const name = checkedEmojiName(query.name);
    const picture = checkedEmojiPicture(body, declaredPictureType(req));
    const emoji = store.transaction(() => {
      if (store.emoji.has(name))
        throw new HttpError(409, "emoji_name_taken", `:${name}: is taken. Choose another name.`);
      if (store.emoji.count() >= CUSTOM_EMOJI_LIMIT)
        throw new HttpError(
          409,
          "emoji_limit",
          `This workspace has ${CUSTOM_EMOJI_LIMIT} emoji, the most it can hold. Remove one first.`,
        );
      const added = store.emoji.add(name, picture, me.id);
      store.audit.record({
        actorId: me.id,
        action: "emoji.added",
        targetType: "emoji",
        targetId: added.id,
        details: { name, type: picture.type, bytes: picture.bytes.length },
      });
      return added;
    });
    gateway.tellEveryone({ type: "emoji.added", emoji });
    return { emoji };
  });

  route(endpoints.removeCustomEmoji, async ({ user: me, params }) => {
    const emoji = store.emoji.get(params.id);
    if (!emoji) throw new HttpError(404, "emoji_not_found", "That emoji is already gone.");
    if (emoji.createdBy !== me.id && !isAdministrator(me.role))
      throw new HttpError(
        403,
        "not_your_emoji",
        "Only the person who added an emoji, or an admin, can remove it.",
      );
    const removed = store.transaction(() => {
      if (!store.emoji.remove(emoji.id)) return false;
      store.audit.record({
        actorId: me.id,
        action: "emoji.removed",
        targetType: "emoji",
        targetId: emoji.id,
        details: { name: emoji.name },
      });
      return true;
    });
    if (removed) gateway.tellEveryone({ type: "emoji.removed", id: emoji.id, name: emoji.name });
    return { ok: true };
  });

  route(endpoints.customEmojiPicture, async ({ req, reply, params }) => {
    const picture = store.emoji.picture(params.id);
    if (!picture) {
      reply.header("cache-control", "no-store");
      throw new HttpError(404, "emoji_not_found", "That emoji is gone.");
    }
    // The id names this picture and no other, for good: a name added again
    // gets a new one, so the answer can be kept.
    const etag = `"${params.id}"`;
    reply
      .header("content-type", picture.type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("etag", etag)
      .header("cache-control", "private, max-age=31536000, immutable");
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply.header("content-length", String(picture.bytes.length)).send(picture.bytes);
  });

  route(endpoints.setEmojiAdding, async ({ user: me, body }) => {
    const adminsOnly = body.adminsOnly;
    if (adminsOnly !== settings.get("emojiAddingAdminsOnly")) {
      store.transaction(() => {
        settings.set("emojiAddingAdminsOnly", adminsOnly);
        store.audit.record({
          actorId: me.id,
          action: "workspace.emoji_adding_changed",
          targetType: "workspace",
          targetId: null,
          details: { adminsOnly },
        });
      });
      gateway.tellEveryone({ type: "workspace.emojiAdding", adminsOnly });
    }
    return { adminsOnly };
  });

  return {
    snapshot: () => ({
      customEmoji: store.emoji.list(),
      emojiAddingAdminsOnly: settings.get("emojiAddingAdminsOnly"),
    }),
  };
}
