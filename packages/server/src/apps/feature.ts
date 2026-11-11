import type { ServerContext } from "../core/context.js";
import type { registerMessages } from "../messages/feature.js";
import { createAppCalls } from "./calls.js";
import { registerCommands } from "./commands.js";
import { createEventDeliveries } from "./deliveries.js";
import { enqueueAppDeliveries } from "./delivery.js";
import { registerAppManagement } from "./manage.js";
import { registerAppReplies } from "./replies.js";
import { registerSlackApi } from "./slackApi.js";
import { registerViews } from "./views.js";

/**
 * Apps (bots and integrations): what an administrator sets up, what apps call
 * in Slack's shape, the commands, buttons and forms that call them, and the
 * events they are sent.
 */
export function registerApps(
  ctx: ServerContext,
  deps: {
    messages: Pick<
      ReturnType<typeof registerMessages>,
      "posting" | "updateMessage" | "removeMessage"
    >;
  },
) {
  const { posting } = deps.messages;
  const calls = createAppCalls(ctx);
  const deliveries = createEventDeliveries(ctx, calls);
  ctx.onRecorded((envelope) =>
    enqueueAppDeliveries(ctx.store, envelope, (subscriptionId) =>
      ctx.log.warn(
        { subscriptionId, eventSeq: envelope.seq },
        "event subscription backlog full, event dropped",
      ),
    ),
  );
  ctx.onPublished(deliveries.soon);
  ctx.lifecycle.onStart(deliveries.start);
  ctx.lifecycle.hourly(deliveries.hourly);

  registerAppManagement(ctx, { calls, deliveries });
  registerSlackApi(ctx, { posting });
  const { newTrigger } = registerViews(ctx, { calls });
  const replies = registerAppReplies(ctx, {
    calls,
    newTrigger,
    messages: deps.messages,
  });
  registerCommands(ctx, { calls, replies, newTrigger, posting });

  return {
    /** Delivers what is due to apps' event subscriptions; resolves once this round ends. */
    flushEventDeliveries: deliveries.flush,
  };
}
