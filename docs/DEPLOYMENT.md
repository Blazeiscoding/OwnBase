# Hosting SlackOSS

## Windows and LAN

Build an installer with `pnpm build:win`.
The output is `apps/desktop/release/Tandem Setup 0.1.0.exe`. Local builds are
unsigned unless you supply a signing certificate; Windows may show SmartScreen.
A published release carries the installer, the server bundle and `SHA256SUMS`;
check a download with `Get-FileHash -Algorithm SHA256 <file>` against that list.
Its notes name the commit it was built and tested from, which Diagnostics in the
app and `/api/server-info` on a server also report. Release installers are not
code-signed yet.

Install, choose **Host a workspace on this computer**, name it, and create the
owner account. Allow incoming TCP on the displayed port through the host firewall.
Other desktop users can discover the workspace on the same LAN or connect using
`192.168.1.42:8543`. Browsers can use the same address for chat.

The host computer must stay running and awake. For temporary internet sharing,
use **Open to all** and Cloudflare Tunnel as described below. A VPN such as
Tailscale, a VPS, or a public IP with port forwarding are alternatives. An IP
address alone does not bypass NAT, CGNAT, or firewalls. LAN discovery does not
cross routers.

Each hosted workspace has its own folder under the app's user-data folder, in
`hosted/w-<random id>/`. The folder is fixed when the workspace is created and
does not follow its name, so two workspaces may share a name and renaming one
moves nothing; folders made by earlier versions, named after the workspace, are
adopted as they are. **Manage hosting** shows the running workspace's data folder.
Advanced deployments can set `TANDEM_USER_DATA_DIR` (`SLACKOSS_USER_DATA_DIR`
still works) to choose the desktop profile location.

### Closing the window, and quitting

While a workspace is hosted, or starting or stopping, closing Tandem's window
does not stop it. The window goes to the system tray, whose icon offers **Open
Tandem**, what is hosted and on which port, **Stop hosting** and **Stop
hosting and quit**. Neither asks first, since each already says that hosting
stops. Launching Tandem again, or opening a `tandem://`
(or older `slackoss://`) link,
also brings the window back. On a desktop with no tray, closing minimizes the
window instead. With nothing hosted, closing the last window quits on Windows and
Linux; macOS keeps the app in the dock as usual.

A bar under a workspace you are hosting says so and offers **Manage hosting**: the
workspace's name, the addresses teammates connect to, its port and its data
folder. Its **Stop hosting** stops at once, as the tray's does, and disconnects
everyone connected. Quitting while hosting other than from the tray asks first.
Messages, files and accounts stay on disk. Quitting
waits for a start already under way, and for the server to finish what it is
doing. If stopping fails, Tandem stays open and says so. If it fails while
quitting, you can keep Tandem open or quit anyway; quitting anyway ends at
once and may lose changes still being written, but never deletes workspace data.

If the last-used hosting settings cannot be saved, the workspace keeps running and
Manage hosting shows a warning.

### Reopening, renaming and starting with the computer

Every workspace hosted on this computer is listed under **Hosted on this
computer** in the host dialog, where each can be started again with its messages,
renamed, given a different port or backed up. The join screen offers the most
recently hosted one back with one click. Use the list to reopen a workspace:
creating a new one under the same name starts a separate, empty workspace, and
the dialog says so. The workspace's owner and administrators can also rename it
from **Workspace settings** while it runs, and the list takes the new name.

While a workspace is running, **When this computer starts** offers two choices:
**Start hosting it when Tandem opens**, and, where the system supports it,
**Open Tandem when you sign in to this computer**. With both on, the workspace
is back for teammates once the computer restarts and someone signs in, and
Tandem waits in the tray. Only one workspace can be chosen. Starting this way
hosts on the network; a temporary **Open to all** link is never reopened by
itself, since its address changes every time. When a stable address is set up (see
below), a third choice appears: **Also reopen it when the workspace starts with
Tandem**. It is kept for that workspace and that address only. After starting,
Tandem opens the address the usual way, checking that it reaches this
workspace, and new accounts need an invite. If the address has changed, cannot be
reached or fails the check, the workspace keeps running on the network and the
reason is shown the next time the window is opened. A restored workspace still held
from a backup is never started this way. If the chosen workspace cannot
start, the reason is shown the next time the window is opened.

A port you chose for a workspace, when creating it or with Change port, is kept:
if another program holds it, the workspace does not start and says so, rather
than moving to another port. A workspace left on the usual port moves to a free
one and Manage hosting says where.

While nothing is running, the same section appears above the list whenever a
workspace is chosen to start, a start failed, or Tandem opens at sign-in, so
a workspace that cannot start can be taken off starting with Tandem, and
Tandem off sign-in, without starting it first or removing it from the list.

Current limit: opening at sign-in has not been tried on an installed macOS system.
If macOS holds the registration for approval, the dialog says to allow Tandem
under Login Items in System Settings.

### Backing up from the desktop

**Back up now** copies a hosted workspace into a new folder you choose, and
**Automatic backups** does the same every day or week into one folder, keeping
the newest few. A copy is kept only if it holds the same workspace as the one
listed, retention never removes the copy it has just made, and an older copy
counts toward the number kept only after it passes the same check as
`verify-backup`. A failed automatic copy keeps its error across restarts and waits
one hour before retrying; repeated failures double that delay up to 24 hours.
**Back up now** can make an immediate copy, and choosing an automatic backup
folder explicitly resets the delay. **Try the backup again** in the tray or
hosting window also retries immediately. Failed captures never trigger removal of
older verified backups.

**Restore from a backup…** checks a backup, then restores it as a hosted
workspace without starting it; it will not restore over a workspace already
hosted here. A restored workspace is held until you put it back in use, and the
hold survives restarting Tandem. While held, it is listed as "Restored, not
in use yet", is taken off starting with Tandem, and **Look inside** starts
it on this computer only: nothing it had queued is sent, no app is called, it is
not announced on the network and it cannot be opened to all. After restoring,
the dialog says what the backup would bring back: sign-ins it still accepts,
scheduled messages waiting, app events not yet delivered and the apps it calls.
**Put back in use…** asks first, then starts it as the workspace itself, which
clears the hold for good.

Only Windows has been checked. The packaged tests close the window while hosting,
read the tray menu, stop hosting from the tray and from Manage hosting, quit from
the tray, and quit with nothing hosted; the system's own
quit confirmation is answered by the test, never shown. Whether a
tray appears on Linux depends on the desktop environment, and macOS has not been
run.

## Temporary internet sharing with Cloudflare Tunnel

