import { endpoints, type User } from "@ownbase/protocol";
import { requireVisibleMessage, type ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";

/** Polls (E6): voting on a poll and closing it; the poll is posted as a message. */
export function registerPolls(ctx: ServerContext) {
  const { store, route, mutate } = ctx;

  route(endpoints.votePoll, async ({ user: me, body, params }) => {
    const msg = requireVisibleMessage(store, params.id, me);
    const rules = store.polls.rules(msg.id);
    if (!rules) throw new HttpError(404, "poll_not_found", "That message is not a poll.");
    if (store.getChannel(msg.channelId)?.archived) throw new HttpError(400, "channel_archived");
    if (rules.closedAt !== null)
      throw new HttpError(409, "poll_closed", "This poll is closed, so its votes are final.");
    const { choices } = body;
    const chosen = [...new Set(choices)];
    if (chosen.some((c) => c >= rules.options))
      throw new HttpError(400, "bad_choice", "That choice is not in this poll.");
    if (!rules.multiple && chosen.length > 1)
      throw new HttpError(400, "bad_choice", "This poll takes one choice.");
    let message = msg;
    mutate((emit) => {
      if (!store.polls.setChoices(msg.id, me.id, chosen)) return;
      message = store.messages.get(msg.id)!;
      emit({ type: "message.updated", message, pollOnly: true });
    });
    return { message, choices: store.polls.choices(msg.id, me.id) };
  });

  route(endpoints.closePoll, async ({ user: me, params }) => {
    const msg = requireVisibleMessage(store, params.id, me);
    if (!store.polls.rules(msg.id))
      throw new HttpError(404, "poll_not_found", "That message is not a poll.");
    if (msg.userId !== me.id) throw new HttpError(403, "not_your_message");
    let message = msg;
    mutate((emit) => {
      if (!store.polls.close(msg.id)) return;
      message = store.messages.get(msg.id)!;
      emit({ type: "message.updated", message, pollOnly: true });
    });
    return { message };
  });

  return {
    snapshot: (user: User) => ({ pollChoices: store.polls.anonymousChoices(user.id) }),
  };
}
