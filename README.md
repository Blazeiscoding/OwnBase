# Tandem

Your people. Your place. Your server.

Tandem is open-source team chat that you host. Run the server on a VPS, or choose
**Host a workspace on this computer** in the desktop app and serve your team from
your own PC, the way you would open a Minecraft world to LAN. Teammates on the
same Wi-Fi see the workspace in the app's Join screen. Anyone else connects by
`ip:port` or an invite link. Every message, file and account lives in one folder
on the host's machine. Keep backups of that folder.

Tandem is early-stage and independently developed, under the
[MIT license](LICENSE). It is not affiliated with Slack or Salesforce.

- [Deployment and backups](docs/DEPLOYMENT.md)
- [Integration API contract](docs/INTEGRATIONS.md)
- [Project atlas](docs/PROJECT-VISUALIZER.html), an offline, interactive guide to
  the code
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)

The project used to be called SlackOSS. The product and the desktop app are now
named Tandem, and that name has not been trademark-cleared. The `@slackoss/*`
package names, the application ID, the data locations and the Docker volume keep
their old names. `SLACKOSS_*` settings and `slackoss://` links still work. An
existing workspace needs no migration.

## Try it

Each of these gives you a workspace at `http://localhost:8543`. Work from a
clone. The first two need Node 24+, pnpm 10 and one `pnpm install`.

**In a browser.** Build the standalone server and start it:

```sh
pnpm build
node apps/server-cli/dist/slackoss-server.js --data ./demo-data --name "Demo Team"
```

**In the desktop app.** On Windows, run `pnpm build:win`, install
`apps/desktop/release/Tandem Setup 0.1.0.exe`, and choose
**Host a workspace on this computer**. On a Mac, `pnpm build:mac` builds a DMG.
CI does not test the Mac build.

**With Docker.** `docker compose -f docker/docker-compose.yml up -d --build`.

A new workspace is empty. To have a team to look at, run this in another
terminal before anyone signs up:

```sh
node scripts/seed-demo.mjs
```

It adds four people who share the password it prints. They are `maya`, who owns
the workspace, `sam`, `priya` and `alex`. They come with channels, a thread,
reactions, a mention, a pinned checklist, an image, statuses and a direct
message. The script leaves a workspace that already has accounts alone. It takes
another address as its first argument and your own `--password`. Run from another
computer, it also needs the `--claim-code` the server printed. The accounts share
a password, so keep them out of a workspace other people can reach.

Then open `http://localhost:8543`, sign in as `maya`, and try:

- [ ] Reply to Sam's direct message, and find alex's mention of you in **Activity**.
- [ ] In #design, open the thread on Priya's mockup, reply, react, and click the image to see it full size.
- [ ] Find the pinned checklist in #engineering with the pin button in the channel header.
- [ ] Press **Ctrl+K** to jump to a channel or a person, and **Search** for `checklist`.
- [ ] Choose **Send later** beside Send, then find the message under **Scheduled**.
- [ ] Sign in as `sam` in a private window, message each other, and start a **Huddle** from both.
- [ ] Open **Workspace → Invite people** for a link that opens in any browser.
- [ ] As the owner, change someone's role in **Workspace → People**, or add an incoming webhook in **Apps and integrations**.
- [ ] Narrow the window to a phone's width and keep chatting.

## How people join

- **Same network.** The desktop app's Join screen lists every workspace
  advertising on the LAN over mDNS. One click joins.
- **Direct connect.** Type `192.168.1.42:8543` or `chat.yourteam.dev`.
- **Invite link.** `http://host:8543/#/join/<code>` opens the workspace in any
  browser with the invite code filled in. The desktop app has its own form of the
  same link, `tandem://join?host=...&code=...`, and older `slackoss://` links
  still open.
- **No app.** The server serves a full browser client at `http://host:8543/`.

