import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { ModalView, User } from "@slackoss/protocol";
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
