import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type {
  Channel,
  RepeatRule,
  ScheduleMessageBody,
  ScheduledMessage,
  User,
} from "@ownbase/protocol";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { ScheduledPanel } from "../src/components/ScheduledPanel.js";
import { TimePopover } from "../src/components/TimePopover.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { deviceZone } from "../src/lib/repeat.js";
import { chooseTime } from "./chooseTime.js";
import { render } from "./render.js";

/**
 * Repeating messages (K14): the Repeat choice in Send later, the line and
 * Stop repeating in Scheduled, and /remind's check before it schedules.
 */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id],
};

const scheduledFrom = (channelId: string, body: ScheduleMessageBody): ScheduledMessage => ({
  id: "S1",
  channelId,
  userId: sam.id,
  text: body.text,
  threadRootId: null,
  broadcast: false,
  fileIds: [],
  sendAt: body.sendAt,
  createdAt: 0,
  status: "queued",
  failureReason: null,
  attempts: 0,
  messageId: null,
  repeat: body.repeat ?? null,
});

function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  const schedule = vi
    .spyOn(client.api, "scheduleMessage")
    .mockImplementation(async (channelId, body) => ({ scheduled: scheduledFrom(channelId, body) }));
  return { client, schedule };
}

async function renderComposer() {
  const { client, schedule } = workspace();
  const values = new Map<string, unknown>();
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) => (values.get(name) ?? null) as T | null,
      set: async (name: string, value: unknown) => void values.set(name, value),
    },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Composer channelId={design.id} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message #design" });
  await waitFor(() => expect(box).toBeEnabled());
  return { client, schedule, box };
}

