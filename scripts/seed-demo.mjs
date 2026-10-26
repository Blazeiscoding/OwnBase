// Fills a new, empty workspace with people and conversation, through the same
// public API the apps use, so trying OwnBase starts with something to look
// at: channels with topics, a thread, reactions, a mention, a pinned
// checklist, an image, statuses and a direct message.
//
//   node scripts/seed-demo.mjs [address] [--password <password>] [--claim-code <code>]
//
// The address defaults to http://localhost:8543. Every account gets the same
// password, generated unless one is given, and printed at the end. A workspace
// that already has accounts is left alone, since this would add strangers to
// it. Run from another computer, the first account also needs the claim code
// the server printed when it started.
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

const USAGE =
  "Usage: node scripts/seed-demo.mjs [address] [--password <password>] [--claim-code <code>]";

/** The first becomes the owner. */
const PEOPLE = [
  { handle: "maya", displayName: "Maya Chen" },
  { handle: "sam", displayName: "Sam Rivera" },
  { handle: "priya", displayName: "Priya Natarajan" },
  { handle: "alex", displayName: "Alex Kim" },
];

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readArgs(argv) {
  const options = { address: "http://localhost:8543", password: null, claimCode: null };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    const [flag, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s) : [arg];
    const value = () => {
      const next = inline ?? rest.shift();
      if (!next) fail(`${flag} needs a value.\n${USAGE}`);
      return next;
    };
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (flag === "--password") options.password = value();
    else if (flag === "--claim-code") options.claimCode = value();
    else if (flag.startsWith("-")) fail(`Unknown option ${flag}.\n${USAGE}`);
    else options.address = arg;
  }
  return options;
}

/** An address as people type it: a bare host means the usual port, a full URL is taken as written. */
function workspaceUrl(input) {
  const text = input.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(text)) return text;
  return /:\d+$/.test(text) ? `http://${text}` : `http://${text}:8543`;
}

const options = readArgs(process.argv.slice(2));
const base = workspaceUrl(options.address);
const password = options.password ?? randomBytes(9).toString("base64url");
if (password.length < 8) fail("The password needs at least eight characters.");

async function api(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(base + path, { method, headers, body: payload });
  } catch (error) {
    fail(
      `Could not reach ${base}: ${error.cause?.message ?? error.message}. Is the server running?`,
    );
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    fail(`${base} did not answer ${path} as an OwnBase workspace would.`);
  }
  if (!response.ok) throw new ApiError(response.status, data.error, data.message);
  return data;
}

/**
 * A 640 × 360 PNG of a sign-in screen, drawn here so the demo needs no files:
 * a warm background, a card, a heading, two fields and a button.
 */
