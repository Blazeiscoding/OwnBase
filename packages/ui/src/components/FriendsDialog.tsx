import { useState } from "react";
import type { ID } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { useTabs } from "../lib/useTabs.js";
import { Avatar, PresenceDot } from "./Avatar.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { inputCls } from "./TextField.js";
import { buttonClass } from "./Button.js";
import { EmptyState } from "./EmptyState.js";

const FRIENDS_TABS = ["friends", "requests", "people"] as const;
type FriendsTab = (typeof FRIENDS_TABS)[number];

export function FriendActions({ userId }: { userId: ID }) {
  const client = useClient();
  const relationship = useWorkspace((s) => s.friends.find((f) => f.userId === userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function update(action: "request" | "accept" | "remove") {
    setBusy(true);
    setError("");
    try {
      const result = await client.api.updateFriend(userId, action);
      client.store.setState({ friends: result.friends });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update friendship");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {!relationship && (
          <button
            disabled={busy}
            onClick={() => void update("request")}
            className={buttonClass("secondary", "h-8 px-3 text-[13px]")}
          >
            Add friend
          </button>
        )}
        {relationship?.status === "incoming" && (
          <button
            disabled={busy}
            onClick={() => void update("accept")}
            className={buttonClass("primary", "h-8 px-3 text-[13px]")}
          >
            Accept
          </button>
        )}
        {relationship && (
          <button
            disabled={busy}
            onClick={() => void update("remove")}
            className={buttonClass("quiet", "h-8 px-3 text-[13px]")}
          >
            {relationship.status === "incoming"
              ? "Decline"
              : relationship.status === "outgoing"
                ? "Cancel request"
                : "Remove friend"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function FriendsDialog({
  onClose,
  onOpenProfile,
}: {
  onClose: () => void;
  onOpenProfile: (id: ID) => void;
}) {
  const friends = useWorkspace((s) => s.friends);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const presence = useWorkspace((s) => s.presence);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<FriendsTab>("friends");
  const tabs = useTabs({
    label: "People filters",
    tabs: FRIENDS_TABS,
    selected: tab,
    onSelect: setTab,
  });
  const incoming = friends.filter((f) => f.status === "incoming").length;
  const rows = Object.values(users)
    .filter((u) => {
      if (u.id === selfId || u.isBot || u.deactivated) return false;
      const relation = friends.find((f) => f.userId === u.id);
      if (tab === "friends" && relation?.status !== "accepted") return false;
      if (tab === "requests" && (!relation || relation.status === "accepted")) return false;
      return `${u.displayName} ${u.handle}`.toLowerCase().includes(query.toLowerCase());
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <Dialog title="Friends" onClose={onClose} ownScroll>
      <p className="mb-4 shrink-0 px-6 text-sm text-ink-dim">
        Connect with people in this workspace. Your friends and requests stay on this server.
      </p>
      <div
        {...tabs.listProps}
        className="mx-6 mb-4 flex shrink-0 gap-1 rounded-xl border border-edge bg-deep/40 p-1"
      >
        {FRIENDS_TABS.map((value) => (
          <button
            key={value}
            {...tabs.tabProps(value)}
            className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${tab === value ? "bg-lifted text-ink shadow-[0_1px_2px_rgb(0_0_0/0.2)]" : "text-ink-faint hover:text-ink"}`}
          >
            {value === "friends"
              ? "Friends"
              : value === "requests"
                ? `Requests${incoming ? ` (${incoming})` : ""}`
                : "Add friends"}
          </button>
        ))}
      </div>
      {/* The search stays over the people it narrows, who are all that scrolls. */}
      <div {...tabs.panelProps} className="flex min-h-0 flex-col">
        <div className="shrink-0 px-6 pb-3">
          <input
            aria-label="Find people"
            placeholder="Search by name or handle"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={inputCls}
          />
        </div>
        <DialogScroll>
          <div className="space-y-3">
            {rows.length === 0 && (
              <EmptyState>
                {tab === "friends"
                  ? "No friends yet. Find someone in Add friends to send a request."
                  : tab === "requests"
                    ? "No pending requests."
                    : "No people found."}
              </EmptyState>
            )}
            {rows.map((user) => (
              <div key={user.id} className="card-warm rounded-xl p-3">
                <button
                  onClick={() => onOpenProfile(user.id)}
                  className="mb-3 flex w-full items-center gap-3 text-left"
                >
                  <Avatar user={user} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{user.displayName}</span>
                    <span className="text-xs text-ink-faint">@{user.handle}</span>
                  </span>
                  <PresenceDot
                    online={presence[user.id] === "online"}
                    away={presence[user.id] === "away"}
                  />
                </button>
                {friends.find((f) => f.userId === user.id)?.status === "outgoing" && (
                  <p className="mb-2 text-xs text-ink-faint">Request sent</p>
                )}
                <FriendActions userId={user.id} />
              </div>
            ))}
          </div>
        </DialogScroll>
      </div>
    </Dialog>
  );
}
