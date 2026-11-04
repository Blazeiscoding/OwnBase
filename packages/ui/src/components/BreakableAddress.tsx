import { Fragment, type ReactNode } from "react";

/**
 * A web address or link that wraps where people expect it to: after `//`,
 * `/` and `=`, and before each `.`, `?` and `&` (lines already break after a
 * hyphen). Only a part too long for a line of its own breaks inside a word,
 * so a host name or an invite code stays whole.
 */
export function BreakableAddress(props: { text: string }): ReactNode {
  const parts = props.text.split(/(?<=\/)(?!\/)|(?<==)|(?=[.?&])/);
  return (
    <span className="[overflow-wrap:anywhere]">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </span>
  );
}
