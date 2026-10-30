import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, ModalField, ModalView, User } from "@ownbase/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewModal } from "../src/components/ViewModal.js";
import { ClientContext } from "../src/context.js";
import { accessibilityProblems } from "./accessibility.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const view: ModalView = {
  id: "V_1",
  callbackId: "expense",
  title: "File an expense",
  submitLabel: "Submit",
  closeLabel: "Cancel",
  privateMetadata: "",
  text: "",
  fields: [
    {
      blockId: "amount",
      actionId: "value",
      label: "Amount",
      hint: "In euros, without the sign.",
      optional: false,
      type: "text",
      placeholder: "",
      initialValue: "",
      options: [],
    },
    {
      blockId: "reason",
      actionId: "value",
      label: "Reason",
      hint: "",
      optional: true,
      type: "textarea",
      placeholder: "",
      initialValue: "",
      options: [],
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

function renderForm() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, modal: view, status: "online" });
  const submit = vi
    .spyOn(client, "submitModal")
    .mockResolvedValue({ ok: false, errors: { amount: "Enter an amount above zero." } });
  render(
    <ClientContext.Provider value={client}>
      <ViewModal />
    </ClientContext.Provider>,
  );
  return { client, submit, user: userEvent.setup() };
}

describe("an app's form", () => {
  it("ties each field to its hint, and says which fields are needed", async () => {
    renderForm();
    const amount = screen.getByRole("textbox", { name: "Amount" });
    expect(amount).toHaveAccessibleDescription("In euros, without the sign.");
    expect(amount).toHaveAttribute("aria-required", "true");
    expect(amount).not.toHaveAttribute("aria-invalid");
    const reason = screen.getByRole("textbox", { name: /^Reason/ });
    expect(reason).not.toHaveAttribute("aria-describedby");
    expect(reason).toHaveAttribute("aria-required", "false");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });

  it("keeps its buttons in sight under however many fields the app sends", () => {
    renderForm();
    const scroller = screen.getByRole("dialog").querySelector(".dialog-scroll")!;
    expect(scroller).toContainElement(screen.getByRole("textbox", { name: "Amount" }));
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button");
    // Close, and the two that finish the form.
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(scroller).not.toContainElement(button);
  });

  it("keeps two fields apart when their blocks give them the same action id", async () => {
    const { submit, user } = renderForm();
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "12");
    expect(screen.getByRole("textbox", { name: /^Reason/ })).toHaveValue("");
    await user.type(screen.getByRole("textbox", { name: /^Reason/ }), "Team lunch");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledWith(
      {
        amount: { value: "12" },
        reason: { value: "Team lunch" },
      },
      view.id,
    );
  });

  it("marks a field the app refused, reads its error with it, and takes somebody there", async () => {
    const { submit, user } = renderForm();
    await user.click(screen.getByRole("textbox", { name: /^Reason/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledOnce();
    const amount = screen.getByRole("textbox", { name: "Amount" });
    expect(await screen.findByText("Enter an amount above zero.")).toBeVisible();
    expect(amount).toHaveAttribute("aria-invalid", "true");
    // The error replaces the hint, as it does on screen.
    expect(amount).toHaveAccessibleDescription("Enter an amount above zero.");
    expect(amount).toHaveFocus();
    expect(screen.getByRole("textbox", { name: /^Reason/ })).not.toHaveAttribute("aria-invalid");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });

  it("starts each replacement view with its own answers and sends only those", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: sam, users: { [sam.id]: sam }, modal: view, status: "online" });
    const submit = vi.spyOn(client.api, "submitView").mockResolvedValue({ ok: true });
    render(
      <ClientContext.Provider value={client}>
        <ViewModal />
      </ClientContext.Provider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "Private answer for app A");
    const next = {
      ...view,
      id: "V_APP_B",
      title: "Another app",
      fields: view.fields.map((field) => ({
        ...field,
        initialValue: field.blockId === "amount" ? "B's default" : "",
      })),
    };
    act(() => client.store.setState({ modal: next }));
    expect(screen.getByRole("dialog", { name: "Another app" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue("B's default");
    await user.clear(screen.getByRole("textbox", { name: "Amount" }));
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "Answer for B");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledWith("V_APP_B", {
      amount: { value: "Answer for B" },
      reason: { value: "" },
    });
    expect(client.state.modal).toBeNull();
  });

  it.each(["success", "refusal", "failure"])(
    "ignores an old %s after cancel and a new view",
    async (outcome) => {
      const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
      client.store.setState({ self: sam, users: { [sam.id]: sam }, modal: view, status: "online" });
      let resolve!: (result: { ok: boolean; errors?: Record<string, string> }) => void;
      let reject!: (error: Error) => void;
      vi.spyOn(client.api, "submitView").mockReturnValueOnce(
        new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        }),
      );
      render(
        <ClientContext.Provider value={client}>
          <ViewModal />
        </ClientContext.Provider>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Submit" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      act(() => client.store.setState({ modal: { ...view, id: "V_NEXT", title: "New form" } }));
      await user.type(screen.getByRole("textbox", { name: "Amount" }), "new unsaved words");
      const currentBox = screen.getByRole("textbox", { name: "Amount" });
      expect(currentBox).toHaveFocus();
      await act(async () => {
        if (outcome === "failure") reject(new Error("lost old response"));
        else
          resolve(
            outcome === "success"
              ? { ok: true }
              : { ok: false, errors: { amount: "Old app's rejection" } },
          );
      });
      expect(screen.getByRole("dialog", { name: "New form" })).toBeVisible();
      expect(currentBox).toHaveValue("new unsaved words");
      expect(currentBox).toHaveFocus();
      expect(currentBox).not.toHaveAttribute("aria-invalid");
      expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(client.state.modal?.id).toBe("V_NEXT");
    },
  );

  it("keeps a cancelled form's answers out of the next opening of the same app", async () => {
    const { client, user } = renderForm();
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "Discarded words");
    // Production cancellation unmounts the form; a fresh view from the same app
    // has a distinct view ID, even when every field and callback is the same.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => client.store.setState({ modal: { ...view, id: "V_SAME_APP_NEW" } }));
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue("");
  });

  it("dispatches one submission while its response is pending, then permits correction", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: sam, modal: view, status: "online" });
    let finish!: (result: { ok: boolean }) => void;
    const submit = vi
      .spyOn(client.api, "submitView")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValue({ ok: true });
    render(
      <ClientContext.Provider value={client}>
        <ViewModal />
      </ClientContext.Provider>,
    );
    const form = screen.getByRole("button", { name: "Submit" }).closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(submit).toHaveBeenCalledOnce();
    await act(async () => finish({ ok: false }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    fireEvent.submit(form);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  });
});

