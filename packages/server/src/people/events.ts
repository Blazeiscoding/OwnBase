import type { User } from "@ownbase/protocol";
import type { DurableRegistry, EphemeralRegistry } from "../events/registry.js";

const slackUser = (user: User) => ({
  id: user.id,
  name: user.handle,
  real_name: user.displayName,
  is_bot: user.isBot,
  deleted: user.deactivated,
});

/** The events of accounts: everyone signed in hears who is here, and how they are. */
export const peopleDurable = {
  "user.joined": {
    channel: () => null,
    app: {
      actor: (event) => event.user.id,
      slack: (event) => ({ type: "team_join", user: slackUser(event.user) }),
    },
  },
  "user.updated": {
    channel: () => null,
    app: {
      actor: (event) => event.user.id,
      slack: (event) => ({ type: "user_change", user: slackUser(event.user) }),
    },
  },
} satisfies Partial<DurableRegistry>;

export const peopleEphemeral = {
  presence: "everyone",
  friends: "person",
  blocks: "person",
} as const satisfies Partial<EphemeralRegistry>;
