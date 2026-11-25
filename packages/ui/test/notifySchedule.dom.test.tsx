import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { NotifySchedule, User } from "@ownbase/protocol";
import { AccountDialog } from "../src/components/AccountDialog.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { accessibilityProblems } from "./accessibility.js";
import { renderPart, testPlatform, workspaceParts } from "./workspaceParts.js";

/** Notifications → Schedule, and the sidebar's line while it holds them (K12). */

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

const WORK = { from: "09:00", to: "18:00" };
const weekdays: NotifySchedule = {
  kind: "weekdays",
  days: [null, WORK, WORK, WORK, WORK, WORK, null],
};

/** A client on this device's own clock: no zone of the account's. */
function client(schedule: NotifySchedule | null) {
  const made = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  made.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    status: "online",
    workspaceName: "Rocket Team",
    notifySchedule: schedule,
  });
  const save = vi
    .spyOn(made.api, "setNotifySchedule")
    .mockImplementation(async (chosen) => ({ schedule: chosen }));
  return { client: made, save };
}

const timeOf = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the sidebar while the schedule holds notifications", () => {
  it("says when they resume, and turns them on for an hour", async () => {
    // Only the clock is fake, so the pointer still runs on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 20, 0)); // a Monday evening
    const { client: workspace, save } = client(weekdays);
    renderPart(workspace, <Sidebar />);
    const user = userEvent.setup();

    const morning = timeOf(new Date(2026, 10, 24, 9, 0));
    // The line loads lazily, on the first render with a schedule.
    expect(
      await screen.findByText(`Notifications resume tomorrow at ${morning}`),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn on for 1 hour" }));
    expect(save).toHaveBeenCalledWith({ ...weekdays, onUntil: Date.now() + 3_600_000 });
    expect(screen.queryByText(/Notifications resume/)).not.toBeInTheDocument();
  });

  it("says nothing inside the hours, or with no schedule", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 10, 0));
    renderPart(client(weekdays).client, <Sidebar />);
    expect(screen.queryByText(/Notifications resume/)).not.toBeInTheDocument();
  });

  it("says a time today without a day", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 7, 0));
    renderPart(client(weekdays).client, <Sidebar />);
    const nine = timeOf(new Date(2026, 10, 23, 9, 0));
    expect(screen.getByText(`Notifications resume at ${nine}`)).toBeInTheDocument();
  });

  it("leaves the line to a pause while both hold", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 20, 0));
    const { client: workspace } = client(weekdays);
    const paused = { ...sam, dndUntil: Date.now() + 30 * 60_000 };
    workspace.store.setState({ self: paused, users: { [sam.id]: paused } });
    renderPart(workspace, <Sidebar />);
    expect(screen.getByText(/^Paused until/)).toBeInTheDocument();
    expect(screen.queryByText(/Notifications resume/)).not.toBeInTheDocument();
  });
});

function settings(schedule: NotifySchedule | null) {
  const made = client(schedule);
  vi.spyOn(made.client.api, "listSessions").mockResolvedValue({ sessions: [] });
  const parts = workspaceParts(made.client, { shell: { platform: testPlatform("desktop") } });
  render(
    parts.wrap(
      <AccountDialog onClose={() => {}} section="notifications" onSectionChange={() => {}} />,
    ),
  );
  const dialog = screen.getByRole("dialog", { name: "Account settings" });
  const section = within(dialog)
    .getByRole("heading", { name: "Notification schedule" })
    .closest("section")!;
  return { ...made, dialog, section: within(section), user: userEvent.setup() };
}

describe("Notifications → Schedule", () => {
  it("starts at Off, and sets weekdays from 9 to 18 in one choice", async () => {
    const { section, save, user, client: workspace } = settings(null);
    const allow = section.getByRole("combobox", { name: "Schedule" });
    expect(allow).toHaveValue("off");
    expect(section.queryByLabelText("From")).not.toBeInTheDocument();

    await user.selectOptions(allow, "weekdays");
    expect(save).toHaveBeenLastCalledWith(weekdays);
    expect(workspace.state.notifySchedule).toEqual(weekdays);
    expect(section.getByLabelText("From")).toHaveValue("09:00");
    expect(section.getByLabelText("Until")).toHaveValue("18:00");
  });

  it("moves every allowed day's hours together, and keeps them across kinds", async () => {
    const { section, save, user } = settings(weekdays);
    const from = section.getByLabelText("From");
    // jsdom types into a time field a letter at a time; a browser changes it once whole.
    fireEvent.change(from, { target: { value: "08:30" } });
    const early = { from: "08:30", to: "18:00" };
    expect(save).toHaveBeenLastCalledWith({
      kind: "weekdays",
      days: [null, early, early, early, early, early, null],
      onUntil: null,
    });

    await user.selectOptions(section.getByRole("combobox", { name: "Schedule" }), "every-day");
    expect(save).toHaveBeenLastCalledWith({ kind: "every-day", days: Array(7).fill(early) });
  });

  it("sets each day on its own under Custom", async () => {
    const { section, save, user } = settings({ ...weekdays, kind: "custom" });
    expect(section.getByRole("checkbox", { name: "Saturday" })).not.toBeChecked();
    expect(section.getByLabelText("Monday from")).toHaveValue("09:00");

    await user.click(section.getByRole("checkbox", { name: "Saturday" }));
    expect(save.mock.lastCall![0]!.days[6]).toEqual(WORK);
    await user.click(section.getByRole("checkbox", { name: "Monday" }));
    expect(save.mock.lastCall![0]!.days[1]).toBeNull();
  });

  it("keeps one day at least under Custom", async () => {
    const only: NotifySchedule = {
      kind: "custom",
      days: [null, WORK, null, null, null, null, null],
    };
    const { section, save, user } = settings(only);
    await user.click(section.getByRole("checkbox", { name: "Monday" }));
    expect(save).not.toHaveBeenCalled();
    expect(section.getByRole("alert")).toHaveTextContent(
      "Keep at least one day ticked. To stop using a schedule, choose Off.",
    );
  });

  it("says whether the schedule holds notifications now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 20, 0));
    const { section } = settings(weekdays);
    const morning = timeOf(new Date(2026, 10, 24, 9, 0));
    expect(section.getByRole("status")).toHaveTextContent(
      `Paused now by your schedule. Notifications resume tomorrow at ${morning}.`,
    );
  });

  it("says when an hour turned on from the sidebar ends", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 20, 0));
    const { section } = settings({ ...weekdays, onUntil: Date.now() + 3_600_000 });
    const nine = timeOf(new Date(2026, 10, 23, 21, 0));
    expect(section.getByRole("status")).toHaveTextContent(
      `Turned on until ${nine}. After that, your schedule applies again.`,
    );
  });

  it("turns off with Off", async () => {
    const { section, save, user } = settings(weekdays);
    await user.selectOptions(section.getByRole("combobox", { name: "Schedule" }), "off");
    expect(save).toHaveBeenLastCalledWith(null);
  });

  it("has no accessibility problems in either kind of editor", async () => {
    const { dialog } = settings({ ...weekdays, kind: "custom" });
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});
