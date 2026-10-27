import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient, type AppDetail } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { AppsDialog } from "../src/components/AppsDialog.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { GuestAccountDialog } from "../src/components/dialogs.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Forms that used to grey out their button until something was typed. Now
 * the button always works: sent empty, the form says what is missing under
 * each field and puts the cursor in the first one.
 */
const person = (id: string, handle: string, role: User["role"]): User => ({
  id,
  handle,
  displayName: handle,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

function workspace(self: User) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self, users: { [self.id]: self }, status: "online" });
  return client;
}

/** A field's error line, found through the field rather than by its words. */
function problemOf(field: HTMLElement): string {
  return field.getAttribute("aria-invalid") === "true"
    ? (document.getElementById(field.getAttribute("aria-describedby")!.split(" ")[0]!)
        ?.textContent ?? "")
    : "";
}

describe("a guest creating an account", () => {
  function open() {
    const client = workspace(person("U_GUEST", "guest-1", "guest"));
    const create = vi.spyOn(client.api, "createAccountFromGuest");
    const onCreated = vi.fn();
    render(
      <ClientContext.Provider value={client}>
        <GuestAccountDialog onClose={() => {}} onCreated={onCreated} />
      </ClientContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Create an account" });
    return {
      dialog,
      create,
      onCreated,
      username: within(dialog).getByLabelText("Username"),
      password: within(dialog).getByLabelText("Password"),
      submit: within(dialog).getByRole("button", { name: "Create account" }),
    };
  }

  it("says what is missing beside each field and goes to the first, then creates the account", async () => {
    const user = userEvent.setup();
    const { dialog, create, onCreated, username, password, submit } = open();
    create.mockResolvedValue({
      token: "test-session-not-a-credential",
      user: person("U_GUEST", "vic", "member"),
    });
    expect(username).toHaveAccessibleDescription(
      "Lowercase letters and numbers, such as maya or sam.r",
    );
    expect(submit).toBeEnabled();
    expect(submit).not.toHaveAttribute("aria-disabled");

    await user.click(submit);
    expect(create).not.toHaveBeenCalled();
    expect(username).toHaveFocus();
    expect(username).toHaveAttribute("aria-invalid", "true");
    expect(problemOf(username)).toBe("Choose a username.");
    expect(problemOf(password)).toBe("Choose a password.");
    expect(await accessibilityProblems(dialog)).toEqual([]);

    // Typing in a field takes its complaint away; the other's stays until sent again.
    await user.type(username, "Vic");
    expect(username).not.toHaveAttribute("aria-invalid");
    expect(problemOf(password)).toBe("Choose a password.");
    await user.type(password, "short{Enter}");
    expect(password).toHaveFocus();
    expect(problemOf(password)).toBe("Use at least 8 characters for the password.");
    expect(create).not.toHaveBeenCalled();

    await user.type(password, "-and-longer");
    await user.click(submit);
    expect(create).toHaveBeenCalledWith({ handle: "vic", password: "short-and-longer" });
    expect(onCreated).toHaveBeenCalledWith("test-session-not-a-credential", "vic");
  });

  it("says a username the server will not take beside the username", async () => {
    const user = userEvent.setup();
    const { create, username, password, submit } = open();
    await user.type(username, "-vic");
    await user.type(password, "password123");
    await user.click(submit);
    expect(username).toHaveFocus();
    expect(problemOf(username)).toBe(
      "Usernames are 2 to 32 lowercase letters or numbers, and may use . _ or -.",
    );
    expect(create).not.toHaveBeenCalled();

    create.mockRejectedValue(new ApiError(409, "handle_taken"));
    await user.clear(username);
    await user.type(username, "sam");
    await user.click(submit);
    expect(username).toHaveFocus();
    expect(problemOf(username)).toBe("That username is taken. Choose another.");
    expect(username).toHaveValue("sam");
    expect(submit).toBeEnabled();
  });
});

describe("an app's forms", () => {
  const deployBot: AppDetail = {
    id: "A_DEPLOY",
    name: "Deploy Bot",
    botUserId: "U_DEPLOY",
    createdBy: "U_SAM",
    createdAt: 0,
    interactivityUrl: "",
    signingSecret: "test-signing-secret-not-a-credential",
    webhooks: [],
    commands: [],
    subscriptions: [],
  };

  async function open() {
    const client = workspace(person("U_SAM", "sam", "owner"));
    vi.spyOn(client.api, "listApps").mockResolvedValue({ apps: [deployBot] });
    vi.spyOn(client, "loadCommands").mockResolvedValue(undefined);
    render(
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <AppsDialog onClose={() => {}} />
        </ClientContext.Provider>
      </ConfirmProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Apps and integrations" });
    await within(dialog).findByText("Deploy Bot", { selector: "span" });
    return { client, dialog };
  }

  it("asks for a command and its address before adding it", async () => {
    const user = userEvent.setup();
    const { client, dialog } = await open();
    const createCommand = vi.spyOn(client.api, "createCommand").mockResolvedValue({
      command: {
        id: "SC_DEPLOY",
        appId: "A_DEPLOY",
        command: "deploy",
        url: "https://bot.example.com/deploy",
        description: "",
        usageHint: "",
      },
    } as Awaited<ReturnType<typeof client.api.createCommand>>);
    const section = within(dialog).getByRole("group", { name: "Slash commands" });
    const command = within(section).getByLabelText("Command");
    const url = within(section).getByLabelText("Request URL");
    const add = within(section).getByRole("button", { name: "Add" });
    expect(add).toBeEnabled();

    await user.click(add);
    expect(createCommand).not.toHaveBeenCalled();
    expect(command).toHaveFocus();
    expect(problemOf(command)).toBe("Name the command, such as /deploy.");
    expect(problemOf(url)).toBe("Give the address your service answers on.");
    expect(await accessibilityProblems(section)).toEqual([]);

    await user.type(command, "/deploy");
    await user.click(add);
    expect(url).toHaveFocus();
    expect(problemOf(command)).toBe("");
    await user.type(url, "https://bot.example.com/deploy{Enter}");
    expect(createCommand).toHaveBeenCalledWith("A_DEPLOY", {
      command: "/deploy",
      url: "https://bot.example.com/deploy",
      description: "",
    });
    expect(command).toHaveValue("");
  });

  it("asks for the address events go to, and says there why the server refused it", async () => {
    const user = userEvent.setup();
    const { client, dialog } = await open();
    const subscribe = vi
      .spyOn(client.api, "createSubscription")
      .mockRejectedValueOnce(
        new ApiError(400, "url_verification_failed", "the URL did not answer the challenge"),
      )
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof client.api.createSubscription>>);
    const section = within(dialog).getByRole("group", { name: "Event subscriptions" });
    const url = within(section).getByLabelText("Request URL");
    const button = within(section).getByRole("button", { name: "Subscribe" });

    await user.click(button);
    expect(subscribe).not.toHaveBeenCalled();
    expect(url).toHaveFocus();
    expect(problemOf(url)).toBe("Give the address that receives events.");

    await user.type(url, "https://bot.example.com/events");
    await user.click(button);
    expect(subscribe).toHaveBeenCalledWith("A_DEPLOY", {
      url: "https://bot.example.com/events",
      eventTypes: [],
    });
    expect(await within(section).findByText("The URL did not answer the challenge.")).toBeVisible();
    expect(url).toHaveFocus();
    expect(url).toHaveAttribute("aria-invalid", "true");

    await user.click(button);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(url).toHaveValue("");
    expect(url).not.toHaveAttribute("aria-invalid");
  });

  it("saves the interactivity address whether or not it changed, and says it did", async () => {
    const user = userEvent.setup();
    const { client, dialog } = await open();
    const save = vi
      .spyOn(client.api, "setInteractivityUrl")
      .mockResolvedValueOnce({ app: deployBot })
      .mockRejectedValueOnce(new ApiError(400, "url_verification_failed", "no answer"))
      .mockResolvedValueOnce({ app: deployBot });
    const section = within(dialog).getByRole("group", { name: "Interactivity" });
    const url = within(section).getByLabelText("Request URL");
    const button = within(section).getByRole("button", { name: "Save" });

    // Left empty, saving turns buttons off: nothing is missing, so it is never refused here.
    expect(button).toBeEnabled();
    await user.click(button);
    expect(save).toHaveBeenLastCalledWith("A_DEPLOY", "");
    expect(await within(section).findByText("Saved. Buttons are off.")).toBeVisible();

    await user.type(url, "https://bot.example.com/interactions");
    expect(within(section).queryByText("Saved. Buttons are off.")).toBeNull();
    await user.click(button);
    expect(await within(section).findByText("No answer.")).toBeVisible();
    expect(url).toHaveFocus();
    expect(url).toHaveAttribute("aria-invalid", "true");

    await user.click(button);
    expect(save).toHaveBeenLastCalledWith("A_DEPLOY", "https://bot.example.com/interactions");
    expect(await within(section).findByText("Saved and verified.")).toBeVisible();
    expect(url).not.toHaveAttribute("aria-invalid");
  });
});
