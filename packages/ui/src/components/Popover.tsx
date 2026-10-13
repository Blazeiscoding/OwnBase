import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Modal } from "./Modal.js";

/**
 * A small panel that hangs off the control that opened it, such as Send
 * later's choices. Built on the modal layer, like Menu: Escape and a press
 * outside close it, the page beneath waits, and focus goes back to the
 * control. It sits above the control and lines up with its end, or below
 * when there is no room above, and follows it as the page scrolls.
 */
export function Popover(props: {
  /** What a screen reader calls it. */
  label: string;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  align?: "start" | "end";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const place = useRef(() => {});
  place.current = () => {
    const box = props.anchor.current?.getBoundingClientRect();
    const el = panel.current;
    if (!box || !el) {
      close.current();
      return;
    }
    const width = Math.min(props.width ?? 260, window.innerWidth - 16);
    const height = el.offsetHeight;
    const above = box.top - height - 8;
    const top = above >= 8 ? above : Math.min(box.bottom + 8, window.innerHeight - height - 8);
    const left = props.align === "start" ? box.left : box.right - width;
    el.style.width = `${width}px`;
    el.style.top = `${Math.max(8, top)}px`;
    el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
    el.style.transformOrigin = `${props.align === "start" ? "left" : "right"} ${above >= 8 ? "bottom" : "top"}`;
  };
  useLayoutEffect(() => place.current(), []);
  useEffect(() => {
    const handler = () => place.current();
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      document.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, []);
  return (
    <Modal
      title={props.label}
      onClose={props.onClose}
      backdropClassName="bg-transparent"
      className="fixed outline-none"
    >
      <div
        ref={panel}
        className="surface-float fixed max-h-[70vh] animate-menu-in overflow-y-auto rounded-xl outline-none"
      >
        {props.children}
      </div>
    </Modal>
  );
}
