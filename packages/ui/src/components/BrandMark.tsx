import brandMark from "./brandMark.json";

/**
 * The app icon, the cabin on its 32-pixel grid, the same in both themes. Its
 * pixels come from scripts/icon-art.mjs; at 32 or 64 every one is whole.
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className="shrink-0"
    >
      {brandMark.map(([fill, d]) => (
        <path key={fill} fill={fill} d={d} />
      ))}
    </svg>
  );
}