function mockupPng() {
  const width = 640;
  const height = 360;
  const card = { x: 180, y: 40, w: 280, h: 280 };
  // Painted in order, so later shapes cover earlier ones.
  const shapes = [
    { ...card, r: 14, color: [217, 203, 184] },
    { x: card.x + 1, y: card.y + 1, w: card.w - 2, h: card.h - 2, r: 13, color: [255, 255, 255] },
    { x: card.x + 24, y: card.y + 28, w: 150, h: 14, r: 4, color: [43, 42, 40] },
    { x: card.x + 24, y: card.y + 52, w: 200, h: 7, r: 3, color: [170, 160, 148] },
    { x: card.x + 24, y: card.y + 84, w: 64, h: 6, r: 3, color: [138, 129, 119] },
    { x: card.x + 24, y: card.y + 96, w: 232, h: 32, r: 6, color: [207, 195, 179] },
    { x: card.x + 25, y: card.y + 97, w: 230, h: 30, r: 5, color: [252, 250, 247] },
    { x: card.x + 24, y: card.y + 144, w: 64, h: 6, r: 3, color: [138, 129, 119] },
    { x: card.x + 24, y: card.y + 156, w: 232, h: 32, r: 6, color: [207, 195, 179] },
    { x: card.x + 25, y: card.y + 157, w: 230, h: 30, r: 5, color: [252, 250, 247] },
    { x: card.x + 24, y: card.y + 208, w: 232, h: 36, r: 8, color: [184, 100, 60] },
    { x: card.x + 105, y: card.y + 223, w: 70, h: 6, r: 3, color: [255, 255, 255] },
    { x: card.x + 95, y: card.y + 258, w: 90, h: 5, r: 2, color: [184, 100, 60] },
  ];
  const inside = (px, py, s) => {
    if (px < s.x || py < s.y || px >= s.x + s.w || py >= s.y + s.h) return false;
    const cx = Math.min(Math.max(px, s.x + s.r), s.x + s.w - s.r - 1);
    const cy = Math.min(Math.max(py, s.y + s.r), s.y + s.h - s.r - 1);
    return (px - cx) ** 2 + (py - cy) ** 2 <= s.r * s.r;
  };
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    for (let x = 0; x < width; x++) {
      let color = [244 - 11 * t, 237 - 17 * t, 228 - 25 * t];
      for (const shape of shapes) if (inside(x, y, shape)) color = shape.color;
      rows.set(color.map(Math.round), y * stride + 1 + x * 3);
    }
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type), body]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function register(person, extra) {
  try {
    return await api("POST", "/api/auth/register", {
      body: { handle: person.handle, displayName: person.displayName, password, ...extra },
    });
  } catch (error) {
    if (error.code === "claim_required") {
      fail("The claim code was not accepted. Use the one the server printed when it started.");
    }
    if (error.code === "handle_taken") {
      fail(`Someone took the name ${person.handle} meanwhile. Run the demo on a fresh workspace.`);
    }
    throw error;
  }
}

const post = async (account, channel, text, extra = {}) =>
  (
    await api("POST", `/api/channels/${channel.id}/messages`, {
      token: account.token,
      body: { text, ...extra },
    })
  ).message;
const react = (account, message, emoji) =>
  api("PUT", `/api/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`, {
    token: account.token,
  });
const join = (account, channel) =>
  api("POST", `/api/channels/${channel.id}/join`, { token: account.token });
const mention = (account) => `<@${account.user.id}>`;