The first account created on a fresh server becomes its owner. The owner and
admins can rename the workspace and choose [who may join](docs/DEPLOYMENT.md#who-may-join)
in **Workspace settings**, including letting people in as
[guests](docs/DEPLOYMENT.md#guests), with a display name and no account.

## Hosting a server

### From the desktop app

On the Join screen, choose **Host a workspace on this computer** and name it.
The same server code runs inside the app, and you can move the workspace folder
to a VPS later without changing it.

To share that workspace outside your network without changing router settings,
install Cloudflare's `cloudflared`, create the owner account, then open
**Manage hosting → Open to all**. Tandem starts a temporary Cloudflare Quick
Tunnel and shows an HTTPS address. Leave **Require an invite link to create an
account** selected, which is the default. Then use **Workspace → Invite people**
to copy a browser invite link, and send it to the people you want to join.

The host opens the tunnel before sending the link. A visitor's click reaches the
tunnel that is already running. It does not start one on the visitor's computer.
Keep Tandem running until everyone is finished. Closing the public link, stopping
hosting, or quitting invalidates the temporary address. See the
[Cloudflare Tunnel setup and commands](docs/DEPLOYMENT.md#temporary-internet-sharing-with-cloudflare-tunnel).

For an address that does not change, put one you already have under **Your own
address** in Manage hosting. A Tailscale Funnel, a reverse proxy, or any tunnel
of your own works, as long as it forwards HTTP and WebSockets to the port shown
there. **Open to all** verifies that the address reaches this workspace and uses
it in new links. Tandem does not start or stop that outside connector, so
**Close public link** does not take the address off the internet. Stop the
Funnel, proxy or tunnel yourself, or stop hosting. Existing invite links keep the
same address, but their codes still expire or run out of uses as usual. See
[Use an address you already have](docs/DEPLOYMENT.md#use-an-address-you-already-have).

If you own a domain on Cloudflare, Tandem can run a remotely managed Cloudflare
connector for you instead. See
[A stable address Tandem runs for you](docs/DEPLOYMENT.md#a-stable-address-tandem-runs-for-you).

### Standalone, on a VPS or a spare machine

```sh
node slackoss-server.js --data ./data --name "My Team" --invite-only
```

`pnpm build` writes that file to `apps/server-cli/dist/`, with the browser client
in a `web` folder beside it. Copy both. The server needs Node 24+ and nothing
else. Every dependency is bundled into the one file, and the database is Node's
built-in SQLite.

The flags you are most likely to want are `--port`, `--host`, `--no-mdns`,
`--web <dir>`, `--invite-only`, `--access-policy`, `--public-url` and
`--allow-private-hooks`. `--access-policy guest_allowed` lets people join with a
display name alone. `--name`, `--invite-only` and `--access-policy` set up a new
workspace; once it has an owner, it keeps its own name and rule, which the owner
and admins change in Workspace settings. `--help` lists the rest, along with the `backup`, `restore`,
`verify-backup` and `recover` commands.

### Docker

```sh
docker compose -f docker/docker-compose.yml up -d
```

Data persists in the `slackoss-data` volume. On the public internet, put Caddy
or another reverse proxy in front for HTTPS. For hosting from home, port-forward
or use Tailscale.

## What works today

- Public and private channels, DMs and group DMs, and threads.
- Reactions, mentions, pins and saved items.
- Typing indicators, presence and unread tracking.
- File and image sharing, with inline previews and a lightbox.
- Drafts kept per conversation, which survive a restart.
- Profiles and statuses, channel topics and member management.
- Notification preferences per channel, with mute, and Do Not Disturb snoozing.
- Invites, LAN discovery, hosting from the desktop app, member administration,
  and a browser client the server serves itself.

### Search and links

Search covers every channel you can see, with modifiers:

```
from:@alice  in:#general  has:link  has:file  type:pdf  after:2026-01-01  before:2026-02-01
```

Free text matches what messages say and the names of files attached to them, so
`budget` finds `Q3 Budget.xlsx`. `type:` asks for one kind of file: `image`,
`video`, `audio`, `pdf`, `document`, `spreadsheet`, `presentation` or `archive`.
Modifiers combine with each other and with free text. They never widen what you
are allowed to see, so naming a channel you are not in returns nothing.

Search hits, pins and saved items open the channel scrolled to that message,
with the surrounding history loaded around it. Every message has a link,
`http://host:8543/#/c/<channel>/m/<message>`. It opens the message in a browser,
waits through signing in if it has to, and opens in place when clicked inside a
message. `tandem://` links open the desktop app directly, so an invite link lands
on the join screen with the code filled in. Older `slackoss://` links open the
same way.

### Scheduled messages

**Send later**, beside Send in the composer, queues a message. The Scheduled
panel lists what is queued, and there you can edit a message, send it now or
cancel it. The queue lives on the server, so a message still goes out if the
sender's app is closed, and one scheduled while the server was down is sent the
next time it starts.

### Huddles

Any channel or DM can start a huddle with live audio, camera video and screen
share. The chat server relays the handshake. Media goes directly between peers,
or through your TURN relay when a direct connection is unavailable. Calls are a
mesh, with one connection per other participant, so they suit small groups.
Larger meetings need an SFU, which Tandem does not have. By default no STUN or
TURN server is configured, and calls connect on the LAN only. See
[Voice and huddles](docs/DEPLOYMENT.md#voice-and-huddles) for STUN and TURN
configuration and the HTTPS requirement for browser microphone access.

Everyone in the call gets a tile, camera or not, in a grid that keeps its shape
and its height as people arrive. A share takes the stage and the other tiles
move to a strip beside it. A green ring marks who is talking. The app tells the
others when you mute, so a quiet person and a muted one do not look the same.

**Voice & video** in account settings picks the microphone, speaker and camera,
and sets noise suppression to Strong, Standard or Off. The first huddle on a
device with more than one microphone or camera asks which to use. Each person in
a call has their own volume control. When a call stays on **Connecting…** for 15
seconds, the huddle bar says so and links to a call log that names the cause.

### Friends

Open **Friends** in the sidebar to find workspace members, send requests, accept
or decline them, and see friends' presence. Profiles also have an **Add friend**
action. A friendship is stored on this server, and only the two people in it can
see it. Accounts and friends are not shared between workspace servers.

### Slack-compatible integrations

Admins create apps under **Apps and integrations**. Each app gets a bot user, a
`xoxb-` token and any number of incoming webhooks. Both speak Slack's shapes, so
most existing integrations work once you change the URL:

```sh
# Incoming webhook: text, Block Kit, or legacy payload=<json> form posts
curl -X POST http://your-server:8543/hooks/<token> \
  -H 'content-type: application/json' \
  -d '{"text":"build 412 is green"}'

# Web API
curl -X POST http://your-server:8543/api/chat.postMessage \
  -H "authorization: Bearer xoxb-..." \
  -H 'content-type: application/json' \
  -d '{"channel":"#general","text":"deploy finished"}'
```

`chat.postMessage` accepts a channel id or `#name`, supports `thread_ts`, and
replies with Slack's `{ok, channel, ts}`, or `{ok:false, error}` on failure.
`auth.test` and `views.open` are there too. The tests run Slack's own Web API
SDK against this server. They cover its form-encoded calls, its error handling,
and the `auth.test` call Bolt makes before it will start.

[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) is the full contract. It lists every
supported method and field, each event and what it becomes, and each place this
server differs from Slack.

The server flattens Block Kit payloads to text instead of rejecting them, so a
message written for Slack still reads sensibly. It draws the buttons in an
`actions` block as buttons.

Apps can also respond to what people do:

- **Slash commands.** Register `/deploy` against a URL. Typing it posts Slack's
  form body, with `command`, `text`, `channel_id`, `user_id`, `response_url` and
  `trigger_id`, and renders the reply. `response_type: "in_channel"` posts to
  everyone, and anything else stays private to whoever typed it. The
  `response_url` accepts late replies for 30 minutes and five uses, so a slow
  job can answer when it finishes. `/shrug` and `/me` are built in.
- **Event subscriptions.** Point a URL at the workspace and matching events
  arrive as `{type: "event_callback", event: {...}}`, with Tandem's own event
  alongside Slack's shape. The URL has to echo a `url_verification` challenge
  before the server accepts it. An app receives events only from channels its
  bot has been added to. It is never sent its own bot's actions, which is the
  loop every chat integration otherwise causes. The server queues each delivery
  with its event, retries in order after failures or restarts, and reports the
  outcome in Apps and integrations. Receivers should deduplicate by `event_id`,
  because a crash after their HTTP success can deliver the same event again.
- **Interactive buttons.** Give the app an interactivity request URL and its
  buttons become live. A press posts Slack's `block_actions` payload, which
  carries the pressed `action_id` and `value`, who pressed it, where, and a
  `response_url`. The server renders the reply. Answering `replace_original`
  rewrites the message the button sits on and takes the buttons with it, which
  is how _Approve_ becomes _Approved, shipping 412_. `delete_original` removes
  the message. Anything else answers privately to whoever pressed, or in the
  channel with `response_type: "in_channel"`.

  The server ignores a button's `url` unless it is `http` or `https`, so a
  message cannot hand someone a `javascript:` link to click.

- **Modals.** A button press or a slash command hands the app a `trigger_id`.
  `views.open` turns that into a form in front of the person who pressed, and
  nobody else. Submitting posts Slack's `view_submission` with
  `view.state.values`, `callback_id` and `private_metadata`. An app can answer
  `response_action: "errors"` to send the person back to a field with a reason.
  A trigger opens one form, expires in three minutes, and belongs to the app it
  was issued to.

  Forms carry plain-text inputs and static selects. The server drops a date
  picker or a multi-select instead of drawing a control that does nothing, and
  it refuses a view left with no fields at all. A form that silently lost half
  its questions is worse than no form.

The server signs everything it sends an app the way Slack does, with
`v0=HMAC-SHA256(v0:timestamp:body)` under the app's signing secret. The
signature goes out as both `x-slack-signature` and `x-slackoss-signature`, so a
verifier written for Slack works unchanged.

### Outbound requests

Slash commands, event subscriptions, buttons and modals all make the server call
an address an admin typed. That server usually sits on the same network as a
router page, a NAS, or a cloud metadata endpoint. So the server checks every
address against the private ranges before connecting, and it runs the check
inside the socket's own DNS lookup. DNS rebinding, where a name resolves public
once and private a moment later, still cannot get through. The server does not
follow redirects, since a redirect is how a vetted host would hand over a
private one.

Bots hosted on the LAN are a reasonable thing to want, so this is a default
rather than a rule. `--allow-private-hooks` turns it off.

## Running the workspace

**People** in the sidebar lists everyone with an account, what they can do, and
when they were last seen. The owner and admins see it. Deactivate someone who
leaves. That revokes their sessions, disconnects the app they have open and
drops it back to the join screen, and stops them signing in again. Their
messages stay where they are, because the rest of the conversation still needs
them. The server holds anything they had queued to send later, so nothing posts
in the name of someone who no longer has access. Reactivating undoes all of it.
Apps are in the same list. Deactivating one silences its token and its webhooks
without deleting the app or losing its configuration.

Roles are deliberately blunt. An admin can promote and remove members. Only the
owner can change another admin, no admin can change the owner's account, and
nobody can change their own role. A workspace cannot be lost to an argument
between two admins, or to a misclick.

## The interface

The layout follows Discord's 2025 desktop app. One app background holds a rail
of workspaces and the channel list with folding categories. The conversation is
an inset pane with a rounded corner. Workspace icons are round, turn to rounded
squares when chosen, and carry Discord's pills. A panel for you floats at the
foot of the sidebar, and people have profile cards. Menus are split by what they
concern, the workspace's name or your own.

There are two graphite themes, Onyx and White, and the app starts on whichever
the device prefers. Chaicode orange is kept for the one primary action in a
view, and red badges mark what names you. The type is Onest and Geist Mono, both
bundled, so a LAN workspace renders the same offline. The icons are drawn line
icons. Motion is quick and respects reduced-motion settings. Controls work from
the keyboard, and a narrow window gets its own navigation.

The live timeline is capped. It follows new messages without growing
indefinitely and, while short, sits on the composer.

## Development

A pnpm monorepo on Node 24+ and pnpm 10:

```sh
pnpm install
pnpm --filter @slackoss/server dev      # workspace server on :8543
pnpm --filter @slackoss/desktop dev     # Electron app
pnpm test                               # unit tests in every package
pnpm typecheck
```

| package                | what it is                                               |
| ---------------------- | -------------------------------------------------------- |
| `packages/protocol`    | Shared types: entities, WS events, REST schemas (zod)    |
| `packages/server`      | Workspace server: Fastify, ws and `node:sqlite`, pure JS |
| `packages/client-core` | Client SDK: REST, resilient WS, local replica (zustand)  |
| `packages/ui`          | React UI shared by desktop and web                       |
| `apps/desktop`         | Electron app (electron-vite, React 19, Tailwind 4)       |
| `apps/web`             | Browser client, served by the server itself              |
| `apps/server-cli`      | Bundles the server into one runnable file                |

The [project atlas](docs/PROJECT-VISUALIZER.html) is one offline HTML file that
covers every tracked file, the architecture and flows, implemented improvements,
measured optimizations and open findings. Download it and open it in a browser,
or run `pnpm visualizer:serve`. The [atlas guide](docs/visualizer/README.md)
says how to regenerate it.

### How sync works

Every mutation appends to a per-workspace event log with a monotonic `seq` and
fans out over WebSocket. Clients keep a local replica and render from it. Sends
are optimistic and reconciled by nonce. On reconnect a client replays everything
after its last `seq`, so one that dropped off Wi-Fi or went to sleep catches up
on what it missed.

File transfers stream through the server. A channel keeps a bounded window of
messages in memory however far back you scroll, and the client evicts idle
attachment blobs. Password derivations run off the main event loop with bounded
concurrency.

### How huddles connect

The offerer creates three media slots, for microphone, camera and screen. The
answerer adopts those slots from the offer. Creating slots independently on both
ends can produce duplicate transceivers and one-way audio in Chromium. Camera
and screen changes reuse the negotiated slots without a new offer. Real-browser
tests check audio packets in both directions and decoded camera frames.

Each peer states what it is sending over the same signalling channel. The
connection cannot say. A receiver's track reports itself unmuted once the
transport is up, whether or not a frame has ever arrived. Measured in Chrome, a
silent slot showed an unmuted track and 0 bytes. Inferring from the track would
show everyone a black rectangle for a camera nobody switched on.

The speaking ring reads the audio level the browser already parses out of each
incoming packet. A Web Audio graph per participant would do the same job, and in
a six-person call you would feel it.

### Installers and tests

```sh
pnpm build:win      # Windows installer
pnpm test:desktop   # drives the packaged app
pnpm build
pnpm test:e2e       # browser scenarios against the built server
```

`pnpm build:win` writes the installer to `apps/desktop/release/`. Local builds
are unsigned unless you configure a signing certificate. The browser scenarios need
`pnpm exec playwright install chromium` once. CI covers the server, the browser
client, Docker and the Windows app. [CI duration and caching](docs/CI.md) has the
build reuse, the installer selection and the measured baseline. The optimized
workflows have not been timed on GitHub.

To regenerate the checked-in desktop icons from the SVG, install Playwright's
Chromium and run `node scripts/generate-icons.mjs`. Normal packaging uses the
checked-in assets and does not need this step.

## Roadmap

- **Next.** The Block Kit inputs still missing: date pickers, multi-selects and
  checkboxes. Then `views.update`, so a form can change as it is filled in.
- **Later.** An SFU for larger huddles, message forwarding, sidebar sections,
  optional Postgres and S3, and SSO.

[Current boundaries](docs/DEPLOYMENT.md#current-boundaries) lists what is missing
today.
