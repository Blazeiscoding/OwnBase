import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Badge } from "../components/Badge.js";
import { Button, buttonClass, type ButtonVariant } from "../components/Button.js";
import { Dialog } from "../components/Dialog.js";
import { EmptyState } from "../components/EmptyState.js";
import { Icon } from "../components/Icon.js";
import { IconButton } from "../components/IconButton.js";
import { Kbd } from "../components/Kbd.js";
import { ListStatus } from "../components/ListStatus.js";
import { Menu } from "../components/Menu.js";
import { Popover } from "../components/Popover.js";
import { Select } from "../components/Select.js";
import { Sheet, sheetCard } from "../components/Sheet.js";
import { TextField } from "../components/TextField.js";
import { ToastProvider, useToast } from "../components/Toast.js";
import { Tooltip } from "../components/Tooltip.js";
import { modKey } from "../lib/shortcuts.js";

/**
 * The primitives gallery, for development only: `#/gallery` shows Onyx and
 * White side by side, `#/gallery/onyx` and `#/gallery/white` one each. The
 * web client's entry loads this module only when `import.meta.env.DEV` is
 * true, so a build leaves it out entirely.
 */

type Theme = "onyx" | "white";

/** Which view an address asks for, or null when it is not the gallery's. */
export function galleryView(hash: string): Theme | "both" | null {
  const path = hash.replace(/^#\/?/, "").replace(/\/$/, "");
  if (path === "gallery") return "both";
  if (path === "gallery/onyx") return "onyx";
  if (path === "gallery/white") return "white";
  return null;
}

export function Gallery() {
  const [view, setView] = useState(() => galleryView(window.location.hash));
  useEffect(() => {
    const onHash = () => {
      const next = galleryView(window.location.hash);
      // Leaving the gallery: the client starts afresh, as it would from the address.
      if (next === null) window.location.reload();
      else setView(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (view === null) return null;
  return view === "both" ? <BothThemes /> : <ThemeSheet key={view} theme={view} />;
}

const THEME_NAMES: Record<Theme, string> = { onyx: "Onyx", white: "White" };

/** Each theme in a frame of its own, since a theme belongs to the whole document. */
function BothThemes() {
  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto max-w-[1440px] px-4 pb-8 pt-6 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">OwnBase primitives gallery</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-dim">
          Development only. Every shared control in its states, in both themes. Point at a control
          or Tab to it to see its hover and focus. One theme alone:{" "}
          <a className="font-medium text-ink underline" href="#/gallery/onyx">
            Onyx
          </a>{" "}
          or{" "}
          <a className="font-medium text-ink underline" href="#/gallery/white">
            White
          </a>
          .
        </p>
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          <ThemeFrame theme="onyx" />
          <ThemeFrame theme="white" />
        </div>
      </main>
    </div>
  );
}

interface FrameHeight {
  ownBaseGallery: Theme;
  height: number;
}

function isFrameHeight(data: unknown): data is FrameHeight {
  const value = data as FrameHeight | null;
  return typeof value?.ownBaseGallery === "string" && typeof value.height === "number";
}

/** A theme's sheet, as tall as what is in it, so the page scrolls rather than the frame. */
function ThemeFrame({ theme }: { theme: Theme }) {
  const [height, setHeight] = useState(900);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !isFrameHeight(event.data)) return;
      if (event.data.ownBaseGallery === theme) setHeight(event.data.height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [theme]);
  return (
    <section aria-label={THEME_NAMES[theme]}>
      <h2 className="mb-2 text-[13px] font-semibold text-ink-dim">{THEME_NAMES[theme]}</h2>
      <iframe
        title={`${THEME_NAMES[theme]} primitives`}
        src={`${window.location.pathname}${window.location.search}#/gallery/${theme}`}
        style={{ height }}
        className="block w-full rounded-xl border border-edge"
      />
    </section>
  );
}

/** Every specimen, in one theme, which it sets on the document while it is shown. */
function ThemeSheet({ theme }: { theme: Theme }) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = theme === "white" ? "light" : "dark";
    return () => {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    };
  }, [theme]);
  // In a frame of the side-by-side view, tell it how tall to be.
  useEffect(() => {
    const element = content.current;
    if (!element || window.parent === window || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const message: FrameHeight = { ownBaseGallery: theme, height: element.offsetHeight };
      window.parent.postMessage(message, window.location.origin);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [theme]);
  const framed = window.parent !== window;

  return (
    <ToastProvider>
      <div className="h-full overflow-y-auto bg-ground">
        <div ref={content} data-gallery-sheet={theme}>
          <main className="mx-auto max-w-3xl space-y-10 px-4 pb-24 pt-6 sm:px-6">
            {!framed && (
              <header>
                <h1 className="text-2xl font-semibold tracking-tight">
                  OwnBase primitives gallery: {THEME_NAMES[theme]}
                </h1>
                <p className="mt-1 text-sm text-ink-dim">
                  Development only. Point at a control or Tab to it to see its hover and focus.{" "}
                  <a className="font-medium text-ink underline" href="#/gallery">
                    Both themes
                  </a>
                </p>
              </header>
            )}
            <Buttons />
            <IconButtons />
            <TextFields />
            <Selects />
            <CheckedForm />
            <Keys />
            <Badges />
            <Tooltips />
            <Menus />
            <Sheets />
            <Popovers />
            <Toasts />
            <EmptyStates />
            <ListStatuses />
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}

function Section(props: { title: string; about: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-[17px] font-semibold tracking-tight">
        {props.title}
      </h2>
      <p className="mt-1 text-[13px] text-ink-dim">{props.about}</p>
      <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-4 rounded-xl border border-edge bg-raised p-4">
        {props.children}
      </div>
    </section>
  );
}

/** One state of a primitive, named under it. */
function Specimen({ name, children, wide }: { name: string; children: ReactNode; wide?: boolean }) {
  return (
    <figure className={wide ? "w-full" : "min-w-0"}>
      <div className="flex min-h-9 flex-wrap items-center gap-2">{children}</div>
      <figcaption className="mt-1.5 text-[11px] text-ink-faint">{name}</figcaption>
    </figure>
  );
}

const VARIANTS: ButtonVariant[] = ["primary", "secondary", "danger", "quiet"];

function Buttons() {
  return (
    <Section
      title="Button"
      about={
        <>
          <code className="font-mono">Button</code>, or{" "}
          <code className="font-mono">buttonClass</code> on a native button. One primary per view. A
          button waiting on its request keeps focus with{" "}
          <code className="font-mono">aria-disabled</code>.
        </>
      }
    >
      {VARIANTS.map((variant) => (
        <Specimen key={variant} name={variant}>
          <Button variant={variant} type="button">
            {variant === "danger" ? "Delete" : variant === "quiet" ? "Cancel" : "Save"}
          </Button>
          <Button variant={variant} type="button" disabled>
            Disabled
          </Button>
        </Specimen>
      ))}
      <Specimen name="waiting on its request">
        <button type="button" aria-disabled="true" className={buttonClass("primary")}>
          Saving…
        </button>
      </Specimen>
    </Section>
  );
}

function IconButtons() {
  const [pinned, setPinned] = useState(true);
  return (
    <Section
      title="IconButton"
      about="Its label is its accessible name and its tooltip. Regular is 32 px, small 24 px, the smallest target allowed."
    >
      <Specimen name="regular">
        <IconButton icon="settings" label="Settings" />
        <IconButton icon="edit" label="Edit message" />
        <IconButton icon="search" label="Search" keys="Ctrl K" />
      </Specimen>
      <Specimen name="small">
        <IconButton size="small" icon="close" label="Not now" />
        <IconButton size="small" icon="plus" label="Add a channel" />
      </Specimen>
      <Specimen name="pressed">
        <IconButton
          icon="pin"
          label="Pinned"
          aria-pressed={pinned}
          onClick={() => setPinned((on) => !on)}
        />
      </Specimen>
      <Specimen name="disabled">
        <IconButton icon="trash" label="Delete" disabled />
      </Specimen>
      <Specimen name="round, on a chip">
        <span className="flex h-7 items-center gap-1.5 rounded-full bg-ink/[0.07] pl-2.5 pr-0.5 text-[13px] font-medium">
          Priya Shah
          <IconButton size="small" round icon="close" label="Remove Priya Shah" />
        </span>
      </Specimen>
    </Section>
  );
}

function TextFields() {
  return (
    <Section
      title="TextField"
      about="A visible label, then a hint and an error that are read with the field. An error marks it invalid."
    >
      <div className="grid w-full gap-4 sm:grid-cols-2">
        <TextField label="Channel name" placeholder="release-party" />
        <TextField
          label="Username"
          hint="Lowercase letters and numbers, such as maya or sam.r"
          defaultValue="vic"
        />
        <TextField
          label="Password"
          type="password"
          hint="At least 8 characters."
          error="Use at least 8 characters for the password."
          defaultValue="short"
        />
        <TextField label="Workspace address" defaultValue="ownbase.example.com" disabled />
      </div>
      <Specimen name="small, in a row with its button" wide>
        <div className="flex w-full flex-wrap items-start gap-2">
          <TextField size="small" label="Command" placeholder="/deploy" className="w-28 shrink-0" />
          <TextField
            size="small"
            label="Request URL"
            error="Give the address your service answers on."
            className="min-w-0 flex-1 basis-48"
          />
          <button
            type="button"
            className="mt-5 h-8 shrink-0 rounded-lg border border-edge px-3 text-[12px] font-medium text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink"
          >
            Add
          </button>
        </div>
      </Specimen>
      <Specimen name="large, on the sign-in card" wide>
        <TextField size="large" label="Display name" className="w-full max-w-sm" />
      </Specimen>
    </Section>
  );
}

function Selects() {
  return (
    <Section
      title="Select"
      about="A choice from a list, drawn like a text field of its size. Its label sits above it, never around it, so the options are not read as part of its name."
    >
      <div className="grid w-full gap-4 sm:grid-cols-2">
        <Select label="When I press Enter" defaultValue="send">
          <option value="send">Send the message</option>
          <option value="newline">Start a new line</option>
        </Select>
        <Select label="Expires after" hint="A link stops working after this." defaultValue="168">
          <option value="24">1 day</option>
          <option value="168">7 days</option>
          <option value="null">Never</option>
        </Select>
        <Select label="Channel" error="Choose a channel to post to." defaultValue="">
          <option value="">Nothing chosen yet</option>
          <option value="general">#general</option>
        </Select>
        <Select label="Microphone" defaultValue="" disabled>
          <option value="">System default</option>
        </Select>
      </div>
      <Specimen name="small, in a row with a text field and its button" wide>
        <div className="flex w-full flex-wrap items-end gap-2">
          <Select size="small" label="Post as" defaultValue="" className="min-w-0 flex-1 basis-40">
            <option value="">A new app</option>
            <option value="deploy">Deploy Bot</option>
          </Select>
          <TextField
            size="small"
            label="New app name"
            defaultValue="Webhook"
            className="min-w-0 flex-1 basis-40"
          />
          <Button variant="primary" type="button" className="h-8 shrink-0 px-3 text-[13px]">
            Create webhook
          </Button>
        </div>
      </Specimen>
    </Section>
  );
}

/**
 * The rule every form follows: the button is never off until the form is
 * filled in. Sent, the form says what is missing under each field and puts
 * the cursor in the first.
 */
function CheckedForm() {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="A form that checks when sent"
      about="Send it empty: each field says what is missing and the cursor goes to the first. Its button is never off until it is filled in."
    >
      <CheckedFields />
      <Specimen name="in a Dialog">
        <Button type="button" onClick={() => setOpen(true)}>
          Open a dialog
        </Button>
      </Specimen>
      {open && (
        <Dialog title="Name the channel" onClose={() => setOpen(false)}>
          <CheckedFields onDone={() => setOpen(false)} />
        </Dialog>
      )}
    </Section>
  );
}

function CheckedFields({ onDone }: { onDone?: () => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [problems, setProblems] = useState<{ name?: string; purpose?: string }>({});
  const [sent, setSent] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const purposeField = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = {
      name: name.trim() ? undefined : "Give the channel a name.",
      purpose: purpose.trim() ? undefined : "Say what the channel is for.",
    };
    setProblems(found);
    setSent(false);
    if (found.name || found.purpose) {
      (found.name ? nameField : purposeField).current?.focus();
      return;
    }
    setSent(true);
    onDone?.();
  };
  return (
    <form onSubmit={submit} noValidate className="w-full max-w-sm space-y-3">
      <TextField
        ref={nameField}
        label="Name"
        error={problems.name}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setProblems((found) => ({ ...found, name: undefined }));
        }}
      />
      <TextField
        ref={purposeField}
        label="What is it for?"
        error={problems.purpose}
        value={purpose}
        onChange={(event) => {
          setPurpose(event.target.value);
          setProblems((found) => ({ ...found, purpose: undefined }));
        }}
      />
      <div className="flex items-center gap-3">
        <Button variant="primary">Create</Button>
        <p role="status" className="text-[13px] text-ink-dim">
          {sent ? "Created." : ""}
        </p>
      </div>
    </form>
  );
}

