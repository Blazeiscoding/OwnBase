# Integration API contract

This is what a Slack-shaped integration can rely on from this server, and where
it differs from Slack. It is deliberately narrower than Slack's platform: the
aim is that the common integrations — a webhook that posts, a bot that answers
a slash command or a button, an app that listens for events — work by changing
the URL they talk to, and that everything else fails with a name rather than
quietly.

The tables marked _checked_ below are read by
`packages/server/test/integrationContract.test.ts`, which fails if they stop
matching the server. Everything else here was confirmed against a running
server when written.

## Setting up an app

An administrator creates an app under **Apps and integrations**. Each app gets:

- a **bot user**, which is who its messages are posted as;
- a **bot token** (`xoxb-…`), shown once and stored only as a hash — **New bot
  token** replaces it;
- a **signing secret**, used to sign every request this server makes to the app
  — **Replace** beside it issues a new one;
- any number of **incoming webhooks**, one per channel, each with a secret URL —
  **New URL** replaces one.

There is no OAuth installation flow. Instead, the administrator chooses the
app's **scopes** when they create it, and can change them on its card at any
time. They use Slack's names, so the scopes an app's own instructions ask for
carry over. Its bot token holds them from its next call. On top of them, the
bot user's reach still applies: private channels and group conversations only
once the bot has been added to them.

- An app made in **Apps and integrations** starts able to post and is sent no
  events, until more is ticked.
- An app made through the API without a `scopes` list, and every app made before
  scopes existed, has all of them, as every app did then.
- Every Web API answer carries the token's scopes in `X-OAuth-Scopes`, as
  Slack's do, and a method the scopes do not reach answers `missing_scope` with
  `needed` and `provided`.
- The methods for forms (`views.*`) and `auth.test` need no scope, as on Slack.
- There are no methods that read, so the reading scopes decide which **events**
  reach the app's subscriptions (see [Events](#events)).

The scopes — _checked_:

| Scope               | Lets the app                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `chat:write`        | Post with `chat.postMessage` where its bot has been added                   |
| `chat:write.public` | Also post in public channels its bot has not been added to                  |
| `channels:history`  | Be sent messages from public channels its bot is in                         |
| `groups:history`    | Be sent messages from private channels its bot is in                        |
| `im:history`        | Be sent messages from direct messages with its bot                          |
| `mpim:history`      | Be sent messages from group conversations its bot is in                     |
| `channels:read`     | Be sent channels made or changed, and members joining or leaving, if public |
| `groups:read`       | The same for private channels its bot is in                                 |
| `reactions:read`    | Be sent reactions added and removed                                         |
| `pins:read`         | Be sent pins added and removed                                              |
| `users:read`        | Be sent people joining the workspace and changing their profiles            |

## Identifiers

Slack's identifiers are replaced by this server's own, and code that looks
inside them will break:

- **`ts` is a message id**, a 26-character ULID such as
  `01M2BW7HJXR0WVPZ72M23ZAD98`. It sorts chronologically as a string, as Slack's
  does, but it is **not a decimal timestamp**. Code that parses `ts` as a number
  or derives a time from it will not work; use `event_time` or the message
  itself. `thread_ts` is the id of the thread's first message.
- **Channel and user ids** are ULIDs too, without Slack's `C…`, `D…` or `U…`
  prefixes.
- **`bot_id` is the app's id.** There is no separate bot identity.
- **`team_id`** is the workspace id, which stays the same across renames,
  address changes and restores from backup.

## Verifying requests from this server

Every request this server makes to an app — slash commands, button presses,
form submissions, event deliveries and URL checks — is signed as Slack signs:

```
basestring = "v0:" + <X-Slack-Request-Timestamp> + ":" + <raw request body>
signature  = "v0=" + hex(HMAC-SHA256(signing secret, basestring))
```

The signature is sent as `X-Slack-Signature` with its timestamp in
`X-Slack-Request-Timestamp`, and repeated as `X-OwnBase-Signature` and
`X-OwnBase-Request-Timestamp`. A verifier written for Slack, including Bolt's,
works unchanged. Verify against the raw body, compare in constant time, and
reject a timestamp more than five minutes from your clock so a captured request
cannot be replayed:

