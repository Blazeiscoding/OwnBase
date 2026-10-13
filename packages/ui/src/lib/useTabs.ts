import { useId } from "react";
import type React from "react";
import { stepIn } from "../components/Motion.js";

/** Whether the arrow keys, Home or End chose a tab, or a click (Enter and Space click a button). */
export type TabChoice = "key" | "click";

/**
 * A row of tabs, as the WAI-ARIA tabs pattern has them. The row is a named
 * tablist with exactly one tab selected, and only that tab is in the Tab order,
 * so the row is one Tab stop. Left and Right move to the previous and next tab,
 * wrapping at either end, and Home and End go to the first and last. A key held
 * with Alt, Ctrl or Meta is left alone, so Alt+Left still goes Back.
 *
 * Selection follows focus: moving to a tab shows its panel at once. The pattern
 * recommends that when a panel shows without a wait, and every panel here does,
 * or says it is loading.
 *
 * There is one panel, whose content changes with the selected tab. Every tab
 * names it in `aria-controls`, and it takes its name from the selected tab.
 */
export function useTabs<T extends string>({
  label,
  tabs,
  selected,
  onSelect,
}: {
  label: string;
  tabs: readonly T[];
  selected: T;
  /** Called only when a different tab is chosen. */
  onSelect: (tab: T, how: TabChoice) => void;
}) {
  const id = useId();
  const tabId = (tab: T) => `${id}-tab-${tab}`;
  const panelId = `${id}-panel`;
  const choose = (tab: T, how: TabChoice) => {
    if (tab === selected) return;
    onSelect(tab, how);
    // The panel steps in from the side of the tab chosen.
    stepIn(document.getElementById(panelId), tabs.indexOf(tab) - tabs.indexOf(selected));
  };

  return {
    listProps: { role: "tablist" as const, "aria-label": label },
    tabProps: (tab: T) => ({
      id: tabId(tab),
      type: "button" as const,
      role: "tab" as const,
      "aria-selected": tab === selected,
      "aria-controls": panelId,
      tabIndex: tab === selected ? 0 : -1,
      onClick: () => choose(tab, "click"),
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const next = tabAfter(tabs, tab, event.key);
        if (next === null) return;
        event.preventDefault();
        choose(next, "key");
        document.getElementById(tabId(next))?.focus();
      },
    }),
    panelProps: { id: panelId, role: "tabpanel" as const, "aria-labelledby": tabId(selected) },
  };
}

/** The tab a key moves to from `tab`, or null for a key that tabs leave alone. */
function tabAfter<T>(tabs: readonly T[], tab: T, key: string): T | null {
  const at = tabs.indexOf(tab);
  if (key === "ArrowRight") return tabs[(at + 1) % tabs.length]!;
  if (key === "ArrowLeft") return tabs[(at + tabs.length - 1) % tabs.length]!;
  if (key === "Home") return tabs[0]!;
  if (key === "End") return tabs[tabs.length - 1]!;
  return null;
}
