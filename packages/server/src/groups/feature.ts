import { endpoints, type AuditEntry, type ID, type User, type UserGroup } from "@ownbase/protocol";
import type { ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";

/**
 * User groups (J13): admins make them, rename them, change who is in them and
 * delete them, each change written to the audit log and told to everyone but
 * guests. Any full member may mention one; `MessageStore` turns a mention
 * into a mention of each person in it who is in the conversation.
 */
export function registerGroups(ctx: ServerContext) {
  const { store, gateway, route } = ctx;

  const handleRefused = (handle: string) =>
    new HttpError(409, "handle_taken", `@${handle} is taken. Choose another handle.`);

  /** The people a group may hold: accounts that exist, and not apps. */
  const checkedMembers = (ids: readonly ID[]): ID[] => {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      const user = store.people.get(id);
      if (!user || user.isBot)
        throw new HttpError(400, "invalid_group_member", "Only people can be in a group.");
    }
    return unique;
  };

  route(endpoints.createUserGroup, async ({ user: me, body }) => {
    const memberIds = checkedMembers(body.memberIds);
    const group = store.transaction(() => {
      if (store.people.handleTaken(body.handle)) throw handleRefused(body.handle);
      const made = store.groups.create({ ...body, memberIds }, me.id);
      store.audit.record({
        actorId: me.id,
        action: "group.created",
        targetType: "group",
        targetId: made.id,
        details: { handle: made.handle, name: made.name, members: made.memberIds.length },
      });
      return made;
    });
    gateway.tellMembers({ type: "userGroup.saved", group });
    return { group };
  });

  route(endpoints.updateUserGroup, async ({ user: me, params, body }) => {
    const memberIds = body.memberIds ? checkedMembers(body.memberIds) : undefined;
    const group = store.transaction(() => {
      const before = store.groups.get(params.id);
      if (!before) throw new HttpError(404, "group_not_found", "That group is gone.");
      if (body.handle !== undefined && body.handle !== before.handle) {
        if (store.people.handleTaken(body.handle)) throw handleRefused(body.handle);
      }
      const after = store.groups.update(before.id, { ...body, memberIds });
      store.audit.record({
        actorId: me.id,
        action: "group.updated",
        targetType: "group",
        targetId: after.id,
        details: changes(before, after),
      });
      return after;
    });
    gateway.tellMembers({ type: "userGroup.saved", group });
    return { group };
  });

  route(endpoints.deleteUserGroup, async ({ user: me, params }) => {
    const deleted = store.transaction(() => {
      const group = store.groups.get(params.id);
      if (!group) return false;
      store.groups.delete(group.id);
      store.audit.record({
        actorId: me.id,
        action: "group.deleted",
        targetType: "group",
        targetId: group.id,
        details: { handle: group.handle, members: group.memberIds.length },
      });
      return true;
    });
    if (deleted) gateway.tellMembers({ type: "userGroup.deleted", id: params.id });
    return { ok: true };
  });

  return {
    /** Guests see no groups: a group can hold people a guest cannot see. */
    snapshot: (user: User) => ({
      userGroups: user.role === "guest" ? [] : store.groups.list(),
    }),
  };
}

/** What an update changed, for the audit log: the words, and how many came and went. */
function changes(before: UserGroup, after: UserGroup): AuditEntry["details"] {
  const details: AuditEntry["details"] = { handle: after.handle };
  if (before.handle !== after.handle) details.previousHandle = before.handle;
  if (before.name !== after.name) details.name = after.name;
  if (before.description !== after.description) details.description = after.description;
  const added = after.memberIds.filter((id) => !before.memberIds.includes(id)).length;
  const removed = before.memberIds.filter((id) => !after.memberIds.includes(id)).length;
  if (added > 0) details.added = added;
  if (removed > 0) details.removed = removed;
  return details;
}
