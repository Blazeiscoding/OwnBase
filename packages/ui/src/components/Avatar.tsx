import { useContext, useEffect, useState } from "react";
import type { User } from "@ownbase/protocol";
import { ClientContext } from "../context.js";
import { avatarColor, initials } from "../lib/format.js";

/**
 * Someone's profile picture as an object URL, once the client has fetched it
 * (E9); null while it comes, for someone with none, or with no client.
 */
function usePicture(user: User | undefined): string | null {
  const client = useContext(ClientContext);
  const id = user?.id;
  const version = user?.avatarVersion;
  const [url, setUrl] = useState(() =>
    client && id && version ? client.avatars.peek(id, version) : null,
  );
  useEffect(() => {
    if (!client || !id || !version) {
      setUrl(null);
      return;
    }
    const known = client.avatars.peek(id, version);
    setUrl(known);
    if (known) return;
    let live = true;
    void client.avatars.load(id, version).then((loaded) => {
      if (live) setUrl(loaded);
    });
    return () => {
      live = false;
    };
  }, [client, id, version]);
  return url;
}

/**
 * A person's picture, or their initials on a colour of their own, round as
 * in Discord. Hidden from screen readers: the name is always written beside
 * it, or on the button it sits in, and "M C Maya Chen" says the person twice.
 */
export function Avatar({ user, size = 36 }: { user: User | undefined; size?: number }) {
  const picture = usePicture(user);
  return (
    <div
      aria-hidden="true"
      className="avatar-face flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        background: user ? avatarColor(user.id) : "var(--color-lifted)",
        fontSize: size * 0.38,
      }}
    >
      {picture ? (
        <img
          src={picture}
          alt=""
          decoding="async"
          className="size-full rounded-full object-cover"
        />
      ) : (
        initials(user?.displayName ?? "?")
      )}
    </div>
  );
}

/**
 * Away (E9) as a crescent moon: the dot with a bite out of its upper left, as
 * Discord draws idle. Amber and shaped, so it is never taken for the green
 * online dot, by colour or, for those who cannot tell the two apart, by shape.
 */
function moon(size: number) {
  const bite = Math.round(size * 0.375 * 10) / 10;
  return `radial-gradient(circle at 25% 25%, transparent ${bite}px, #000 ${bite + 0.5}px)`;
}

/**
 * Whether someone is here: a green dot when active, an amber moon when away,
 * and a faint ring when not here.
 */
export function PresenceDot({
  online,
  away = false,
  size = 8,
}: {
  online: boolean;
  away?: boolean;
  size?: number;
}) {
  const moonMask = !online && away ? moon(size) : undefined;
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: online ? "var(--color-online)" : away ? "var(--color-away)" : "transparent",
        border: online || away ? "none" : "1.5px solid var(--color-ink-faint)",
        maskImage: moonMask,
        WebkitMaskImage: moonMask,
      }}
    />
  );
}

/**
 * An avatar with whether the person is here, as a dot cut into its lower
 * right corner, ringed in the surface it sits on.
 */
export function AvatarWithPresence({
  user,
  online,
  away = false,
  size = 32,
  ring = "var(--color-raised)",
}: {
  user: User | undefined;
  online: boolean;
  /** Here but away (E9): the dot is an amber moon rather than green. */
  away?: boolean;
  size?: number;
  /** The colour behind the avatar, so the dot reads as cut out of it. */
  ring?: string;
}) {
  // Dot, ring and overhang all scale with the avatar, so a 20px sidebar
  // avatar gets a 6px dot in a 2px ring rather than a 32px avatar's 10 in 3.
  const dot = Math.max(6, Math.round(size * 0.32));
  const cut = Math.max(2, Math.round(size / 10));
  const overhang = -Math.round(size / 16);
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar user={user} size={size} />
      <span
        className="absolute rounded-full"
        style={{
          width: dot,
          height: dot,
          right: overhang,
          bottom: overhang,
          background: online ? "var(--color-online)" : away ? ring : "var(--color-ink-faint)",
          boxShadow: `0 0 0 ${cut}px ${ring}`,
        }}
      >
        {!online && away && (
          // The moon sits on the ring's colour, so its bite shows what is
          // behind the avatar rather than the picture.
          <span
            className="block h-full w-full rounded-full"
            style={{
              background: "var(--color-away)",
              maskImage: moon(dot),
              WebkitMaskImage: moon(dot),
            }}
          />
        )}
      </span>
    </span>
  );
}