describe("Send later's Repeat choice", () => {
  it("schedules every weekday at the time chosen, in this device's zone, and hides the quick times", async () => {
    const user = userEvent.setup();
    const { schedule, box } = await renderComposer();
    await user.type(box, "Standup notes");
    await user.click(screen.getByRole("button", { name: "Send later" }));
    const popover = await screen.findByRole("dialog", { name: "Send later" });
    expect(within(popover).getByRole("button", { name: /Tomorrow morning/ })).toBeVisible();
    // Monday 5 January 2099.
    await chooseTime("2099-01-05", "09:00");
    const repeat = within(popover).getByRole("combobox", { name: "Repeat" });
    expect([...repeat.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Does not repeat",
      "Every day",
      "Every weekday",
      "Every week on Monday",
      "Every month on the 5th",
    ]);
    await user.selectOptions(repeat, "Every weekday");
    expect(within(popover).queryByRole("button", { name: /Tomorrow morning/ })).toBeNull();
    await user.click(within(popover).getByRole("button", { name: /^Schedule for .*2099 at / }));

    await waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    const [, body] = schedule.mock.calls[0]!;
    expect(body.sendAt).toBe(new Date("2099-01-05T09:00").getTime());
    expect(body.repeat).toEqual({
      every: "weekday",
      time: "09:00",
      timeZone: deviceZone(),
      until: null,
    } satisfies RepeatRule);
    expect((await screen.findAllByText(/^Scheduled to repeat, starting /))[0]).toHaveTextContent(
      "Change or stop it in Scheduled.",
    );
  });

  it("names the first send on its button, and refuses an end date before it", async () => {
    const onPick = vi.fn();
    const { client } = workspace();
    const anchor = { current: document.body };
    render(
      <ClientContext.Provider value={client}>
        <TimePopover
          label="Send later"
          presets={[]}
          anchor={anchor}
          onClose={() => {}}
          onPick={onPick}
          repeatable
          submitLabel={(at) => (at ? `Schedule for ${at.toDateString()}` : "Schedule message")}
        />
      </ClientContext.Provider>,
    );
    const user = userEvent.setup();
    // Saturday 3 January 2099: every weekday starts on the Monday.
    await chooseTime("2099-01-03", "09:00");
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeat" }), "Every weekday");
    expect(screen.getByRole("button", { name: "Schedule for Mon Jan 05 2099" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2099-01-04" } });
    await user.click(screen.getByRole("button", { name: "Schedule message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an end date on or after the first send.",
    );
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2099-01-31" } });
    await user.click(screen.getByRole("button", { name: "Schedule for Mon Jan 05 2099" }));
    expect(onPick).toHaveBeenCalledWith(
      new Date("2099-01-03T09:00"),
      expect.objectContaining({ every: "weekday", until: "2099-01-31" }),
    );
  });

  it("says why a message with files cannot repeat", () => {
    const { client } = workspace();
    render(
      <ClientContext.Provider value={client}>
        <TimePopover
          label="Send later"
          presets={[]}
          anchor={{ current: document.body }}
          onClose={() => {}}
          onPick={() => {}}
          repeatable="A message with files cannot repeat."
          submitLabel={() => "Schedule message"}
        />
      </ClientContext.Provider>,
    );
    expect(screen.getByRole("combobox", { name: "Repeat" })).toBeDisabled();
    expect(screen.getByText("A message with files cannot repeat.")).toBeVisible();
  });
});

describe("a repeating message in Scheduled", () => {
  const weekdays: RepeatRule = {
    every: "weekday",
    time: "09:00",
    timeZone: deviceZone(),
    until: null,
  };

  it("says how it repeats, and Stop repeating keeps the waiting send without its rule", async () => {
    const user = userEvent.setup();
    const { client } = workspace();
    const waiting: ScheduledMessage = {
      ...scheduledFrom(design.id, { text: "Standup notes", sendAt: Date.now() + 3600_000 }),
      repeat: weekdays,
    };
    vi.spyOn(client.api, "listScheduled").mockResolvedValue({ scheduled: [waiting] });
    const stop = vi
      .spyOn(client.api, "stopRepeating")
      .mockResolvedValue({ scheduled: { ...waiting, repeat: null } });
    render(
      <ClientContext.Provider value={client}>
        <ScheduledPanel onClose={() => {}} onJump={() => {}} />
      </ClientContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Scheduled messages" });
    expect(await within(panel).findByText(/^Every weekday at 9:00/)).toBeVisible();
    await user.click(within(panel).getByRole("button", { name: "Stop repeating" }));
    expect(stop).toHaveBeenCalledWith("S1");
    await waitFor(() => expect(within(panel).queryByText(/^Every weekday/)).toBeNull());
    expect(within(panel).getByText("Standup notes")).toBeVisible();
    expect(within(panel).queryByRole("button", { name: "Stop repeating" })).toBeNull();
  });

  it("names another zone, and the last day", async () => {
    const { client } = workspace();
    const zone = deviceZone() === "Europe/London" ? "Asia/Kolkata" : "Europe/London";
    vi.spyOn(client.api, "listScheduled").mockResolvedValue({
      scheduled: [
        {
          ...scheduledFrom(design.id, { text: "Rent", sendAt: Date.now() + 3600_000 }),
          repeat: {
            every: "month",
            monthDay: 31,
            time: "09:00",
            timeZone: zone,
            until: "2099-12-31",
          },
        },
      ],
    });
    render(
      <ClientContext.Provider value={client}>
        <ScheduledPanel onClose={() => {}} onJump={() => {}} />
      </ClientContext.Provider>,
    );
    const line = await screen.findByText(/^Every month on the 31st at 9:00/);
    expect(line.textContent).toContain(`(${zone.replace("_", " ")})`);
    expect(line.textContent).toMatch(/, until .*2099$/);
  });
});

describe("/remind", () => {
  it("says what it will do, and schedules only once Schedule is pressed", async () => {
    const user = userEvent.setup();
    const { schedule, box } = await renderComposer();
    await user.type(box, "/remind #design Standup notes every weekday at 9am{Enter}");
    const check = await screen.findByRole("group", { name: "Check /remind" });
    expect(check).toHaveTextContent(
      /^Post "Standup notes" in #design every weekday at 9:00.*, starting .*\?Schedule/,
    );
    expect(schedule).not.toHaveBeenCalled();

    await user.click(within(check).getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    const [channelId, body] = schedule.mock.calls[0]!;
    expect(channelId).toBe(design.id);
    expect(body).toMatchObject({
      text: "Standup notes",
      repeat: { every: "weekday", time: "09:00", timeZone: deviceZone(), until: null },
    });
    expect(body.sendAt).toBeGreaterThan(Date.now());
    await waitFor(() => expect(box).toHaveValue(""));
    expect(screen.queryByRole("group", { name: "Check /remind" })).toBeNull();
  });

  it("keeps the words and says what it could not read, and the check goes once the words change", async () => {
    const user = userEvent.setup();
    const { schedule, box } = await renderComposer();
    await user.type(box, "/remind #design hi every fortnight at 9{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      '"every fortnight" is not a repeat /remind knows.',
    );
    expect(box).toHaveValue("/remind #design hi every fortnight at 9");

    await user.clear(box);
    await user.type(box, "/remind #design hi every day at 9{Enter}");
    await screen.findByRole("group", { name: "Check /remind" });
    await user.type(box, "!");
    expect(screen.queryByRole("group", { name: "Check /remind" })).toBeNull();
    expect(schedule).not.toHaveBeenCalled();
  });
});
