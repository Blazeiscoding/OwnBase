import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKeyed } from "../src/lib/useKeyed.js";

describe("a value kept while its key is the same", () => {
  it("keeps the first value until the key changes, and makes a new one only then", () => {
    const make = vi.fn((ids: string[]) => ids);
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useKeyed(ids.join(" "), () => make(ids)),
      { initialProps: { ids: ["U1", "U2"] } },
    );
    const first = result.current;
    rerender({ ids: ["U1", "U2"] });
    expect(result.current).toBe(first);
    expect(make).toHaveBeenCalledTimes(1);

    const other = ["U1", "U3"];
    rerender({ ids: other });
    expect(result.current).toBe(other);
    expect(make).toHaveBeenCalledTimes(2);
    rerender({ ids: ["U1", "U3"] });
    expect(result.current).toBe(other);
  });
});
