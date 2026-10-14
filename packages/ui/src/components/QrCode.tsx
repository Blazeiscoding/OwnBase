import { useMemo } from "react";
import { encode } from "uqr";

/** The empty margin round a QR code that scanners need to find it, in modules. */
const QUIET_ZONE = 4;

/**
 * A QR code for a link, drawn as one SVG path. It is dark on white in either
 * theme, because phone cameras look for that, and it is made here, on the
 * device: the link never goes to a service to be drawn.
 */
export function QrCode(props: { value: string; label: string; size?: number }) {
  const { path, extent } = useMemo(() => {
    // M keeps the code readable with up to 15% of it smudged or covered.
    const { data, size } = encode(props.value, { ecc: "M", border: 0 });
    let d = "";
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, extent: size + QUIET_ZONE * 2 };
  }, [props.value]);
  const size = props.size ?? 128;
  return (
    <svg
      role="img"
      aria-label={props.label}
      width={size}
      height={size}
      viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-lg"
    >
      <rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={extent} height={extent} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
