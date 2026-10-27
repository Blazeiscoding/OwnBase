import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { AuditEntry, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { AuditHistory } from "../src/components/AuditHistory.js";
import { accessibilityProblems } from "./accessibility.js";

const owner: User = {
  id: "U_OWNER",
  handle: "owner",
  displayName: "Workspace Owner",
  role: "owner",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const member: User = { ...owner, id: "U_MEMBER", handle: "member", displayName: "Member" };

const firstEntry: AuditEntry = {
  id: "E_FIRST",
  at: 1_700_000_000_000,
  actorId: owner.id,
  action: "user.deactivated",
  targetType: "user",
  targetId: member.id,
  details: {},
};

const olderEntry: AuditEntry = {
  ...firstEntry,
  id: "E_OLDER",
  at: firstEntry.at - 60_000,
  action: "user.reactivated",
};

type AuditPage = { entries: AuditEntry[]; nextCursor: string | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function history() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: owner,
    users: { [owner.id]: owner, [member.id]: member },
    status: "online",
  });
  render(
    <ClientContext.Provider value={client}>
      <AuditHistory />
    </ClientContext.Provider>,
  );
  return { client, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

describe("Audit history list status", () => {
  it("moves focus from the opener, reports a first-load failure, and retries to a true empty state", async () => {
    const { client, user } = history();
    const firstLoad = deferred<AuditPage>();
    const retryLoad = deferred<AuditPage>();
    const listAudit = vi
      .spyOn(client.api, "listAudit")
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => retryLoad.promise);

    const opener = screen.getByRole("button", { name: "Show recent changes" });
    opener.focus();
    await user.click(opener);
    const region = screen.getByRole("region", { name: "Recent changes" });
    const status = within(region).getByRole("status");
    expect(region).toHaveFocus();
    expect(status).toHaveTextContent("Loading recent changes…");
    expect(within(region).queryByText("Nothing has been changed yet.")).not.toBeInTheDocument();

    await act(async () => firstLoad.reject(new Error("offline")));
    expect(within(region).getByRole("alert")).toHaveTextContent(
      "Could not load recent changes. Check your connection and try again.",
    );
    expect(within(region).queryByText("Nothing has been changed yet.")).not.toBeInTheDocument();

    const retry = within(region).getByRole("button", { name: "Retry" });
    retry.focus();
    await user.keyboard("{Enter}");
    expect(listAudit).toHaveBeenCalledTimes(2);
    expect(listAudit).toHaveBeenNthCalledWith(2, undefined);
    expect(within(region).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Loading recent changes…");
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");

    await act(async () => retryLoad.resolve({ entries: [], nextCursor: null }));
    expect(within(region).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Nothing has been changed yet.");
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
    expect(status.parentElement).toHaveFocus();
    expect(await accessibilityProblems(region)).toEqual([]);
  });

  it("keeps rows and the failed cursor through pagination retry, then safely removes the focused button", async () => {
    const { client, user } = history();
    const failedPage = deferred<AuditPage>();
    const retryPage = deferred<AuditPage>();
    const listAudit = vi
      .spyOn(client.api, "listAudit")
      .mockResolvedValueOnce({ entries: [firstEntry], nextCursor: "PAGE_1" })
      .mockImplementationOnce(() => failedPage.promise)
      .mockImplementationOnce(() => retryPage.promise);

    await user.click(screen.getByRole("button", { name: "Show recent changes" }));
    const region = screen.getByRole("region", { name: "Recent changes" });
    const status = within(region).getByRole("status");
    const showOlder = await within(region).findByRole("button", { name: "Show older changes" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);

    await user.click(showOlder);
    expect(showOlder).toHaveFocus();
    expect(showOlder).toHaveAttribute("aria-disabled", "true");
    expect(status).toHaveTextContent("Loading older changes…");
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);

    await act(async () => failedPage.reject(new Error("offline")));
    expect(within(region).getByRole("alert")).toHaveTextContent(
      "Could not load older changes. Try again.",
    );
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    const retry = within(region).getByRole("button", { name: "Retry older changes" });
    expect(retry).toBe(showOlder);
    expect(retry).toHaveFocus();

    await user.click(retry);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    await user.click(retry);
    expect(listAudit).toHaveBeenCalledTimes(3);
    expect(listAudit).toHaveBeenNthCalledWith(2, "PAGE_1");
    expect(listAudit).toHaveBeenNthCalledWith(3, "PAGE_1");

    await act(async () =>
      retryPage.resolve({ entries: [firstEntry, olderEntry], nextCursor: null }),
    );
    expect(within(region).getByRole("status")).toBe(status);
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(region).queryByRole("button", { name: /older changes/i }),
    ).not.toBeInTheDocument();
    expect(region).toHaveFocus();
    expect(await accessibilityProblems(region)).toEqual([]);
  });
});