async function seed(info) {
  const people = {};
  people.maya = await register(
    PEOPLE[0],
    options.claimCode ? { claimCode: options.claimCode } : {},
  );
  // Whether joining takes a code is only known once there is an owner.
  const { requiresInvite } = await api("GET", "/api/server-info");
  let invite = {};
  if (requiresInvite) {
    const { invite: created } = await api("POST", "/api/invites", {
      token: people.maya.token,
      body: { maxUses: PEOPLE.length - 1, expiresInHours: 1 },
    });
    invite = { inviteCode: created.code };
  }
  for (const person of PEOPLE.slice(1)) people[person.handle] = await register(person, invite);
  const { maya, sam, priya, alex } = people;

  await api("PATCH", "/api/me", {
    token: priya.token,
    body: { statusEmoji: "🎨", statusText: "Sketching the onboarding flow" },
  });
  await api("PATCH", "/api/me", {
    token: alex.token,
    body: { statusEmoji: "🚢", statusText: "Release week" },
  });

  const { channels } = await api("GET", "/api/channels", { token: maya.token });
  const general =
    channels.find((c) => c.type === "public" && c.name === "general") ??
    channels.find((c) => c.type === "public");
  const channel = async (name, topic) =>
    (
      await api("POST", "/api/channels", {
        token: maya.token,
        body: { type: "public", name, topic },
      })
    ).channel;
  const design = await channel("design", "Mockups, reviews and the design system");
  const engineering = await channel("engineering", "Builds, releases and the occasional fire");
  const random = await channel("random", "Lunch plans, pets and everything else");
  for (const account of [sam, priya]) await join(account, design);
  for (const account of [sam, alex]) await join(account, engineering);
  for (const account of [sam, priya, alex]) await join(account, random);

  const welcome = await post(
    maya,
    general,
    "Welcome to OwnBase, everyone! 👋 Announcements go here, day-to-day work in #design and #engineering, and everything else in #random.",
  );
  await post(sam, general, "Hi all! Happy to be here.");
  await post(priya, general, "Hello! I'll share the new sign-in screen in #design this week.");
  for (const [account, emoji] of [
    [sam, "🎉"],
    [priya, "🎉"],
    [alex, "🎉"],
    [alex, "👋"],
  ]) {
    await react(account, welcome, emoji);
  }

  let fileIds;
  try {
    const form = new FormData();
    form.append("file", new Blob([mockupPng()], { type: "image/png" }), "sign-in-mockup.png");
    const { file } = await api("POST", `/api/channels/${design.id}/files`, {
      token: priya.token,
      form,
    });
    fileIds = [file.id];
  } catch (error) {
    // A server started with uploads turned off still gets its thread.
    if (error.code !== "uploads_disabled") throw error;
  }
  const mockup = await post(
    priya,
    design,
    "First pass at the new sign-in screen. Thoughts?",
    fileIds ? { fileIds } : {},
  );
  const reply = (account, text, extra = {}) =>
    post(account, design, text, { threadRootId: mockup.id, ...extra });
  await reply(sam, "Love the colours. Could the button be a little bigger?");
  await reply(priya, "Good call, I'll try it 20% larger and share an update.");
  await reply(maya, "Looks great. Let's review it together on Thursday.", {
    alsoSendToChannel: true,
  });
  await react(sam, mockup, "❤️");
  await react(maya, mockup, "👀");

  const checklist = await post(
    alex,
    engineering,
    "Release checklist for 0.2:\n```\n[x] Tag the release\n[x] Build the installer\n[ ] Smoke test on a clean machine\n[ ] Announce in #general\n```",
  );
  await api("PUT", `/api/messages/${checklist.id}/pin`, { token: alex.token });
  await react(maya, checklist, "👍");
  const volunteer = await post(sam, engineering, "I can take the smoke test tomorrow morning.");
  await react(alex, volunteer, "✅");
  await post(
    alex,
    engineering,
    `Thanks! ${mention(maya)}, could you announce it in #general once the smoke test passes?`,
  );

  const lunch = await post(sam, random, "Anyone up for lunch on Friday? 🌮");
  await post(priya, random, "Count me in!");
  await react(alex, lunch, "👍");

  const { channel: dm } = await api("POST", "/api/channels", {
    token: sam.token,
    body: { type: "dm", memberIds: [maya.user.id] },
  });
  await post(sam, dm, "Morning! Could you look over the release checklist before Thursday?");

  const width = Math.max(...PEOPLE.map((person) => person.handle.length));
  console.log(
    [
      `${info.workspaceName} at ${base} is ready to try.`,
      "",
      `Sign in as any of these. They all use the password ${password}`,
      "",
      ...PEOPLE.map(
        (person, i) =>
          `  ${person.handle.padEnd(width)}  ${person.displayName}${i === 0 ? ", the owner" : ""}`,
      ),
      "",
      "Start with maya: sam has sent her a direct message, and alex mentioned her in #engineering.",
      'For more to try, see "Try it" in README.md. These accounts share a password,',
      "so keep them out of a workspace other people can reach.",
    ].join("\n"),
  );
}

let info;
try {
  info = await api("GET", "/api/server-info");
} catch (error) {
  fail(`${base} did not answer as an OwnBase workspace (${error.message}).`);
}
if (info.app !== "slackoss") fail(`${base} is not an OwnBase workspace.`);
if (info.userCount > 0) {
  const accounts = info.userCount === 1 ? "an account" : `${info.userCount} accounts`;
  fail(
    `${info.workspaceName} already has ${accounts}. The demo only fills a new, empty ` +
      "workspace, so it has left this one alone. Start a server on a fresh --data folder and run it again.",
  );
}
if (info.requiresClaim && !options.claimCode) {
  fail(
    `${info.workspaceName} has no owner yet, and this computer is not the one hosting it. ` +
      "Pass --claim-code with the code the server printed when it started.",
  );
}
try {
  await seed(info);
} catch (error) {
  if (!(error instanceof ApiError)) throw error;
  fail(
    `The server refused part of the demo: ${error.message} (${error.status}). ` +
      "The workspace may be half filled, so start again on a fresh --data folder.",
  );
}