function Keys() {
  return (
    <Section
      title="Kbd"
      about="One key as a keycap. A shortcut of several keys is several side by side."
    >
      <Specimen name="keys">
        <Kbd>Esc</Kbd>
        <Kbd>?</Kbd>
        <Kbd>Enter</Kbd>
      </Specimen>
      <Specimen name="a shortcut">
        <span className="flex items-center gap-1">
          <Kbd>Ctrl</Kbd>
          <Kbd>Shift</Kbd>
          <Kbd>E</Kbd>
        </span>
      </Specimen>
    </Section>
  );
}

/** A row of the sidebar, as far as a badge beside it needs one. */
function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span className="flex h-[34px] w-56 items-center gap-2 rounded-lg px-2 text-[15px] font-semibold text-ink">
      <Icon name="hash" size={16} className="shrink-0 text-ink-dim" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {children}
    </span>
  );
}

/** An icon with a badge on its corner, as the phone's bar draws one. */
function Corner({ children }: { children: ReactNode }) {
  return (
    <span className="relative flex size-10 items-center justify-center rounded-xl bg-deep text-ink-faint">
      <Icon name="bell" size={22} />
      {children}
    </span>
  );
}

function Badges() {
  const [count, setCount] = useState(0);
  return (
    <Section
      title="Badge"
      about="What waits: quiet for unread, the mention red for what names you. Nothing at 0; it pops in when it comes and its number rolls. Its label says it in words unless the control it sits on does."
    >
      <Specimen name="quiet and mention, beside a row">
        <div className="flex flex-col gap-1">
          <Row name="design">
            <Badge tone="quiet" count={4} label="4 unread conversations" />
          </Row>
          <Row name="general">
            <Badge count={2} label="2 unread mentions in general" />
          </Row>
        </div>
      </Specimen>
      <Specimen name="small, on an icon's corner, capped at 99+">
        <Corner>
          <Badge size="small" count={3} className="absolute -top-1 right-0 ring-2 ring-deep" />
        </Corner>
        <Corner>
          <Badge
            size="small"
            max={99}
            count={140}
            className="absolute -top-1 -right-1 ring-2 ring-deep"
          />
        </Corner>
      </Specimen>
      <Specimen name="dots, quiet and mention">
        <Corner>
          <Badge dot tone="quiet" count className="absolute right-2 top-2 ring-2 ring-deep" />
        </Corner>
        <Corner>
          <Badge dot count className="absolute right-2 top-2 ring-2 ring-deep" />
        </Corner>
      </Specimen>
      <Specimen name="at 0 it is not drawn; press to see it come">
        <Row name="launch">
          <Badge count={count} label={`${count} unread mentions in launch`} />
        </Row>
        <Button type="button" onClick={() => setCount((n) => n + 1)}>
          Add a mention
        </Button>
        <Button type="button" variant="quiet" onClick={() => setCount(0)}>
          Read
        </Button>
      </Specimen>
    </Section>
  );
}