Tandem's **Open to all** button creates a
[Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
from a random `https://…trycloudflare.com` address to the workspace on this
computer. It needs no Cloudflare account, domain, inbound firewall rule, port
forward, or public IP. `cloudflared` makes an outbound connection to Cloudflare;
friends use the public address while that connector is already running.

### Install cloudflared

Use Cloudflare's [official downloads](https://developers.cloudflare.com/tunnel/downloads/),
then check the installed version. On Windows, run these commands in PowerShell:

```powershell
$msi = Join-Path $env:TEMP "cloudflared-windows-amd64.msi"
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi" -OutFile $msi
Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList @("/i", "`"$msi`"")
```

Open a new PowerShell window and verify the installation:

```powershell
cloudflared --version
```

On macOS with Homebrew:

```sh
brew install cloudflared
cloudflared --version
```

On Debian, Ubuntu, or another Debian-based distribution, use
[Cloudflare's package repository](https://pkg.cloudflare.com/):

```sh
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
cloudflared --version
```

If `cloudflared` is elsewhere, set `TANDEM_CLOUDFLARED` to its full path
before starting Tandem. The previous `SLACKOSS_CLOUDFLARED` name also works.

### Open and share the desktop workspace

1. In Tandem, choose **Host a workspace on this computer**, open it, and
   create its owner account while it is still local.
2. Open **Manage hosting** and select **Open to all**. Leave **Require an invite
   link to create an account** selected unless everyone who learns the public
   address should be able to create an account.
3. Wait for Tandem to show the `https://…trycloudflare.com` address. The app
   starts and monitors `cloudflared`; a Cloudflare account is not required.
4. Open **Workspace → Invite people**, generate an invite, then choose **Copy
   link** under **Browser link**. Send that complete link to a friend. It opens
   the browser client with the invite code filled in; the friend does not
   install `cloudflared`.
5. Keep the host computer awake and keep Tandem running. **Close public
   link**, **Stop hosting**, or quitting Tandem ends the connector and makes
   that address unusable. Opening it again creates a different address, so send
   a new invite link.

The public HTTPS address carries the browser client, API requests, and
WebSockets used for chat. Opening the invite link on another computer sends the
request to Cloudflare's edge, which forwards it through the tunnel that the host
already opened. A click cannot open a tunnel on a host that is offline.
While that connector is active, the embedded server accepts Cloudflare's
visitor-address header only from a loopback peer so its unauthenticated limits
remain separate per visitor. It stops trusting that header as soon as the public
link closes; LAN and other network peers cannot supply it.

**Open to all** adds Cloudflare's STUN service for peer-to-peer huddles. That is
enough for most networks, but some, such as mobile data and strict office
networks, will not let two people reach each other directly: chat works while
their call stays on **Connecting…**. Calls between them need a TURN relay. Add
one in **Manage hosting**, under **Calls from other networks**:

- **Cloudflare**: a TURN key's ID and API token, from the Realtime section of the
  Cloudflare dashboard. The token stays on the host computer, encrypted by the
  operating system; each call is given a password from Cloudflare that lasts a
  day.
- **Another TURN server**: its `turn:` or `turns:` addresses, username and
  password. Everyone in a call is given that username and password.

**Test** checks that the relay gives this computer a route before anyone
depends on it. A change reaches calls that start afterwards; a call stuck on
**Connecting…** picks it up when it retries. If Cloudflare later refuses the key,
the card says so.

### Use an address you already have

A Quick Tunnel gives a different address every time it opens, so every invite
link has to be sent again. If something already carries a public HTTPS address
to this computer, give that address to Tandem instead and **Open to all**
verifies and uses the same one every time.

Open **Manage hosting**, put the address under **Your own address**, and save.
Tandem starts no connector in this mode. It checks that the address reaches
this workspace, publishes it into browser, invite and message links, and keeps
checking while the link is open. Tandem itself needs no domain or Cloudflare
account for this mode, although the outside service you choose can have its own
account or domain requirements.

The outside service remains in charge of public access. **Close public link**
stops Tandem from monitoring and putting the address into new links, but it
cannot stop a Funnel, proxy, or tunnel that Tandem did not start. As long as
that service and the hosted workspace are running, the address remains
reachable. Stop the outside service, or stop hosting, when the workspace must no
longer be public. An old invite link keeps the stable base address, but its code
can still expire or reach its use limit.

The carrier must forward every HTTP path and WebSocket upgrade to
`http://127.0.0.1:<port>`; forwarding only the home page is not enough for the
API or live chat. A Tailscale Funnel, a WebSocket-capable reverse proxy, a VPS
with a reverse tunnel, or another tunnel can do this. Use the actual port
**Manage hosting** shows for the workspace; it can differ from 8543 when that
port was already occupied.

Holding a port is not the same as owning it. On Windows a program already
listening on `127.0.0.1:8543` does not stop Tandem binding `0.0.0.0:8543`,
and loopback requests then go to that program rather than the workspace, so a
carrier forwarding there reaches the wrong thing. Tandem checks this when
hosting starts and says so in **Manage hosting**; stop the other program and
start hosting again, or host on a different port. **Open to all** refuses
either way, because the address has to answer as this workspace before it is
published.

#### With Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) gives a
stable HTTPS name with a real certificate and no domain to buy. It is available
on every Tailscale plan; Tailscale's Personal plan is free but is for
non-commercial use, and caps how many people share a tailnet. That cap counts
Tailscale accounts, not workspace members: a Funnel is open to the internet, so
teammates join Tandem through the address in a browser and need no Tailscale
account at all. Funnel is currently beta and has non-configurable bandwidth
limits. It also needs
MagicDNS, HTTPS certificates, and the Funnel node attribute in the tailnet
policy. The first command can open Tailscale's approval page to enable those
settings; the person approving it needs the appropriate tailnet role.

Install Tailscale and sign in. On Windows, open PowerShell as Administrator and
run the command with the port shown by Tandem (8543 is only the usual
value):

```powershell
$port = 8543
tailscale funnel $port
```

That form runs in the foreground. Keep the PowerShell window open while people
use the workspace, and press Ctrl+C to stop the Funnel. To let Tailscale keep it
running in the background instead, use:

```powershell
tailscale funnel --bg $port
```

Stop all Funnel routes on that computer when sharing is finished:

```powershell
tailscale funnel reset
```

On Linux, use the same commands through `sudo` unless that user was configured
as Tailscale's operator:

```sh
port=8543
sudo tailscale funnel "$port"
# Or keep it in the background:
sudo tailscale funnel --bg "$port"
# Later, remove the public Funnel configuration:
sudo tailscale funnel reset
```

Funnel prints a name like `https://box.tail1234.ts.net`; paste it into **Your own
address**. The public HTTPS listener can use only port 443 (the default), 8443,
or 10000. The `8543` above is the local Tandem target, not the public
listener. On macOS, forwarding a port needs one of the GUI builds — Tailscale
documents the Standalone system extension for this, and the open-source
`tailscaled` build is what its file-sharing rule is about, not ports. Check
[which macOS variant you have](https://tailscale.com/docs/concepts/macos-variants)
if `tailscale funnel` refuses the port.

Tandem does not sign in to Tailscale or change the tailnet policy. Those
steps belong to Tailscale's own client and approval page, and the Windows command
needs Administrator rights. Tandem takes only the finished public address;
it never receives Tailscale account credentials.

#### Setting it outside the app

`TANDEM_PUBLIC_URL` sets the same address from the environment, for a
service or a scripted install. `SLACKOSS_PUBLIC_URL` works too. An address set
that way is shown in **Manage hosting** but cannot be edited there, since the
app does not own it. A saved address takes precedence over both, so an old
variable in a shell cannot quietly replace one somebody typed into the app.

The address has to be a public HTTPS origin, the same rule described below. If
it stops answering as this workspace, Tandem gives it up after several
checks in a row fail, removes it from new links, and says so in **Manage
hosting**. A brief network blip does not invalidate the links you have sent.
This does not shut down the outside carrier; use its own stop command when the
address itself must stop accepting connections.

### A stable address Tandem runs for you

If you own a domain on Cloudflare, Tandem can run the connector itself
rather than leaving it to you. Open to all then starts and stops a Cloudflare
named tunnel with the workspace, at an address that does not change. This needs
a domain; the section above needs none.

Create a **remotely managed** tunnel in Cloudflare's
[Tunnels dashboard](https://one.dash.cloudflare.com/), then add a Published
application route whose hostname is your public address and whose service URL is
`http://127.0.0.1:8543`, replacing 8543 with the port **Manage hosting** shows.
Do not use `cloudflared tunnel create` for this flow: that command creates a
locally managed tunnel with a credentials JSON file, while Tandem's
`--token-file` flow requires a remotely managed tunnel.

In the tunnel's dashboard page, choose **Add a replica** and copy the connector
token (the `eyJ…` value in Cloudflare's installation command) into a file
readable only by your account. Tandem never reads its contents; it passes
the path to [`cloudflared --token-file`](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file).
That option requires `cloudflared` 2025.4.0 or later, so check
`cloudflared --version` and update it first when needed.

Environment variables belong to the process that starts Tandem. On Windows,
set both in PowerShell and launch the installed app from that same window so it
inherits them:

```powershell
$env:TANDEM_TUNNEL_URL = "https://chat.example.org"
$env:TANDEM_TUNNEL_TOKEN_FILE = "C:\Users\sam\.cloudflared\chat-token.txt"
Start-Process "$env:LOCALAPPDATA\Programs\Tandem\Tandem.exe"
```

If Tandem was installed elsewhere, replace the last path with the path to
its `Tandem.exe`. To launch it later from the Start menu, save the two values
as user environment variables first, then sign out and back in so newly launched
apps inherit them. The token itself stays in the protected file; the environment
contains only its path.

On Linux, export the values and run the AppImage from that same shell:

```sh
export TANDEM_TUNNEL_URL=https://chat.example.org
export TANDEM_TUNNEL_TOKEN_FILE=/home/sam/.cloudflared/chat-token
./Tandem-0.1.0.AppImage
```

The same inheritance rule applies on macOS: a GUI app opened from Finder or the
Dock does not inherit variables exported in an unrelated terminal. Start its
executable from the configured shell or provide the values through the service
or launcher that owns the app process. macOS and Linux packages have not yet
been validated for this project.

`TANDEM_TUNNEL_URL` has to be a public HTTPS origin: a hostname with a dot,
and no path, query, credentials, or fragment. Loopback and private-network
suffixes (`.local`, `.internal`, `.home`, `.lan`, `localhost`) and bare IP
addresses are refused, and so is a trailing dot. An accented hostname is
accepted and stored in its punycode form. A non-standard HTTPS port is allowed,
for the alternate ports Cloudflare proxies. `SLACKOSS_TUNNEL_URL` and
`SLACKOSS_TUNNEL_TOKEN_FILE` work as well. Setting only one of the pair, naming
a token file that is not there, or giving an address that cannot be published
is reported in **Manage hosting** and leaves **Open to all** unavailable, rather
than quietly opening a temporary address nobody was given. Environment variables
are read when the app launches, so fully quit and restart Tandem from the
correct environment after changing them. After installing `cloudflared` or
creating a missing token file, reopen **Manage hosting** (or use **Check again**
when shown) to refresh the status.

**Open to all** then starts the saved connector and waits until the configured
address reaches _this_ running workspace before publishing it. If the address
answers as something else — another workspace, or a route left pointing
somewhere old — opening fails and says which Cloudflare route to correct. What
the connector prints is kept out of Tandem's messages and logs, because it
can quote the token it was given.

Closing the public link or quitting stops the connector, and the address stops
working until it is opened again. Unlike a Quick Tunnel, the address itself
survives, so invite links already sent keep working the next time you open it.

### Run a Quick Tunnel with the standalone server

Build the server first, start it only on the local interface, and create the
owner account before exposing it:

```sh
pnpm install
pnpm build
node apps/server-cli/dist/slackoss-server.js --data ./data --name "My Team" --host 127.0.0.1 --invite-only
```

Open `http://127.0.0.1:8543`, create the owner, then stop the server with
Ctrl+C. In one terminal, start a Quick Tunnel and keep it running:

```sh
cloudflared tunnel --url http://127.0.0.1:8543
```

Copy the `https://…trycloudflare.com` address it prints. In a second terminal,
set the STUN configuration and restart the same data directory with that exact
address. On macOS or Linux:

```sh
export TANDEM_ICE_SERVERS='[{"urls":"stun:stun.cloudflare.com:3478"}]'
node apps/server-cli/dist/slackoss-server.js --data ./data --name "My Team" --host 127.0.0.1 --invite-only --public-url https://YOUR-RANDOM-NAME.trycloudflare.com
```

Or in PowerShell:

```powershell
$env:TANDEM_ICE_SERVERS='[{"urls":"stun:stun.cloudflare.com:3478"}]'
node apps/server-cli/dist/slackoss-server.js --data ./data --name "My Team" --host 127.0.0.1 --invite-only --public-url https://YOUR-RANDOM-NAME.trycloudflare.com
```

Sign in through the public address, open **Workspace → Invite people**, and send
the copied browser invite link. Stop the server and `cloudflared` with Ctrl+C
when finished. The STUN setting is optional for chat; it has the same no-TURN
limitation described above.

### Quick Tunnel limits

Cloudflare describes Quick Tunnels as a testing and development feature. They
have no SLA, give a random address for the life of the process, and are limited
to 200 concurrent in-flight requests. WebSockets work, which is what Tandem
chat uses, but Server-Sent Events do not. See Cloudflare's
[Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
and [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)
for the current limits. Use a named tunnel, your own domain, and a supervised
server process for a stable deployment; Cloudflare documents that flow under
[Create a locally-managed tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/).

Cloudflare also says Quick Tunnels are unsupported while a
`.cloudflared/config.yaml` file is present. If `cloudflared` refuses to create
the temporary link for that reason, temporarily move that file aside, retry,
and restore it before using its named-tunnel configuration again.

## Docker and VPS

Run `docker compose -f docker/docker-compose.yml up -d --build` from the repo.
Data lives in a named volume at `/data`; the server runs as a non-root user.
The compose file's `--name` and `--invite-only` set up a new workspace; once it
has an owner, its name and who may join are changed in **Workspace settings**,
and a restart keeps them (see [Who may join](#who-may-join)).
`GET /api/health` checks the process and database. Docker's health status reports
failures; the restart policy restarts exited processes, not merely unhealthy ones.

`GET /api/admin/status`, signed in as the owner or an admin, says whether the
server is keeping up: schema version, uptime, the database and its log on disk,
attachment storage against its limit, free disk space, waiting and failed app
deliveries (with the oldest waiting), queued, held and failed scheduled
messages, how retention's last sweeps went, open connections, and how late the
event loop ran over the last full minute. It is counts, sizes and times only:
no message, file name, address, token or delivery error, so it can be pasted
into a request for help. In the app, the owner and admins find the same figures
at the end of **Diagnostics**, shown in full before they are copied or saved
as a file.

### Reading the workspace status

What each line of the status means, what is ordinary, and what to do when it
is not. There are no fixed warning thresholds yet: they wait on measuring the
workspace on reference hardware (OPT-01). A line that keeps getting worse
between two readings an hour apart matters more than any one number.

| Line                                    | Ordinary                                                                                                                              | Look into it when                                                             | What to do                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server** (version, schema, uptime)    | The version you installed; uptime since the last start                                                                                | Uptime keeps resetting                                                        | The process is restarting: read its log, and check Docker's restart count or the service manager                                                                                                                       |
| **Database** and **log**                | The log is a few megabytes. SQLite reuses it rather than shrinking it, so its size is the most it has needed since the server started | The log keeps growing across readings                                         | Something kept the database open for reading a long time, such as a very long backup. It is folded back in when that ends, and removed when the server stops                                                           |
| **Attachments**                         | Below the `--storage-limit-mb` you set, or "no limit"                                                                                 | Close to the limit                                                            | Raise the limit, or remove old files (deleting their messages frees them), or turn on [Keeping less history](#keeping-less-history). Uploads past the limit are refused with `507`; nothing is lost                    |
| **Attachment removal**                  | 0 waiting, or a few for a moment; 0 retrying and set aside                                                                            | Retrying or set aside above 0                                                 | Retrying: the log's `attachment cleanup deferred` names each file and error, often a permission or a file held open; each is tried again later. Set aside: not a file name the server gives, never tried               |
| **Free disk**                           | Comfortably more than the database and attachments together                                                                           | Less than the next few weeks of growth, or less than one backup               | Free space before the disk fills: a full disk stops every write, messages included. "unknown" means the system did not say                                                                                             |
| **App deliveries** waiting              | 0, or a few for a moment                                                                                                              | The count, or how long the oldest has waited, keeps growing                   | A receiver is slow or not answering; deliveries to it wait in order. Check the app's endpoint. See [Integration delivery](#integration-delivery)                                                                       |
| **App deliveries** given up             | 0                                                                                                                                     | Above 0                                                                       | An endpoint used up its retries, and its queue was set aside with it. Repair the endpoint, then retry in **Apps and integrations**, which restores the queue in order. Kept seven days                                 |
| **Scheduled messages** queued           | Messages people scheduled                                                                                                             | —                                                                             | Nothing; they send when due                                                                                                                                                                                            |
| **Scheduled messages** held for a retry | 0                                                                                                                                     | Above 0 for long                                                              | Each is waiting on something that may clear: an archived channel, a lost membership, a deactivated author. It is tried again a minute later, or as soon as that changes                                                |
| **Scheduled messages** failed           | 0                                                                                                                                     | Above 0                                                                       | Terminal: the author sees it as **Not sent** under Scheduled and can reschedule it. Nothing retries it                                                                                                                 |
| **History removal**                     | "off", or last done within the hour                                                                                                   | "not run yet" for more than an hour, or failures since                        | Read the server log for `retention sweep failed`, which carries the error. Each failure is tried again the next hour, and the server keeps running                                                                     |
| **Background work**                     | all running                                                                                                                           | Failing for more than a minute or two                                         | Read the server log for `background work failed`, which names the queue and carries the error. The server keeps serving and tries again each round; queued work waits rather than being lost                           |
| **Connections**                         | About one to three sockets per person (tabs, devices)                                                                                 | Many more sockets than people, or both climbing without new members           | Clients reconnecting in a loop, often a proxy that drops WebSockets; see [Behind a reverse proxy](#behind-a-reverse-proxy)                                                                                             |
| **Event loop delay**                    | A few milliseconds at p50 and p99                                                                                                     | p99 near or above 100 ms, the project's main-loop target, minute after minute | The server is busy enough that requests wait. Compare with what was happening (a large import, a retention sweep, a backup) and with free CPU and disk; a sustained figure is worth reporting with the status attached |

The status holds no message, name, file name, address or delivery error, so it
can go into a request for help as it is. **Diagnostics** in the app saves it as
a file for that.

Create the owner account before allowing public traffic, using an SSH tunnel if
necessary. The supplied Compose configuration then requires invitations for new
accounts. Place an HTTPS reverse proxy in front and set `--public-url` in the
service's command, e.g. `https://chat.example.org`. WebSocket upgrades must be
forwarded. For an internet deployment, bind the published chat port to localhost
when the reverse proxy runs on the host.

Example Caddy configuration on that host:

```caddyfile
chat.example.org {
    reverse_proxy 127.0.0.1:8543
}
```

## Voice and huddles

By default no third-party ICE server is contacted. LAN peers connect directly.
For people on different networks, provide your own STUN/TURN configuration through
`TANDEM_ICE_SERVERS` (previously `SLACKOSS_ICE_SERVERS`). Compose reads it
from the environment or `docker/.env`, under either name:

```dotenv
TANDEM_ICE_SERVERS=[{"urls":"stun:turn.example.org:3478"},{"urls":"turn:turn.example.org:3478","username":"workspace","credential":"replace-with-a-strong-secret"}]
```

The authenticated `/api/rtc-config` endpoint supplies it to members. Static TURN
credentials are visible to workspace members; use scoped credentials, quotas, and
rotation on your relay. This repository does not deploy a TURN service for you.
Allow the relay's listening and media ports according to its configuration.

For Cloudflare's relay, give the server the TURN key instead, and it asks
Cloudflare for a password that lasts a day whenever calls need one. Members only
ever receive that password; the API token stays with the server:

```dotenv
TANDEM_CLOUDFLARE_TURN_KEY_ID=your-turn-key-id
TANDEM_CLOUDFLARE_TURN_API_TOKEN=your-turn-key-api-token
```

Set both or neither. They are given to calls after `TANDEM_ICE_SERVERS`.

### When a call will not connect

Someone who can chat but stays on **Connecting…** in a huddle has a connection
that never came up. After 15 seconds the huddle bar says **Can't connect to …**,
tries again with the call settings read afresh (twice at most), and offers
**Why? See the call log**, which opens Diagnostics at that device's call log:
each step of the setup, the kinds of route each side found (`host` on its own
network, `srflx` its public address via STUN, `relay` through TURN) and why it
did not connect. Routes are named by kind only; no address or SDP is recorded.
The owner and admins also see **Calls on this server** in their own Diagnostics:
who joined and left, which setups the server passed on or dropped, and each
side's report of its connection, so the host can read both sides without asking
for anyone's screen. That log is kept in memory, the latest 500 lines, and only
for conversations the reader can see.

What the cause means:

- **No STUN or TURN server:** the device can reach only its own network. Leave
  and rejoin, or open the workspace to all again, so it reads current settings.
- **No public address here / only its own network's addresses from them:** a
  firewall or network on that side blocks reaching STUN; try another network.
- **Public addresses on both sides that do not meet:** one network is too strict
  for a direct connection (often mobile data or a corporate network). Calls
  between them need a TURN relay in `TANDEM_ICE_SERVERS`.

Browser microphone/camera access requires HTTPS (localhost is an exception).
Use the Electron app for voice on plain HTTP LAN servers. Mesh huddles create one
connection per other participant. Start with small calls and measure on target
machines; larger meetings need an SFU. Cameras use a 360p/20fps target with a
720p/24fps ceiling; screen sharing targets 10fps, capped at 15fps. These defaults
reduce processing and bandwidth but do not guarantee a fixed RAM budget.

## Attachment storage

Attachments are unlimited unless you say otherwise, which on a small disk means
one enthusiastic upload can fill it. Cap the workspace with `--storage-limit-mb`,
or `TANDEM_STORAGE_LIMIT_MB` (`SLACKOSS_STORAGE_LIMIT_MB` still works) for
Compose:

```sh
slackoss-server --data ./data --storage-limit-mb 20000
```

The cap covers every stored attachment plus uploads still arriving, so
simultaneous uploads cannot cross it between them. An upload that would not fit
is refused with `507` and leaves nothing behind; the author is told the workspace
is full and keeps their draft. Deleting a message frees its attachments back
once the cleanup worker runs.

Members can see usage under Account settings, including how much is left and the
per-file maximum. `0` means unlimited, which is the default.

An attachment chosen and then thought better of would otherwise hold its bytes
forever. Uploads never attached to a message are freed after 24 hours, tunable
with `--abandoned-upload-hours` or `TANDEM_ABANDONED_UPLOAD_HOURS`
(`SLACKOSS_ABANDONED_UPLOAD_HOURS` still works). Files a
scheduled message is still waiting to send are never swept, however old they
are. The window has to outlast the gap between choosing a file and sending it,
including a client that goes offline in between: an outbox entry that has been
waiting longer than the window loses its attachments and says so rather than
sending the words alone.

Blobs left behind by a process killed mid-upload — bytes on disk that no
database row accounts for — are found and freed at startup.

Size the cap below the free space on the volume rather than at it: the database,
its write-ahead log, and any backups written locally share that disk. Lowering a
cap below what is already stored is allowed — nothing is deleted, and uploads are
refused until the workspace is back under the line.

Files of 8 MiB or more use the browser or desktop download manager, which streams
them to disk without first buffering a complete JavaScript blob. Large images
show a download card; smaller files keep their existing preview/download path.
Upgrade both the server and client to use this feature.

The client requests a single-use link valid for 60 seconds and tied to its signed-in
session. Access is checked again before streaming. The server omits file requests
from its request logs; configure reverse-proxy access logs to omit query strings
on `/api/files/` too, since `download` contains the temporary credential. Tickets
are stored only as hashes and are invalidated by sign-out or file deletion.

Transfer progress, cancellation and completion appear in the browser or device.
A failed or cancelled download can be started again from the file card. Downloads
do not support range resume, and retrying creates a new link and starts from the
beginning. Revocation prevents new transfers; a transfer already streaming is not
interrupted.

## Backups, restore, updates

Use the built-in commands rather than copying files by hand:

```sh
slackoss-server backup  --data ./data --out ./backups/2026-09-06
slackoss-server verify-backup --from ./backups/2026-09-06
slackoss-server restore --from ./backups/2026-09-06 --data ./data
```

`backup` writes a consistent database snapshot (including anything still in the
write-ahead log), every attachment referenced by that snapshot, and a `manifest.json`
recording the schema version, checksums, and row counts from the copied database.
`--out` must be a new or empty directory outside the workspace data directory.
Stop the server first for a backup that is certain to be complete.
If an attachment disappears during capture, backup fails instead of reporting success.
The copy is captured and verified in an owned staging folder beside the destination,
then published into `--out`. Failed staging is removed; a later capture reconciles
interrupted operation records without deleting unrecognized folders or active captures.

`verify-backup` checks checksums, safe attachment paths, the actual database schema,
row counts, foreign keys and attachment inventory without changing a workspace.
An omitted attachment is rejected even if all listed checksums match.
It then lists what starting the backup would reach outside itself: the addresses
its apps are sent events, commands and button clicks at, messages waiting to be
posted, app events not yet delivered, and how many sign-ins it would accept.
Sign-ins ended after the backup was taken are valid again in a restore, so after
restoring a real workspace, ask people to look at their signed-in devices and
end any they had already ended.
Settings given on the command line or in the environment are not in a backup:
`--public-url`, `--retention-days`, `--storage-limit-mb`, `--allow-private-hooks`,
`--trust-proxy`, `TANDEM_ICE_SERVERS`, and any proxy or certificate in front
of the server. Note them where you keep the backup.

`restore` verifies the backup, stages and re-verifies it beside the target, and only then swaps
it in; the previous data directory is renamed to `data.superseded-<timestamp>`
rather than deleted. Stop the server before restoring: a restore, like `recover`,
is refused while a server has the data directory open, and a server started
while a restore is running is refused until it has finished. A backup from a newer
server than the one restoring it is refused instead of half-applied.

Only one server can have a data directory open at a time. A second one started
on the same directory, through any path or link to it, is refused before it
opens anything and says which process has it. The lock is the operating
system's, held on `workspace.lock` inside the directory, so it goes when that
process exits or crashes, and there is nothing to clear by hand afterwards.
`workspace.owner.json` beside it only describes the holder. Keep the data
directory on a local disk: file locking on a network share is not dependable,
for this lock or for SQLite itself.

A restore has to let go of that lock to move the old directory aside and the
restored one in. So that nothing starts in between, a second lock is held
beside the directory, on `data.lock` for a directory named `data`: by a restore
from start to finish, and for a moment by anything else that takes the
directory. The file is removed when the lock is let go. If one is left behind
after a crash, it is empty and the next start removes it.

To check that a backup really holds what you need, restore it into a new
directory and start that copy with `--isolated`:

```sh
slackoss-server restore --from ./backups/2026-09-06 --data ./restore-check
slackoss-server --data ./restore-check --isolated --port 8600
```

The copy holds the original's apps, their signing secrets and its queue of
scheduled messages. Started normally, it would post messages that were due a
second time and call the same apps as the same workspace. An isolated start posts
no scheduled message, delivers no app event, answers slash commands and buttons
with "this is an isolated copy of the workspace, which does not contact apps", and
does not announce itself on the local network. It listens on this machine only
unless `--host` says otherwise. Sign in, read, search and open attachments as
usual. What it holds back stays queued, so delete the copy when you are done
rather than starting it normally, or the queue goes out from there.

Store backups away from the host, encrypted. For Docker, run the same commands
inside the container against the mounted volume.

Before upgrading, take a backup. Rebuild and restart with Compose; SQLite migrations
run automatically. To roll back a schema change, restore the matching backup and
previous application version together — the server refuses to open a database
newer than it understands, so an application rollback alone will not start.

The server also copies the database itself before any upgrade that changes the
schema, so there is something to roll back to even when nobody remembered. The copy
goes in `pre-upgrade/` inside the data directory, is named for the schema versions
it sits between, and the startup output says where it went. The three most recent
are kept, counting the one just taken, which is never removed. "Most recent" means
from the latest schema first, and only then by the time in the name, so a clock set
wrong cannot push out the copy an upgrade has just made. Only copies that open at
the schema their name records, as this workspace, count towards the three; a copy
that does not is left where it is for you to look at. If the copy cannot be written — most often a full disk — the server
refuses to upgrade and changes nothing. The copy is the database only: attachments
are not duplicated, since no migration touches them. To roll back with it, stop the
server, put the copy in place of `workspace.db`, and start the previous release.
Everything written since the upgrade is lost with it — messages, accounts, settings.
Attachments uploaded since then stay on disk with nothing pointing at them; a release
that reconciles orphaned attachments frees them on start, and an older one leaves
them for you to remove. `--skip-upgrade-backup` turns the copy off,
for someone who has just taken a backup and has no room for a second one.
Deleting a container preserves the named volume; `docker compose down -v` deletes
it, so avoid that command for real data.

There are no separate Redis, Postgres, or message broker services to maintain.
Monitor disk usage for uploads and history, resource use, health, and backups.

Schema v13 keeps a persistent queue for deleted attachments. Message and file
metadata are removed atomically; physical file removal follows the commit.
Temporary filesystem failures remain queued for retry every 15 seconds and on
restart. Cleanup handles at most 100 queued files per pass; shutdown awaits the
active pass before closing the database. A locked file can remain on disk until
cleanup succeeds, but the download API no longer serves it after deletion commits.

## Deletion and retention

### What deleting a message does

Deleting a message removes it from every channel, thread, search result, pinned
list and saved list immediately, and releases its attachments. Specifically:

- **The message itself** is kept as an empty tombstone rather than a row that is
  gone. The row holds no text, no attachment and nothing anyone wrote; what it
  still holds is an id, an author and a timestamp, which is what lets a reply
  posted under it keep resolving.
- **Replies** are deleted with the message that started their thread — every
  reply, whoever wrote it, exactly as if each had been deleted on its own: words
  blanked, attachments released, and their copies in the event log redacted. The
  thread drops out of the followed list and asking for it returns
  `thread_not_found`. Deleting the message you opened a conversation with
  therefore deletes everyone else's answers to it, which is worth knowing before
  deleting the top of a long thread. Deleting a single reply leaves the rest of
  the thread alone.
- **Attachments** are removed from the database with the message and their bytes
  are deleted from disk by a queue that retries until it succeeds. A file locked
  by the operating system can survive on disk for a few minutes; the download
  API stops serving it the moment the deletion commits.
- **Pins, saves and reactions** pointing at it are deleted outright.
- **The search index** loses the text as part of the same write. SQLite marks the
  freed index pages reusable rather than overwriting them, so the words can
  remain in unallocated space inside `workspace.db` until something else writes
  over them. `VACUUM` on a stopped server rewrites the file without them.
- **The event log** loses the text and the attachment names too. The events
  themselves stay — a missing sequence number would look to a catching-up client
  exactly like a log it had fallen off the end of, and send it back for a whole
  new snapshot — but what they replay is a message with nothing in it, followed
  immediately by the deletion.
- **Editing** a message does the same to every earlier version of it. Taking
  back a sentence by editing it away is the usual way people do it, and leaving
  the first draft in the log would make the correction cosmetic.
- **App events still waiting to be delivered**, or that gave up, lose the words
  too, on edit, deletion and retention alike; the events stay so each app still
  receives them in order. An event already delivered belongs to that app and
  cannot be recalled, and one on its way out at that moment may still arrive as
  it was. See [Integration API contract](INTEGRATIONS.md#events).
- **The request log** never held the text: the server logs methods, paths and
  status codes, not bodies.
- **Backups** taken before the deletion still contain the original text, in full.
  Nothing this server does reaches into a backup you have already made. If a
  deletion has to be permanent, the backups from before it have to go too.

There is no account deletion. An account can be deactivated, which ends its
sessions and stops it signing in, and what it wrote stays where it is.

### Keeping less history

```sh
slackoss-server --data ./data --retention-days 365
```

Off by default: a workspace that quietly started discarding history would be
worse than one that grows. Also settable with `TANDEM_RETENTION_DAYS`
(`SLACKOSS_RETENTION_DAYS` still works). The
server prints the window on every start, because a setting that deletes things
is one to be reminded of.

An hourly sweep removes conversation older than the window outright — rows,
attachments, pins, saves, reactions, and the text in the event log — rather than
hiding it. A thread ages out as one thing: a root is taken only once its newest
reply is past the window too, so nobody is left with replies hanging under
nothing. Each pass removes at most 5,000 messages, counting replies, taking the
oldest threads first; a single thread larger than that goes whole, on its own.
The hourly sweep runs passes back to back, giving other requests the server
between them, until nothing is left or it has run for 30 seconds, and the rest
follow on the next hour. A sweep that fails is logged as an error and tried
again on the next hour; it does not stop the server.

Nothing is announced to connected clients. These messages are old enough that no
screen is showing them, and announcing a year of deletions would put the events
into the very log this is meant to keep small. A client scrolled that far back
keeps what it already has until it next asks the server, which will not have it.

This is not reversible. Getting discarded conversation back means restoring a
backup taken before the sweep ran. Decide the window before turning it on, take
a backup, and remember that lowering it later discards everything the new window
excludes on the next hour.

The event log is pruned separately and always: only the most recent 20,000
events are kept, which is what a client resyncs against. Falling behind that is
not a loss of history — the client takes a fresh snapshot instead.

## Integration delivery

Outgoing event subscriptions use a durable queue in `workspace.db`. Each matching
delivery commits with its workspace event, then runs outside the user's request.
Failures retry eight times with increasing delays, in event order for each
subscription and in parallel across different subscriptions. Pending work resumes
when the server restarts. A successful receiver may see the same event again if the
server exits after its HTTP response but before recording completion, so receivers
must deduplicate by the stable `event_id`.

Stopping the server cuts off any delivery, slash command or button call still
waiting on an app, rather than waiting out its timeout. A delivery cut off that way
is not counted as one of the endpoint's attempts, since the endpoint neither answered
nor refused; it goes out again after the restart. Requests already being handled are
finished before the database closes, so a shutdown never leaves one half-applied.

One endpoint may hold at most 500 waiting events. Delivery is ordered, so a receiver
that stops answering holds up everything behind it; without a ceiling its queue would
grow for as long as the workspace stays busy. Past the ceiling events are counted as
dropped rather than queued, and the count is shown beside the subscription. Once a
delivery has used up its attempts, the rest of that endpoint's queue is given up on
with it, so a dead receiver is not kept under load for days and an administrator
repairing it does not face a backlog that drains one event every few hours. Retrying
restores the whole queue in order. The dropped count clears once the endpoint is
delivering again, or when an administrator retries.

Apps and integrations shows pending and terminally failed deliveries. An admin can
retry failed work after repairing the endpoint. Terminal records are retained for
seven days; deleting the subscription or app deletes its queue immediately. A
deactivated bot receives no new events and its prior pending deliveries pause.
Removing a bot from a channel discards queued events for that channel, so restoring
membership does not disclose events from the revoked interval.

### Replacing a leaked credential

Apps and integrations offers a replacement for each of an app's three kinds of
secret, without deleting the app or losing its commands, subscriptions and
webhooks:

- **New bot token** replaces every token the app has. The old one stops working
  with that request, with no overlap, since a token is replaced because it has
  leaked. This is also how to get a token for an app whose original was never
  copied: the server stores tokens only as hashes and cannot show one again.
- **Replace** beside the signing secret takes effect on the next request the server signs,
  including event deliveries already waiting in the queue, which are signed when
  they are sent. The app rejects requests until it has the new secret.
- **New URL** on a webhook keeps its channel and replaces the secret in its URL.
  Anything posting to the old URL gets a 404.

Each replacement is logged with the app or webhook and the administrator who made
it, never the credential itself.

## Behind a reverse proxy

Set `--public-url` to the address people actually use. It is what an app is told
to send its replies to, and having it configured means nothing has to be inferred
from a request. Invite and message links are built on it too, so a link copied by
someone looking at the workspace through `localhost` still works for everyone
else. Add `--trust-proxy` only when a proxy in front of this server
writes the `X-Forwarded-*` headers and nothing can reach the server directly:
anyone can send those headers, and without a proxy to vouch for them a forged one
would decide where an app's reply and its token went. With neither set, the server
uses the address the connection arrived on, which no header can change.

The browser client is sent already compressed. The build writes a Brotli and a
gzip copy of each script and stylesheet, and the server sends the one the browser
accepts, with `Vary: Accept-Encoding`. Files under `/assets/` are named by their
content, so they are cached for a year (`immutable`); the page itself is
`no-cache`, so a new version is picked up on the next visit. A proxy needs no
compression of its own for these: let `Accept-Encoding` through and keep `Vary`.

The address must be a full `http://` or `https://` URL. A path is fine, for a
server published under one (`https://example.com/chat`), though clients reach a
server at its root, so links are then built on the address each person uses
instead. A username or password, a query or a `#fragment` is refused at startup,
since whatever is in the address is repeated in every URL handed to an app.

The server checks its settings before it starts and stops with a one-line reason
naming the flag: a port outside 0–65535, a malformed `--public-url`, a fraction
of a day for `--retention-days`, an unknown flag, a port already in use or one
this account may not bind, or a `--host` address the machine does not have.

While a workspace has no owner yet, creating the first account from the machine
running the server does not need the claim code. That applies to a command line
request or to the page this server itself served, not to any page that merely has
your browser post to localhost — those carry an `Origin` naming somewhere else and
are asked for the code like anyone else.

## Request limits

One caller is held to a fair share of sign-in attempts, messages, uploads,
sockets and typing notices. Where there is an account to key on, the limit is
keyed on the account rather than the address: an office reaches this server from
a single NAT address, and everyone in it must not be sharing one person's
allowance. Only the two limits that have no account yet — sign-in attempts and
opening a socket — are keyed on the address, and both are deliberately loose.

Sign-in is rationed per handle as well, and tightly, because that is the limit an
attacker actually meets. Only wrong guesses count: a correct password clears what
the handle has spent, so someone who knows their own password never meets this
however often they sign in or change it. A refused request answers `429` with a
`Retry-After` telling the client when to come back, and nothing is charged for a
refusal, so a client that retries too eagerly does not push its own recovery out.

Incoming webhooks have no account behind them, so each webhook has an allowance
of its own (a burst of 30, then one a second) rather than spending a person's or
starving the same app's other webhooks. Requests to `/hooks/…` are also counted
per address before the token is looked up, loosely, so guessing tokens costs the
same as using one. Slash commands, buttons and form submissions that call out to
an app spend an allowance of the account that caused them (a burst of 20, then one
a second), and at most four such calls per account and sixteen per app may be
waiting for an answer at once. A call past either cap is refused with `429`
straight away rather than queued behind a slow app, and nothing is sent to the
app for a refused call.

Scheduled messages are bounded too: one account may have 200 waiting and the
workspace 10,000, and past either the request is refused with `409` rather than
queued. Messages that come due are sent ten at a time, with other requests served
in between, and one held back (an archived channel, a lost membership, a
deactivated author) is looked at again a minute later, or at the next check once
the channel reopens, the membership returns or the account is reactivated.

The allowances are held in memory, so a restart grants one fresh burst. Buckets
are dropped once they refill, which keeps the bookkeeping proportional to who is
active rather than to everyone who has ever connected.

`--no-rate-limits`, or `TANDEM_RATE_LIMITS=off` (`SLACKOSS_RATE_LIMITS=off`
still works), turns all of this off. That is reasonable on a network where
everyone is already trusted and unreasonable anywhere reachable from outside it.
Bulk imports and seeding scripts are the usual reason to want it; prefer running
those against a server started with the flag rather than raising the limits for
everybody.

## Changing a workspace address and keeping local work

Updated clients store drafts, queued sends, scheduling recovery and recent
searches by workspace ID and account ID. Renaming the workspace or restoring its
backup preserves that ID. Before changing its address, open the old address once
with the updated client so it can associate that address with the workspace.
Legacy data can then migrate from any previously approved address, including
scheduling recovery for conversations you have not reopened. Existing stable
data takes precedence over an additional address's legacy copy.

When another address claims an identity this device already knows, the client
shows the previous and new addresses. Approve it only when you recognize the
move: continuing restores local work and may automatically send queued messages.
The ID itself is public and does not prove that a different server is trustworthy.

This works within the same desktop app profile or browser app origin. A browser
served from a new origin cannot read the old origin's localStorage. These local
items are not uploaded as drafts, included in server backups, or encrypted by
this feature. Older servers continue to use URL/account keys.

If local storage cannot be read or saved, keep the client open and use its Retry
action after resolving the problem. Unreadable browser values and malformed
desktop settings are preserved instead of being treated as empty. Repairing the
desktop settings file can be retried without restarting the app.

## Desktop saved sign-ins

Tandem encrypts the desktop app's saved sign-ins using Electron's
[OS-backed safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
Windows uses the current OS account's protection; macOS uses Keychain and Linux
needs a supported secret store. Linux's `basic_text` fallback is refused. On
macOS, consistent application signing is needed for reliable Keychain behavior
across updates.

An old plaintext sign-in list is migrated on its next successful read or settings
write. The original remains intact if encryption or replacement fails; it is
still plaintext until migration succeeds. New credentials are never saved with
a plaintext fallback. A failed save leaves the current session usable and shows
Retry saving. Unlock the system key store and retry before closing if you want
the new sign-in remembered.

If saved sign-ins cannot be unlocked, the app offers Retry or a confirmed Forget
saved sign-ins action. Forgetting removes only the saved sign-ins, so you can
authenticate again while keeping drafts, queued messages and hosted workspaces.
Copying desktop settings to another OS account/machine may require signing in
again; the protected credentials depend on the original OS key store. Older
desktop builds do not understand this protected saved-sign-in format.

Drafts and other local settings remain unencrypted. This does not encrypt browser
localStorage, server data or older backups, and it does not protect credentials
from a compromised running app or another process with the same OS-account
access. Native runtime verification currently covers Windows; macOS/Linux
behavior still needs platform testing.

## The administrative record

The workspace keeps a record of the administrative changes made in it, readable by
administrators under **People → Show recent changes**:

- changing someone's role, deactivating or reactivating them, and resetting their
  password;
- handing the workspace to a new owner;
- recovering an account with `slackoss-server recover`, recorded as done by the host
  rather than by anyone signed in;
- creating and deleting apps, replacing their bot token or signing secret, and
  changing where their buttons and forms go;
- adding, replacing and removing webhooks, slash commands and event subscriptions,
  and retrying failed deliveries;
- creating and revoking invite codes, and granting or removing a member's
  permission to create them;
- renaming the workspace and changing who may join it, from **Workspace
  settings**, or by the desktop app that hosts it, recorded as done by the host.

Each entry says who made the change, to what, and when, and is written in the same
transaction as the change, so neither exists without the other. A change that
changes nothing — setting a role someone already has — is not recorded.

The record never holds a credential: no token, signing secret, password or invite
code, and no URL given to an app, since those often carry a secret of their own.
Only the host an app is called at is kept, and an invite is identified by a short
fingerprint of its code. Nobody's messages are in it.

The record is kept in `workspace.db`, so it is in every backup, and it is not
shortened by `--retention-days`. Anyone who can read that file can read it, and can
change it: it is an account of what happened through the workspace, not tamper-proof
evidence against someone with access to the server itself.

## Invites

When the workspace takes people with an invite only (`--invite-only` on a new
workspace, or **People with an invite** in Workspace settings), everyone after
the owner needs an invite code to create an account. Owners and administrators can make codes from **Invite people**. A
member needs an administrator to select **People → Allow inviting** first;
**Stop inviting** removes that permission. Apps cannot create invite codes.
The dialog's codes last seven days. The same dialog lists codes: every code for an administrator, and
only their own for a member, since a code is what lets a stranger in. Each shows
how many times it has been used and whether it still works.

**Revoke** stops a code letting anyone else in, for one that has been shared
further than meant. Its creator or an administrator can revoke it; a member who
tries someone else's is told there is no such code, so trying codes cannot
confirm which exist. A revoked code stays in the list, marked as revoked.

A code also stops working while its creator is deactivated or cannot invite.
Restoring access and permission makes their unexpired, unused codes work again;
revoke a code if it should stay dead. Members can still list and revoke their
own codes after losing permission to create more. Codes are left out of the
request log.

Schema v25 starts all members without an explicit invitation grant, including
existing members during an upgrade. Their previously issued codes pause until
an administrator allows them to invite. Owner/admin codes continue to work.
Demoting an administrator removes the permission their role supplied; any
explicit member grant they held before promotion remains until removed.

Otherwise anyone who can reach the server can create an account, and a code is
not asked for.

## Who may join

A workspace has one rule for who may join it: `invite_only` (people with an
invite), `account_required` (anyone who creates an account) or `guest_allowed`
(anyone, guests included). Its owner and administrators choose it in **Workspace
settings → Who can join**, opened from the workspace menu, where it is saved the
moment it is chosen and everyone signed in sees the change. The same page
renames the workspace. Members and guests do not see it.

`--access-policy` (or `--invite-only`, which is `--access-policy invite_only`) and
`--name` set up a workspace nobody owns yet. Once someone has claimed it, the
workspace keeps its own name and rule, and a later start does not change either:
a flag that disagrees is left alone, and the server prints a line saying the
workspace keeps its own and where to change it.

**Changed in this version:** `--access-policy` and `--invite-only` used to be
applied on every start, so a service or compose file that passed them put the
rule back at each restart. They now apply to a new workspace only. To change the
rule of a running workspace, use Workspace settings; a restart keeps it.

In the desktop app that hosts a workspace, **Open to all** in **Manage hosting**
sets the rule chosen beside it for the public link. While the link is open,
Manage hosting shows the workspace's rule and can change it, and a change made
in Workspace settings shows there at once. One start still changes the rule:
while a stable public address is configured, every start closes joining to
invited accounts.

## Guests

With guests allowed, someone who reaches the server can join with a display name
alone, and creating an account stays open and optional. In the desktop app,
clear **Require an account to join** where the public link is opened. Guests let
in for a public link leave with it: closing the link goes back to the rule from
before, unless an owner or administrator chose one in Workspace settings while
it was open, which stays.

A guest reads and posts in public channels, with replies, reactions, files
already shared, saved items, search and huddles. A guest cannot be in a private
channel or a direct message, by its own doing or anyone else's, and cannot
create rooms, upload files, pin, invite, schedule, use apps or commands, or
change its password; the server refuses every request outside that list, so a
route added later stays closed to guests until it is opened on purpose. Guests
are marked as guests wherever they appear.

A guest session lasts 24 hours from joining and does not extend with use;
reloading resumes it until then. At most 200 guests can be signed in at once.
Joining is limited per address like signing in. Requiring an account again signs
every guest out at once, sockets included; what they wrote stays. A guest can
**Create an account** from the Workspace menu while accounts can be created
without an invite: it keeps the same identity, messages and channels. An
administrator can deactivate a guest, but cannot make one a member or reset its
password.

## Current boundaries

Friends and accounts do not federate across servers. Account settings offers password
changes and signed-in device management. Administrators can reset member passwords
from People; the owner can transfer ownership there after confirming the target handle.
Share temporary passwords privately and ask recipients to change them after sign-in.
There is no SSO, email-based account
recovery, large-call SFU, automated update service, or signed public release
pipeline yet. Test with your environment before an office-wide rollout.