<!-- checked: verify-signature -->

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackRequest(signingSecret, headers, rawBody, now = Date.now()) {
  const timestamp = Number(headers["x-slack-request-timestamp"]);
  const signature = String(headers["x-slack-signature"] ?? "");
  if (!Number.isInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
  const expected =
    "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Every outbound call has **four seconds** to answer (Slack allows three) and a
reply of at most 64 KB. Redirects are not followed. By default the server will
not call a private or loopback address; start it with `--allow-private-hooks`
for an app running on the same network.

## Web API methods

Methods are called at `https://<server>/api/<method>`, as `POST`, with the token
as `Authorization: Bearer xoxb-…` or as a `token` field in the body. A body can
be JSON or form-encoded; in a form, a structured argument such as `blocks` or
`view` is a JSON string, which is how Slack's SDK sends every call.

As on Slack, a call that fails is answered with **HTTP 200** and
`{"ok": false, "error": "<code>"}`. Slack's SDK treats any other status as a
failure to connect and never reads the error code, so this matters more than it
looks. The one exception is rate limiting: **429** with a `Retry-After` header,
which the SDK understands.

The supported methods — _checked_:

| Method             | Arguments honoured                         | Notes                                                                                                |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `auth.test`        | —                                          | Returns `url`, `team`, `user`, `team_id`, `user_id`, `bot_id`. Bolt calls this before it will start. |
| `chat.postMessage` | `channel`, `text`, `blocks`, `thread_ts`   | Returns `ok`, `channel`, `ts`, and this server's own `message` object.                               |
| `views.open`       | `trigger_id`, `view`                       | Returns `ok` and `view` with `id`, `callback_id`, `external_id`, `hash` and the stack's ids.         |
| `views.push`       | `trigger_id`, `view`                       | As `views.open`.                                                                                     |
| `views.update`     | `view_id` or `external_id`, `view`, `hash` | As `views.open`.                                                                                     |

**Any other method** answers `unknown_method`. That includes `chat.update`,
`chat.delete`, `chat.postEphemeral`, `conversations.*`, `users.*`,
`reactions.*`, `files.*`, `views.publish`, and `apps.connections.open` — so **Socket Mode is not supported**; an app receives
events and interactions over HTTP.

### `chat.postMessage`

- `channel` is a channel id or `#name`. **A user id is not accepted**: this does
  not open a direct message, and answers `channel_not_found`.
- It needs `chat:write`. Posting to a **public** channel the bot has not been
  added to also needs `chat:write.public`, as on Slack, and answers
  `not_in_channel` with `"needed": "chat:write.public"` otherwise. A private
  channel or group conversation needs the bot in it, and answers
  `not_in_channel` otherwise.
- `text` wins when both `text` and `blocks` are given, though the buttons in
  `blocks` are still drawn; `blocks` alone are turned into text (see
  [Block Kit](#block-kit)).
- A `thread_ts` that is not the first message of a thread in that channel is
  ignored, and the message is posted to the channel.
- Not honoured: `attachments`, `username`, `icon_emoji`, `icon_url`, `as_user`,
  `reply_broadcast`, `mrkdwn`, `parse`, `link_names`, `unfurl_links`,
  `unfurl_media` and `metadata`.

| Error               | When                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `invalid_auth`      | The token is missing, unknown, replaced, or its app is deactivated |
| `missing_scope`     | The app does not have `chat:write`                                 |
| `channel_not_found` | No such channel, or it is archived                                 |
| `not_in_channel`    | A conversation the bot has not been added to, as above             |
| `no_text`           | Neither `text` nor `blocks` produced anything to post              |

### `views.open`

A `trigger_id` comes with a slash command, a button press or a form submission.
It **lasts three minutes** (Slack's last three seconds, which is unkind to an app
on a cold start), opens one view, and belongs to the app it was issued to and
the person whose action produced it. The view is shown only to that person.

A person has **one stack of forms** open at a time, as the client shows one:
opening a view closes whatever they had open, from this app or another. What a
view can contain is described under [Modals](#modals). A view may hold only
text, with no inputs, such as "Loading" or "Done"; it has no submit button
unless it names one.

`external_id` names a view for `views.update`, and must be unique among the
app's open views. The `hash` in the answer changes every time the view does.

| Error                   | When                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `invalid_auth`          | As for `chat.postMessage`                                           |
| `expired_trigger_id`    | Unknown, used, or older than three minutes — or its room has closed |
| `trigger_not_yours`     | Issued to a different app                                           |
| `unsupported_elements`  | Every input in the view was a kind this server cannot draw          |
| `no_inputs`             | The view has neither inputs nor text                                |
| `duplicate_external_id` | Another of the app's open views has that `external_id`              |

### `views.push`

Puts a view on top of the one the person has open from this app, as on Slack:
closing or submitting it goes back to the one under it. At most **three** views
stack. If the person has no view of this app open, it opens as `views.open`
would. The trigger is spent the same way.

Errors are those of `views.open`, and `push_limit_reached` when three are open.

### `views.update`

Changes a view the person still has open, anywhere in the stack, without a
trigger: the usual way to answer at once with "Loading" and show the real form
when the app has it. Name the view by `view_id` or by `external_id`. An input
that keeps its `block_id` and `action_id` keeps what the person entered in it,
as on Slack.

Pass the `hash` from the last answer to refuse the change if the view has
changed since, so two updates cannot overwrite each other. It also refreshes the
view's thirty minutes. An app that updates views in a loop is limited as a
posting app is, with **429** and `Retry-After`.

| Error                   | When                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `invalid_auth`          | As for `chat.postMessage`                                            |
| `not_found`             | No open view of this app by that id or name — or its room has closed |
| `hash_conflict`         | The view changed after the `hash` was given                          |
| `unsupported_elements`  | As for `views.open`                                                  |
| `no_inputs`             | As for `views.open`                                                  |
| `duplicate_external_id` | Another of the app's open views has that `external_id`               |

## Incoming webhooks

`POST https://<server>/hooks/<secret>` with a JSON body, or a form with a
`payload` field holding the JSON — the older shape many tools still send.

- `text`, `blocks`, or both, with the same rules as `chat.postMessage`.
- Success is **HTTP 200** with the body `ok`, as on Slack.
- The channel is fixed when the webhook is created; a `channel` field is ignored.

| Status | Error               | When                                                       |
| ------ | ------------------- | ---------------------------------------------------------- |
| 404    | `invalid_webhook`   | The secret is unknown, replaced, or its app is deactivated |
| 400    | `invalid_payload`   | The body is not JSON                                       |
| 400    | `no_text`           | Nothing to post                                            |
| 404    | `channel_not_found` | The channel is gone or archived                            |
| 403    | `not_in_channel`    | A private conversation the bot has since left              |

Errors come back as `{"ok": false, "error": "<code>"}` rather than Slack's bare
text.

## Slash commands

An administrator registers a command against a URL. When someone runs it, the
app receives a form-encoded `POST` with `command`, `text`, `team_id`,
`team_domain`, `channel_id`, `channel_name`, `user_id`, `user_name`,
`api_app_id`, `response_url` and `trigger_id`. There is no legacy verification
`token`; check the signature instead.

The app's **immediate answer**, within four seconds:

- an empty body acknowledges the command and shows nothing;
- plain text is shown privately to the person who ran it;
- JSON with `text` or `blocks` is shown privately, or posted to the channel as
  the bot with `"response_type": "in_channel"`.

A command run from inside a thread answers in that thread. If the app answers
with an error status, or not in time, the person who ran it is told privately
that the command failed.

### `response_url`

Accepts a JSON `POST` with the same fields as an immediate answer, **five times
within thirty minutes**, as on Slack. It is spent early if the app is deleted or
deactivated, its bot loses access to the conversation, the conversation is
archived, or the person it answers is deactivated — and then answers **404**
`expired_url`. It is held in memory, so a restart ends it.

## Interactive buttons

An app's buttons call its **interactivity URL**, which an administrator sets in
Apps and integrations. Unlike on Slack, the URL must echo a `url_verification`
challenge (see [Events](#events)) before it is accepted, so this server cannot
be aimed at an unrelated host.

A press posts a form with a `payload` field holding Slack's `block_actions`
payload: `team`, `user`, `api_app_id`, `channel`, `message` (with `ts`, `text`
and `user`), `container`, `trigger_id`, `response_url`, and one entry in
`actions` with `type: "button"`, `action_id`, `block_id`, `text`, `value`,
`style` and `action_ts`.

The answer — immediately or through the `response_url` — is handled like a slash
command's, plus:

- `"replace_original": true` rewrites the message the button was on, and its
  buttons go with it;
- `"delete_original": true` removes that message.

Both work through the `response_url` too, which is where Bolt's `respond()`
sends them after acknowledging the press.

A button with an `http(s)` `url` opens the link in the person's browser and calls
nothing. Only buttons are drawn from an `actions` block.

## Modals

A view is Slack's `modal` reduced to what this server can draw:

- `title`, `submit`, `close`, `callback_id` and `private_metadata`;
- `input` blocks, with `label`, `hint` and `optional`, each holding one of the
  elements below;
- `header`, `section`, `context` and `divider` blocks, shown as text above the
  inputs.

The input elements — _checked_:

| Element                      | Honoured                                                                                   | Answer in `state.values`      |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- |
| `plain_text_input`           | `multiline`, `placeholder`, `initial_value`                                                | `value`                       |
| `static_select`              | `options` or `option_groups`, `placeholder`, `initial_option`                              | `selected_option`             |
| `multi_static_select`        | As above, with `initial_options` and `max_selected_items`                                  | `selected_options`            |
| `checkboxes`                 | `options` with `description`, `initial_options`                                            | `selected_options`            |
| `radio_buttons`              | `options` with `description`, `initial_option`                                             | `selected_option`             |
| `users_select`               | `placeholder`, `initial_user`                                                              | `selected_user`               |
| `multi_users_select`         | `placeholder`, `initial_users`, `max_selected_items`                                       | `selected_users`              |
| `conversations_select`       | `placeholder`, `initial_conversation`, `default_to_current_conversation`, `filter.include` | `selected_conversation`       |
| `multi_conversations_select` | As above, with `initial_conversations` and `max_selected_items`                            | `selected_conversations`      |
| `channels_select`            | `placeholder`, `initial_channel`                                                           | `selected_channel`            |
| `multi_channels_select`      | `placeholder`, `initial_channels`, `max_selected_items`                                    | `selected_channels`           |
| `datepicker`                 | `placeholder`, `initial_date`                                                              | `selected_date`, `YYYY-MM-DD` |
| `timepicker`                 | `initial_time`                                                                             | `selected_time`, `HH:mm`      |

- A select takes up to 100 options, and checkboxes and radio buttons up to 10,
  as on Slack. Option groups are run together into one list. A choice left
  with no usable options is dropped.
- The people pickers offer everyone with an active account except bots. The
  conversation pickers offer what the person filling in the form can open,
  limited by `filter.include` (`public`, `private`, `im`, `mpim`). The channel
  pickers offer public channels. Archived conversations are never offered.
- `default_to_current_conversation` starts a conversation picker on the
  conversation where the slash command was run or the button pressed.
- A starting value the person cannot see is left out rather than sent unseen.
- Not honoured: `exclude_bot_users` and `exclude_external_shared_channels` in a
  filter, `min_length` and `max_length` on text, `timezone` on a time picker,
  `focus_on_load`, `dispatch_action` and `response_url_enabled`.

An input of any other kind, such as `datetimepicker`, `number_input`,
`email_text_input`, `file_input` or `external_select`, is **dropped** rather than
drawn as a control that does nothing. At most 25 inputs are kept.

Submitting posts a form with a `payload` field holding Slack's `view_submission`:
`team`, `user`, `api_app_id`, a fresh `trigger_id`, and `view` with `id`,
`callback_id`, `private_metadata`, `title` and `state.values`. Each value names
its element as `type` and holds its answer under the key in the table, as Slack
sends it: a chosen option is `{"text": {"type": "plain_text", "text": "…"},
"value": "…"}`, with a `description` if it had one, and people and
conversations are ids. An optional input left empty answers `""` for text,
`null` for one choice and `[]` for several.

Before anything reaches the app, the server refuses a submission that leaves a
required input empty, or chooses something the input never offered: an option
it did not list, more than `max_selected_items`, an account that is not active,
a conversation the person cannot open or the filter leaves out, a channel that
is not public, or a date or time that does not exist. So an app never has to
defend against a form its own view forbids.

The app's answer:

- anything that is not an error or one of the actions below closes the view,
  including an empty body, and shows the one under it if there is one;
- `{"response_action": "errors", "errors": {"<block_id>": "<message>"}}` keeps it
  open with each message shown against its input;
- `{"response_action": "update", "view": {…}}` changes the view, as
  `views.update` would;
- `{"response_action": "push", "view": {…}}` stacks a view on it, as
  `views.push` would;
- `{"response_action": "clear"}` closes every view in the stack;
- an answer that starts like JSON but cannot be read keeps it open, and the
  person is told the app's answer could not be read, as does an `update` or
  `push` whose view cannot be shown or would be a fourth;
- an error status, or no answer within four seconds, keeps it open and says so.

Only the view on top can be submitted. Its `view` in the payload also carries
`hash`, `external_id`, `root_view_id` and `previous_view_id` (null for the
first). The close button of a stacked view goes back to the one under it; the
dialog's own close and Escape close them all. Closing tells the app nothing:
`notify_on_close` and `view_closed` are not supported. A view is open for
thirty minutes, and is closed without reaching the app if its conversation or
app goes away in that time.

## Events

An app subscribes a URL to events in Apps and integrations. The URL must first
answer a `url_verification` request — `{"type": "url_verification", "token": "",
"challenge": "…"}` — by echoing the `challenge`, either as the whole body or as
`{"challenge": "…"}`.

Each event then arrives as:

```json
{
  "type": "event_callback",
  "event_id": "Ev1234",
  "event_time": 1789291228,
  "team_id": "01M2D12P7QFB85N50CZ4MHTV46",
  "event": { "type": "message", "channel": "…", "user": "…", "text": "…", "ts": "…" },
  "ownbase": { "type": "message.created", "seq": 1234 }
}
```

`ownbase` carries this server's own event name and its position in the
workspace's event log. There is no `api_app_id`, `authorizations`,
`event_context` or verification `token`.

What is delivered:

- events from **channels the bot has been added to**, and workspace-wide events
  such as a new member;
- **never** an event caused by the app's own bot, which is how a bot that answers
  messages ends up answering itself forever;
- only the event types the subscription names, using the native names in the
  table below, or every type if it names none;
- only what the app's scopes let it read, as the table's last column says. A
  message from a private channel needs `groups:history` where one from a public
  channel needs `channels:history`. Apps and integrations names the scopes a
  subscription's events are waiting on. Events already queued when a scope is
  taken away are still sent.

How it is delivered:

- **at least once.** A crash after the app answered but before the delivery was
  recorded sends it again with the same `event_id`, so deduplicate on it;
- **in order** for each subscription, and in parallel across subscriptions;
- a `2xx` answer within four seconds is a delivery. Anything else is retried
  after 5 seconds, 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1 hour and
  6 hours — eight attempts in all — with `X-Slack-Retry-Num` and
  `X-Slack-Retry-Reason: http_error` on each retry;
- at most **500** events wait for one subscription. Past that, new events are
  counted as dropped and shown beside the subscription;
- an endpoint that uses up its attempts has the rest of its queue given up with
  it. An administrator can retry the whole queue, in order, from Apps and
  integrations. Given-up events nobody asks to retry are kept for seven days;
  a retry that has been asked for is kept until it is sent, however long the
  queue stays full, or until the endpoint fails again, which starts its seven
  days afresh;
- a retry is a replay of history. Its events go out oldest first among
  themselves, each taking a place in the queue as one frees up, but events
  already waiting when the retry was asked for are not held back for it. So a
  replayed event can arrive after newer ones: order by `ownbase.seq` (or
  `event_id`) if your app needs the original order.

What an edit or a deletion does to an event not yet delivered: a message's
words are taken out of every event about it that is still waiting, or that
gave up, in the same write that edits or deletes it, and the same happens when
the retention window discards it. The events themselves stay, in order and with
their `event_id`: an app that is behind receives the `message` with an empty
`text` (or a `message_changed` whose `message.text` is empty), then the edit or
deletion that supersedes it, as a client catching up on the event log does.
Only the words are taken out; who wrote it, where and when stay. An event
already delivered belongs to the app and cannot be called back, and one that was
on its way out at that moment may still arrive as it was.

The events — _checked_:

| Native event       | Slack `event.type`      | Differences                                                        | Scope                                                              |
| ------------------ | ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `message.created`  | `message`               | `thread_ts` present for a reply                                    | `channels:history`, `groups:history`, `im:history`, `mpim:history` |
| `message.updated`  | `message`               | `subtype: "message_changed"`, with the new `message`               | `channels:history`, `groups:history`, `im:history`, `mpim:history` |
| `message.deleted`  | `message`               | `subtype: "message_deleted"`, with `deleted_ts`                    | `channels:history`, `groups:history`, `im:history`, `mpim:history` |
| `reaction.added`   | `reaction_added`        | `reaction` is the emoji itself, not its name                       | `reactions:read`                                                   |
| `reaction.removed` | `reaction_removed`      | As above                                                           | `reactions:read`                                                   |
| `pin.added`        | `pin_added`             | —                                                                  | `pins:read`                                                        |
| `pin.removed`      | `pin_removed`           | No `user`                                                          | `pins:read`                                                        |
| `channel.created`  | `channel_created`       | —                                                                  | `channels:read`, `groups:read`                                     |
| `channel.updated`  | `channel_rename`        | Sent for any change to a channel, not only its name                | `channels:read`, `groups:read`                                     |
| `member.joined`    | `member_joined_channel` | —                                                                  | `channels:read`, `groups:read`                                     |
| `member.left`      | `member_left_channel`   | —                                                                  | `channels:read`, `groups:read`                                     |
| `user.joined`      | `team_join`             | `user` carries `id`, `name`, `real_name`, `is_bot`, `deleted` only | `users:read`                                                       |
| `user.updated`     | `user_change`           | As above                                                           | `users:read`                                                       |

## Block Kit

Blocks are **flattened to text** rather than rendered, so a message written for
Slack still reads sensibly:

- `header` becomes bold text;
- `section` contributes its `text` and each of its `fields`;
- `context` contributes its text elements, joined; images are dropped;
- `divider` becomes a line;
- `actions` contributes **buttons** — up to 25, with text up to 75 characters and
  `value` up to 2,000 — and nothing else; selects, date pickers and overflow
  menus are dropped;
- anything else, such as `image` or `rich_text`, is dropped.

Message text is a subset of Slack's mrkdwn. Drawn as formatting: `*bold*`,
`_italic_`, `~strike~`, `` `code` ``, ` ``` ` code blocks, bare `http(s)` links,
`<@user id>` and `<#channel id>` mentions, and `<!here>`, `<!channel>` and
`<!everyone>`. A backslash before a formatting character shows it literally.
**Not interpreted:** Slack's `<https://…|label>` links (the label is not shown
as link text), `>` quotes and list markers, which appear as the characters typed,
and date formatting such as `<!date^…>`.

## The native client protocol

The first-party clients use a WebSocket at `/ws` and the REST routes under
`/api/`. They are not a stable public API — they change with the clients, and
are versioned by `PROTOCOL_VERSION` in `packages/protocol` — but an outline:

1. The client opens the socket and, within 10 seconds, sends
   `{"type": "hello", "token": "<session token>", "lastSeq": <number | null>, "protocolVersion": <n>}`.
2. The server answers `ready` with a snapshot of what the account can see and
   the current event sequence number.
3. If `lastSeq` was given, the events since then that the account may see follow
   as `event` frames — with gaps, since events it may not see are skipped — and
   then `synced`. If the log no longer reaches back that far, `resync` tells the
   client to discard what it has and reconnect with `lastSeq: null`.
4. From then on: `event` for durable changes, `ephemeral` for typing, presence
   and similar, and `pong` for the client's `ping`.

The server closes the socket with **4000** for a malformed frame, **4002** for a
protocol version it does not speak, **4003** for a session that is unknown,
expired, signed out or revoked, and **4004** for an account that must choose a
new password before it can continue.
