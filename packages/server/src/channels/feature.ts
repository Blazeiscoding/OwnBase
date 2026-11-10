import {
  canRemoveChannelMember,
  canSetChannelManager,
  channelPermissions,
  endpoints,
  SIDEBAR_SECTIONS_MAX,
  type ID,
  type User,
} from "@ownbase/protocol";
import { guestRestricted, requireChannelAccess, type ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";

/** Conversations: rooms and DMs, who is in them, each member's prefs and read place, and the sidebar. */
export function registerChannels(ctx: ServerContext) {
  const { store, route, recordEvent, mutate } = ctx;

  /** Puts someone new in every open public channel, as a new channel takes in everyone. */
  const joinPublicChannels = (userId: ID, emit: typeof recordEvent) => {
    for (const channel of store.channels.visibleTo(userId)) {
      if (channel.type !== "public" || channel.archived) continue;
      if (store.channels.addMember(channel.id, userId)) {
        emit({ type: "member.joined", channelId: channel.id, userId });
      }
    }
  };

  route(endpoints.listChannels, async ({ user: me }) => {
    return {
      channels: store.channels.visibleTo(me.id),
      memberCounts: store.channels.roomMemberCounts(me.id),
    };
  });

  route(endpoints.createChannel, async ({ reply, user: me, body }) => {
    return mutate((emit) => {
      if (body.type === "public" || body.type === "private") {
        if (store.channels.byName(body.name)) throw new HttpError(409, "name_taken");
        // A public channel takes in everyone here, as Discord's do, so it
        // shows up for them at once; each can leave it. A private one only
        // the people it was made for.
        const memberIds = [
          ...new Set([
            me.id,
            ...(body.type === "private" ? (body.memberIds ?? []) : store.accounts.listPeopleIds()),
          ]),
        ];
        if (body.type === "private") {
          for (const id of memberIds) {
            const member = store.people.get(id);
            if (!member) throw new HttpError(400, "unknown_user", id);
            if (member.role === "guest") throw guestRestricted();
          }
        }
        const channel = store.channels.create({
          type: body.type,
          name: body.name,
          topic: body.topic,
          description: body.description,
          creatorId: me.id,
          memberIds,
        });
        emit({ type: "channel.created", channel });
        // Named channels carry no memberIds, so announce the founding members
        // explicitly or clients won't know they belong to it.
        for (const userId of memberIds) {
          emit({ type: "member.joined", channelId: channel.id, userId });
        }
        return { channel };
      }

      // dm / group_dm — idempotent on the member set.
      const memberIds = [...new Set([me.id, ...body.memberIds])].sort();
      for (const id of memberIds) {
        const member = store.people.get(id);
        if (!member) throw new HttpError(400, "unknown_user", id);
        if (member.role === "guest") throw guestRestricted();
      }
      const dmKey = memberIds.join(":");
      const existing = store.channels.findDmByKey(dmKey);
      if (existing) {
        if ([...(existing.memberIds ?? [])].sort().join(":") === dmKey) {
          reply.status(200);
          return { channel: existing };
        }
        // Legacy groups may still have the original key after someone left.
        // Never restore that person's access to the group's intervening history.
        store.channels.retireDmKey(existing.id);
      }

      const channel = store.channels.create({
        type: memberIds.length === 2 ? "dm" : "group_dm",
        creatorId: me.id,
        memberIds,
        dmKey,
      });
      emit({ type: "channel.created", channel });
      return { channel };
    });
  });

  route(endpoints.updateChannel, async ({ user: me, body, params }) => {
    const existing = requireChannelAccess(store, params.id, me);
    if (existing.type === "dm" || existing.type === "group_dm") {
      throw new HttpError(400, "cannot_edit_dm");
    }
    if (!channelPermissions(me, existing, store.channels.isMember(existing.id, me.id)).manage) {
      throw new HttpError(403, "channel_management_required");
    }
    if (body.name && body.name !== existing.name && store.channels.byName(body.name)) {
      throw new HttpError(409, "name_taken");
    }
    return mutate((emit) => {
      const channel = store.channels.update(existing.id, body);
      emit({ type: "channel.updated", channel });
      return { channel };
    });
  });

  route(endpoints.joinChannel, async ({ user: me, params }) => {
    const channel = store.channels.get(params.id);
    if (!channel || channel.type !== "public") throw new HttpError(404, "channel_not_found");
    if (channel.archived) throw new HttpError(400, "channel_archived");
    mutate((emit) => {
      if (store.channels.addMember(channel.id, me.id)) {
        emit({ type: "member.joined", channelId: channel.id, userId: me.id });
      }
    });
    return { ok: true };
  });

  route(endpoints.leaveChannel, async ({ user: me, params }) => {
    const channel = requireChannelAccess(store, params.id, me);
    if (channel.type === "dm") throw new HttpError(400, "cannot_leave_dm");
    mutate((emit) => {
      if (store.channels.removeMember(channel.id, me.id)) {
        emit({ type: "member.left", channelId: channel.id, userId: me.id });
        if (channel.type === "group_dm")
          emit({ type: "channel.updated", channel: store.channels.get(channel.id)! });
        if (channel.managerIds?.includes(me.id))
          emit({ type: "channel.updated", channel: store.channels.get(channel.id)! });
      }
    });
    return { ok: true };
  });

  route(endpoints.inviteMember, async ({ user: me, params, body }) => {
    const channel = requireChannelAccess(store, params.id, me);
    const invited = store.people.get(body.userId);
    if (!invited) throw new HttpError(400, "unknown_user");
    if (channel.type === "dm" || channel.type === "group_dm") {
      throw new HttpError(400, "cannot_invite_to_dm");
    }
    if (invited.role === "guest" && channel.type !== "public") throw guestRestricted();
    if (!channelPermissions(me, channel, store.channels.isMember(channel.id, me.id)).invite) {
      throw new HttpError(403, "channel_invite_forbidden");
    }
    mutate((emit) => {
      if (store.channels.inviteMember(channel.id, invited.id)) {
        emit({ type: "member.joined", channelId: channel.id, userId: invited.id });
      }
    });
    return { ok: true };
  });

  route(endpoints.removeChannelMember, async ({ user: me, params }) => {
    const channel = requireChannelAccess(store, params.id, me);
    const target = store.people.get(params.userId);
    if (
      !canRemoveChannelMember(
        me,
        target ?? undefined,
        channel,
        store.channels.isMember(channel.id, me.id),
      )
    ) {
      throw new HttpError(403, "channel_removal_forbidden");
    }
    mutate((emit) => {
      if (store.channels.removeMember(channel.id, params.userId)) {
        store.channels.addRemoval(params.userId, channel, me.id);
        if (channel.managerIds?.includes(params.userId))
          emit({ type: "channel.updated", channel: store.channels.get(channel.id)! });
        emit({ type: "member.left", channelId: channel.id, userId: params.userId });
      }
    });
    return { ok: true };
  });

  route(endpoints.setChannelManager, async ({ user: me, body, params }) => {
    const channel = requireChannelAccess(store, params.id, me);
    const target = store.people.get(params.userId);
    const { manager } = body;
    if (
      !canSetChannelManager(
        me,
        target ?? undefined,
        channel,
        store.channels.isMember(channel.id, me.id),
        manager,
      )
    ) {
      throw new HttpError(403, "channel_manager_assignment_forbidden");
    }
    if (!store.channels.isMember(channel.id, params.userId))
      throw new HttpError(409, "channel_membership_required");
    return mutate((emit) => {
      const changed = store.channels.setChannelManager(channel.id, params.userId, manager);
      const updated = store.channels.get(channel.id)!;
      if (changed) emit({ type: "channel.updated", channel: updated });
      return { channel: updated };
    });
  });

  route(endpoints.channelMembers, async ({ user: me, params }) => {
    requireChannelAccess(store, params.id, me);
    return { memberIds: store.channels.memberIds(params.id) };
  });

  route(endpoints.markRead, async ({ user: me, body, params }) => {
    requireChannelAccess(store, params.id, me);
    const { seq } = body;
    if (!store.channels.isMember(params.id, me.id)) throw new HttpError(404, "channel_not_found");
    const { seq: acknowledged } = store.channels.markRead(params.id, me.id, seq);
    return { ok: true, seq: acknowledged };
  });

  route(endpoints.markUnread, async ({ user: me, body, params }) => {
    requireChannelAccess(store, params.id, me);
    const { seq } = body;
    if (!store.channels.isMember(params.id, me.id)) throw new HttpError(404, "channel_not_found");
    const seqNow = store.channels.markUnread(params.id, me.id, seq);
    if (seqNow === null) throw new HttpError(400, "invalid_unread_target");
    return { ok: true, seq: seqNow };
  });

  route(endpoints.setChannelPrefs, async ({ user: me, body, params }) => {
    const channel = requireChannelAccess(store, params.id, me);
    if (!store.channels.isMember(params.id, me.id)) throw new HttpError(400, "not_a_member");
    // A channel is left rather than closed; only a direct conversation hides.
    if (typeof body.hiddenSeq === "number" && channel.type !== "dm" && channel.type !== "group_dm")
      throw new HttpError(400, "not_direct", "Only a direct conversation can be closed.");
    if (body.sectionId && !store.channels.ownsSection(me.id, body.sectionId))
      throw new HttpError(404, "section_not_found", "That section is not in your sidebar.");
    const prefs = store.channels.setPrefs(params.id, me.id, body);
    if (!prefs) throw new HttpError(404, "channel_not_found");
    return { prefs };
  });

  route(endpoints.setNotifyDefault, async ({ user: me, body }) => {
    const { level } = body;
    store.channels.setNotifyDefault(me.id, level);
    return { level };
  });

  route(endpoints.unreadSummary, async ({ user: me }) => {
    return store.channels.unreadSummary(me.id);
  });

  // ---------- sidebar sections (E8) ----------

  route(endpoints.createSidebarSection, async ({ user: me, body }) => {
    const { name } = body;
    if (store.channels.sections(me.id).length >= SIDEBAR_SECTIONS_MAX)
      throw new HttpError(
        409,
        "too_many_sections",
        `A sidebar keeps at most ${SIDEBAR_SECTIONS_MAX} sections.`,
      );
    const section = store.channels.createSection(me.id, name);
    return { section, sections: store.channels.sections(me.id) };
  });

  route(endpoints.renameSidebarSection, async ({ user: me, body, params }) => {
    const { name } = body;
    if (!store.channels.renameSection(me.id, params.id, name))
      throw new HttpError(404, "section_not_found");
    return { sections: store.channels.sections(me.id) };
  });

  route(endpoints.deleteSidebarSection, async ({ user: me, params }) => {
    const freed = store.transaction(() => store.channels.deleteSection(me.id, params.id));
    if (!freed) throw new HttpError(404, "section_not_found");
    return { sections: store.channels.sections(me.id) };
  });

  route(endpoints.orderSidebarSections, async ({ user: me, body }) => {
    const { ids } = body;
    const ordered = store.transaction(() => store.channels.orderSections(me.id, ids));
    if (!ordered) throw new HttpError(409, "sections_changed", "Your sections changed. Try again.");
    return { sections: store.channels.sections(me.id) };
  });

  route(endpoints.readChannelRemovals, async ({ user: me, body }) => {
    const { ids } = body;
    const read = store.channels.readRemovals(me.id, ids);
    return { ids: read };
  });

  return {
    joinPublicChannels,
    snapshot: (user: User) => ({
      channels: store.channels.visibleTo(user.id),
      memberships: store.channels.memberships(user.id),
      channelLastSeq: store.channels.lastSeqMap(user.id),
      mentionCounts: store.channels.unreadMentionCounts(user.id),
      channelRemovals: store.channels.removals(user.id),
      sidebarSections: store.channels.sections(user.id),
      notifyDefault: store.channels.notifyDefault(user.id),
    }),
  };
}

export type Channels = ReturnType<typeof registerChannels>;