describe("an app's form with choices", () => {
  const person = (id: string, displayName: string, extra: Partial<User> = {}): User => ({
    ...sam,
    id,
    handle: displayName.toLowerCase().replace(/\s+/g, ""),
    displayName,
    ...extra,
  });
  const people = [
    sam,
    person("U_ADA", "Ada Lovelace"),
    person("U_BEN", "Ben Okafor"),
    person("U_CY", "Cy Tran"),
    person("U_DEE", "Dee Ahmed"),
    person("U_EVE", "Eve Moreau"),
    person("U_FIN", "Fin Walsh"),
    person("U_GONE", "Gone Person", { deactivated: true }),
    person("U_BOT", "Deploy Bot", { isBot: true }),
  ];
  const room = (id: string, type: Channel["type"], name: string, extra: Partial<Channel> = {}) =>
    ({
      id,
      type,
      name,
      topic: "",
      description: "",
      creatorId: sam.id,
      archived: false,
      createdAt: 0,
      ...extra,
    }) satisfies Channel;
  const rooms = [
    room("C_GENERAL", "public", "general"),
    room("C_OPS", "private", "ops"),
    room("C_OLD", "public", "old-news", { archived: true }),
    room("D_ADA", "dm", "", { memberIds: [sam.id, "U_ADA"] }),
  ];
  const field = (blockId: string, extra: Partial<ModalField>): ModalField => ({
    blockId,
    actionId: "value",
    label: blockId,
    hint: "",
    optional: false,
    type: "text",
    placeholder: "",
    initialValue: "",
    options: [],
    ...extra,
  });
  const choices: ModalView = {
    ...view,
    id: "V_CHOICES",
    fields: [
      field("checks", {
        label: "Before shipping",
        type: "checkboxes",
        options: [
          { text: "Tests pass", value: "tests", description: "On the main branch" },
          { text: "Notes written", value: "notes" },
        ],
        initialValues: ["tests"],
      }),
      field("size", {
        label: "Size",
        type: "radio",
        options: [
          { text: "Small", value: "s" },
          { text: "Large", value: "l" },
        ],
        initialValue: "l",
      }),
      field("owner", { label: "Owner", type: "user", initialValue: "U_NOT_HERE" }),
      field("reviewers", { label: "Reviewers", type: "users", maxSelected: 2, optional: true }),
      field("where", { label: "Where", type: "conversation", initialValue: "C_GENERAL" }),
      field("room", { label: "Room", type: "channel" }),
      field("day", { label: "Day", type: "date", initialValue: "2026-11-02" }),
      field("at", { label: "Time", type: "time" }),
    ],
  };

  function renderChoices(form: ModalView = choices) {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({
      self: sam,
      users: Object.fromEntries(people.map((u) => [u.id, u])),
      channels: Object.fromEntries(rooms.map((c) => [c.id, c])),
      modal: form,
      status: "online",
    });
    const submit = vi.spyOn(client, "submitModal").mockResolvedValue({ ok: true });
    render(
      <ClientContext.Provider value={client}>
        <ViewModal />
      </ClientContext.Provider>,
    );
    return { client, submit, user: userEvent.setup() };
  }

  it("draws each kind as a control that names itself", async () => {
    renderChoices();
    const checks = screen.getByRole("group", { name: "Before shipping" });
    expect(within(checks).getByRole("checkbox", { name: /Tests pass/ })).toBeChecked();
    expect(within(checks).getByText("On the main branch")).toBeVisible();
    const size = screen.getByRole("radiogroup", { name: "Size" });
    expect(within(size).getByRole("radio", { name: "Large" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Owner" })).toBeVisible();
    expect(screen.getByRole("group", { name: /^Reviewers/ })).toBeVisible();
    expect(screen.getByLabelText("Day")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Day")).toHaveValue("2026-11-02");
    expect(screen.getByLabelText("Time")).toHaveAttribute("type", "time");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });

  it("offers the people and conversations this account can see, and no one gone", () => {
    renderChoices();
    const owner = screen.getByRole("combobox", { name: "Owner" });
    const named = within(owner)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(named).toContain("Ada Lovelace");
    expect(named).not.toContain("Gone Person");
    expect(named).not.toContain("Deploy Bot");
    const where = within(screen.getByRole("combobox", { name: "Where" }))
      .getAllByRole("option")
      .map((o) => o.textContent);
    // A DM is named by who it is with; an archived channel is not offered.
    expect(where).toEqual(["Choose a conversation…", "#general", "#ops", "Ada Lovelace"]);
    const room = within(screen.getByRole("combobox", { name: "Room" }))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(room).toEqual(["Choose a channel…", "#general"]);
  });

  it("sends lists for the list kinds, and leaves out a starting choice it cannot show", async () => {
    const { submit, user } = renderChoices();
    // The app started Owner on someone this account cannot see.
    expect(screen.getByRole("combobox", { name: "Owner" })).toHaveValue("");
    await user.selectOptions(screen.getByRole("combobox", { name: "Owner" }), "U_BEN");
    await user.click(screen.getByRole("checkbox", { name: "Notes written" }));
    await user.click(screen.getByRole("radio", { name: "Small" }));
    await user.click(screen.getByRole("checkbox", { name: "Ada Lovelace" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Room" }), "C_GENERAL");
    await user.type(screen.getByLabelText("Time"), "14:30");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledWith(
      {
        checks: { value: ["tests", "notes"] },
        size: { value: "s" },
        owner: { value: "U_BEN" },
        reviewers: { value: ["U_ADA"] },
        where: { value: "C_GENERAL" },
        room: { value: "C_GENERAL" },
        day: { value: "2026-11-02" },
        at: { value: "14:30" },
      },
      choices.id,
    );
  });

  it("stops at the app's limit until a choice is taken back", async () => {
    const { user } = renderChoices();
    const reviewers = screen.getByRole("group", { name: /^Reviewers/ });
    await user.click(within(reviewers).getByRole("checkbox", { name: "Ada Lovelace" }));
    await user.click(within(reviewers).getByRole("checkbox", { name: "Ben Okafor" }));
    expect(within(reviewers).getByText("2 of up to 2 chosen")).toBeVisible();
    expect(within(reviewers).getByRole("checkbox", { name: "Cy Tran" })).toBeDisabled();
    await user.click(within(reviewers).getByRole("checkbox", { name: "Ada Lovelace" }));
    expect(within(reviewers).getByRole("checkbox", { name: "Cy Tran" })).toBeEnabled();
  });

  it("narrows a long list, keeping what is chosen in sight", async () => {
    const { user } = renderChoices();
    const reviewers = screen.getByRole("group", { name: /^Reviewers/ });
    await user.click(within(reviewers).getByRole("checkbox", { name: "Fin Walsh" }));
    await user.type(within(reviewers).getByRole("searchbox", { name: "Search Reviewers" }), "ada");
    expect(within(reviewers).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(reviewers).getByRole("checkbox", { name: "Ada Lovelace" })).not.toBeChecked();
    expect(within(reviewers).getByRole("checkbox", { name: "Fin Walsh" })).toBeChecked();
  });

  it("takes somebody to a group the app refused, and reads why", async () => {
    const { client, user } = renderChoices();
    vi.spyOn(client, "submitModal").mockResolvedValue({
      ok: false,
      errors: { checks: "Tick both before shipping." },
    });
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const checks = screen.getByRole("group", { name: "Before shipping" });
    expect(checks).toHaveAccessibleDescription("Tick both before shipping.");
    expect(within(checks).getByRole("checkbox", { name: /Tests pass/ })).toHaveFocus();
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });
});

describe("a stack of app forms", () => {
  const confirm: ModalView = {
    ...view,
    id: "V_CONFIRM",
    title: "Are you sure?",
    fields: [{ ...view.fields[0]!, blockId: "confirm", label: "Type yes", hint: "" }],
  };

  function renderStack() {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: sam, users: { [sam.id]: sam }, modal: view, status: "online" });
    const closeView = vi.spyOn(client.api, "closeView").mockResolvedValue({ ok: true });
    render(
      <ClientContext.Provider value={client}>
        <ViewModal />
      </ClientContext.Provider>,
    );
    return { client, closeView, user: userEvent.setup() };
  }

  it("goes back to the form under it, as it was left", async () => {
    const { client, closeView, user } = renderStack();
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "42");
    // The app stacked a second form on the first.
    act(() => client.store.setState({ modal: confirm, modalsBelow: [view] }));
    expect(screen.getByRole("dialog", { name: "Are you sure?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel, back to File an expense" }));
    expect(screen.getByRole("dialog", { name: "File an expense" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue("42");
    // The server is told, so the person's other devices go back too.
    expect(closeView).toHaveBeenCalledWith("V_CONFIRM");
    expect(client.state.modalsBelow).toEqual([]);
  });

  it("names a close button the app already called Back once", () => {
    const { client } = renderStack();
    act(() =>
      client.store.setState({ modal: { ...confirm, closeLabel: "Back" }, modalsBelow: [view] }),
    );
    expect(screen.getByRole("button", { name: "Back to File an expense" })).toBeVisible();
  });

  it("closes every form in the stack from the dialog's own close", async () => {
    const { client, closeView, user } = renderStack();
    act(() => client.store.setState({ modal: confirm, modalsBelow: [view] }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.state.modal).toBeNull();
    expect(closeView).toHaveBeenCalledWith(view.id);
  });

  it("keeps what was typed when the app changes the form, dropping what it refused", async () => {
    const { client, user } = renderStack();
    vi.spyOn(client, "submitModal").mockResolvedValue({
      ok: false,
      errors: { amount: "Enter an amount above zero." },
    });
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "12");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Enter an amount above zero.")).toBeVisible();
    act(() =>
      client.store.setState({ modal: { ...view, title: "File an expense (EUR)", hash: "h2" } }),
    );
    expect(screen.getByRole("dialog", { name: "File an expense (EUR)" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue("12");
    expect(screen.queryByText("Enter an amount above zero.")).toBeNull();
  });

  it("shows a form of text alone with nothing to submit", async () => {
    const { client } = renderStack();
    act(() =>
      client.store.setState({
        modal: { ...view, id: "V_LOADING", text: "Loading…", fields: [], submitLabel: "" },
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "File an expense" });
    expect(within(dialog).getByText("Loading…")).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Submit" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});