function Tooltips() {
  return (
    <Section
      title="Tooltip"
      about="A short hint on a compact control: after a beat on hover, at once on keyboard focus, gone on Escape."
    >
      <Specimen name="with a shortcut">
        <Tooltip label="Bold" keys="Ctrl B">
          <button type="button" aria-label="Bold" className={buttonClass("quiet", "font-bold")}>
            B
          </button>
        </Tooltip>
      </Specimen>
      <Specimen name="below">
        <Tooltip label="Opens below when there is room" side="bottom">
          <button type="button" className={buttonClass("secondary")}>
            Point at me
          </button>
        </Tooltip>
      </Specimen>
    </Section>
  );
}

function Menus() {
  const [notify, setNotify] = useState("all");
  return (
    <Section
      title="Menu"
      about="A few actions on one control: arrow keys move, Enter chooses, Escape closes and returns focus."
    >
      <Specimen name="actions">
        <Menu
          label="Actions for Sam Rivera"
          tooltip="More actions"
          items={[
            { id: "profile", label: "View profile", icon: "user", onSelect: () => {} },
            { id: "message", label: "Message", icon: "messages", onSelect: () => {} },
            {
              id: "all",
              label: "Every message",
              section: "Notify me about",
              checked: notify === "all",
              onSelect: () => setNotify("all"),
            },
            {
              id: "mentions",
              label: "Mentions only",
              checked: notify === "mentions",
              onSelect: () => setNotify("mentions"),
            },
            { id: "mute", label: "Mute", hint: "1 hour", icon: "bellOff", onSelect: () => {} },
            { id: "unavailable", label: "Unavailable", disabled: true, onSelect: () => {} },
            {
              id: "remove",
              label: "Remove from workspace",
              icon: "trash",
              section: true,
              destructive: true,
              onSelect: () => {},
            },
          ]}
        />
      </Specimen>
      <Specimen name="heading, line under, keys">
        <Menu
          label="Your account"
          triggerContent="Sam Rivera"
          triggerLabel="Sam Rivera, your account"
          heading={<span className="text-[15px] font-semibold text-ink">Sam Rivera</span>}
          width={256}
          items={[
            {
              id: "clear",
              label: "Clear status",
              icon: "close",
              description: "💬 In a meeting · until 15:00",
              section: "Status",
              onSelect: () => {},
            },
            {
              id: "lunch",
              label: "Out for lunch",
              emoji: "🍜",
              hint: "1 hour",
              onSelect: () => {},
            },
            {
              id: "shortcuts",
              label: "Keyboard shortcuts",
              icon: "keyboard",
              keys: [modKey(), "/"],
              section: true,
              onSelect: () => {},
            },
          ]}
        />
      </Specimen>
    </Section>
  );
}

