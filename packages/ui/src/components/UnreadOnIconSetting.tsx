import { settingMark } from "../lib/accountSections.js";
import { useUnreadOnIcon } from "../lib/unreadOnIcon.js";

/**
 * The switch for showing unread outside the window (J16): a number or a dot
 * on the app's icon, the tray and the tab's title. On this device only.
 */
export function UnreadOnIconSetting() {
  const { show, setShow } = useUnreadOnIcon();
  return (
    <section
      {...settingMark("unread-on-icon")}
      aria-labelledby="account-unread-icon-title"
      className="mt-6 border-t border-edge pt-5"
    >
      <h3 id="account-unread-icon-title" className="font-semibold">
        Outside the window
      </h3>
      <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-copper">
        <input
          type="checkbox"
          role="switch"
          className="sr-only"
          checked={show}
          onChange={(event) => setShow(event.target.checked)}
        />
        <span
          aria-hidden="true"
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            show ? "border-copper bg-copper" : "border-edge bg-deep/40"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 size-3.5 rounded-full transition-transform ${
              show ? "translate-x-4 bg-ground" : "bg-ink-faint"
            }`}
          />
        </span>
        Show unread on the app&apos;s icon
      </label>
      <p className="mt-1 text-sm text-ink-dim">
        How many mentions wait, or a dot for other unread messages, on the app&apos;s icon, the tray
        and the tab&apos;s title. Never a name or what was said. On this device.
      </p>
    </section>
  );
}
