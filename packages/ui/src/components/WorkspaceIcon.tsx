import { useState } from "react";
import { initials, workspaceGradient } from "../lib/format.js";

/**
 * A workspace's picture (UX-60): its icon when it has one, and otherwise its
 * own coloured square with its initial, the same one each time. Hidden from
 * screen readers, as the workspace's name is always beside it or on the
 * control that holds it. A picture that will not load shows the square.
 */
export function WorkspaceIcon(props: {
  /** The workspace's name, which the square's colour and letter come from. */
  name: string;
  /** Where the icon is, an object or data URL, when there is one. */
  src?: string | null;
  /** Pixels on a side. */
  size: number;
  /** Its rounding, and the letter's size, as the place it is shown wants. */
  className?: string;
  /** Two initials, as the rail shows, rather than one. */
  letters?: 1 | 2;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const box = { width: props.size, height: props.size };
  if (props.src && broken !== props.src)
    return (
      <img
        src={props.src}
        alt=""
        aria-hidden="true"
        draggable={false}
        width={props.size}
        height={props.size}
        onError={() => setBroken(props.src ?? null)}
        className={`shrink-0 select-none object-cover ${props.className ?? ""}`}
        style={box}
      />
    );
  const letter =
    props.letters === 2 ? initials(props.name) : (Array.from(props.name.trim())[0] ?? "?");
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 select-none items-center justify-center font-semibold text-white ${props.className ?? ""}`}
      style={{ ...box, background: workspaceGradient(props.name) }}
    >
      {letter.toUpperCase()}
    </span>
  );
}