function Sheets() {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  return (
    <Section
      title="Sheet"
      about="A column of cards along the bottom of a phone, in reach of a thumb. Escape or a press on the dimmed page closes it and focus goes back. A Menu with sheet opens as one on a touch phone and as a dropdown anywhere else."
    >
      <Specimen name="opened by its owner, anywhere">
        <Button type="button" onClick={() => setOpen(true)}>
          Open a sheet
        </Button>
        <p role="status" className="text-[13px] text-ink-dim">
          {picked}
        </p>
      </Specimen>
      <Specimen name="a Menu with sheet: a dropdown here, a sheet on a touch phone">
        <Menu
          sheet
          label="Actions for #design"
          tooltip="More"
          header={(close) => (
            <div className="flex justify-around text-2xl">
              {["👍", "🎉", "👀"].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`React with ${emoji}`}
                  onClick={close}
                  className="flex size-11 items-center justify-center rounded-full hover:bg-ink/[0.07]"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
          items={[
            { id: "star", label: "Star", icon: "star", onSelect: () => {} },
            { id: "mute", label: "Mute", icon: "bellOff", onSelect: () => {} },
            {
              id: "leave",
              label: "Leave channel",
              icon: "leave",
              section: true,
              destructive: true,
              onSelect: () => {},
            },
          ]}
        />
      </Specimen>
      {open && (
        <Sheet label="Share the invite" onClose={() => setOpen(false)}>
          <div className={`${sheetCard} p-3`}>
            <p className="text-[15px] font-semibold">Share the invite</p>
            <p className="mt-0.5 text-[13px] text-ink-dim">Anyone with the link can join.</p>
          </div>
          <div className={`${sheetCard} flex flex-col p-1.5`}>
            {["Copy link", "Show QR code"].map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => {
                  setPicked(`${action} chosen.`);
                  setOpen(false);
                }}
                className="flex min-h-12 items-center rounded-lg px-3 text-left text-[15px] text-ink outline-none focus-visible:bg-ink/[0.07] active:bg-ink/[0.07]"
              >
                {action}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </Section>
  );
}

function Popovers() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Section
      title="Popover"
      about="A small form on one control. Escape or a press outside closes it and focus goes back."
    >
      <Specimen name="from an IconButton">
        <IconButton
          ref={trigger}
          icon="clock"
          label="Send later"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        />
      </Specimen>
      {open && (
        <Popover label="Send later" anchor={trigger} onClose={() => setOpen(false)} align="start">
          <div className="space-y-3 p-3">
            <TextField label="When" type="time" defaultValue="09:00" />
            <Button
              variant="primary"
              type="button"
              className="w-full"
              onClick={() => setOpen(false)}
            >
              Schedule
            </Button>
          </div>
        </Popover>
      )}
    </Section>
  );
}

function Toasts() {
  const toast = useToast();
  return (
    <Section
      title="Toast"
      about="Something that finished away from what started it. Never takes focus; a failure waits to be read."
    >
      <Specimen name="success">
        <Button type="button" onClick={() => toast({ message: "Link copied.", kind: "success" })}>
          Show a success
        </Button>
      </Specimen>
      <Specimen name="heads-up">
        <Button
          type="button"
          onClick={() =>
            toast({
              message:
                "With more than 8 cameras on, the call can stutter. Turning cameras off helps.",
              kind: "info",
            })
          }
        >
          Show a heads-up
        </Button>
      </Specimen>
      <Specimen name="failure, with an action">
        <Button
          type="button"
          onClick={() =>
            toast({
              message: "Could not pin the message.",
              action: { label: "Try again", run: () => {} },
            })
          }
        >
          Show a failure
        </Button>
      </Specimen>
    </Section>
  );
}

function EmptyStates() {
  return (
    <Section
      title="EmptyState"
      about="What a place with nothing in it says: what it is for and how to fill it. A mark for a panel or a dialog's list; the words alone, quieter, for a list inside a larger view."
    >
      <Specimen name="with a mark" wide>
        <EmptyState icon="bookmark" className="w-full">
          Nothing saved yet. Save a message to find it here again.
        </EmptyState>
      </Specimen>
      <Specimen name="with a mark and one thing to do" wide>
        <EmptyState
          icon="search"
          action={{ label: "Clear the filter", run: () => {} }}
          className="w-full"
        >
          Nothing matched. Try different words.
        </EmptyState>
      </Specimen>
      <Specimen name="words alone" wide>
        <EmptyState className="w-full">No channels match.</EmptyState>
      </Specimen>
      <Specimen name="words alone, with one thing to do" wide>
        <EmptyState action={{ label: "Show all", run: () => {} }} className="w-full">
          No pending requests.
        </EmptyState>
      </Specimen>
    </Section>
  );
}

function ListStatuses() {
  return (
    <Section
      title="ListStatus"
      about="What a list says about itself: rows shaped like what is coming, what failed with Retry, and what fills an empty one."
    >
      <Specimen name="loading" wide>
        <ListStatus loading placeholder loadingLabel="Loading replies…" className="w-full" />
      </Specimen>
      <Specimen name="refreshing" wide>
        <ListStatus loading loadingLabel="Loading apps…" className="w-full" />
      </Specimen>
      <Specimen name="failed" wide>
        <ListStatus
          loadingLabel="Loading apps…"
          error="Could not load apps. Check your connection and try again."
          onRetry={() => {}}
          className="w-full"
        />
      </Specimen>
      <Specimen name="empty" wide>
        <ListStatus
          loadingLabel="Loading saved messages…"
          empty="Nothing saved yet. Save a message to find it here again."
          emptyIcon="bookmark"
          emptyAction={{ label: "Clear the filter", run: () => {} }}
          className="w-full"
        />
      </Specimen>
    </Section>
  );
}
