import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "../src/components/IconButton.js";
import { Kbd } from "../src/components/Kbd.js";
import { Select } from "../src/components/Select.js";
import { TextField, inputClass, inputCls } from "../src/components/TextField.js";
import { accessibilityProblems } from "./accessibility.js";

afterEach(() => {
  // Unmounted before the stubs go, since vitest runs these hooks in reverse.
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an icon button", () => {
  it("is named by its label, and shows the same words as a hint after a beat on hover", () => {
    vi.useFakeTimers();
    render(<IconButton icon="settings" label="Channel settings" />);
    const button = screen.getByRole("button", { name: "Channel settings" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).not.toHaveAttribute("title");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Channel settings");
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows its hint at once on keyboard focus, with its shortcut", async () => {
    const user = userEvent.setup();
    render(
      <main>
        <IconButton icon="search" label="Search" keys="Ctrl K" />
      </main>,
    );
    await user.tab();
    const button = screen.getByRole("button", { name: "Search" });
    expect(button).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Search");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Ctrl K");
    expect(await accessibilityProblems()).toEqual([]);
  });

  it("is never smaller than the 24 px a finger or a shaky hand needs", () => {
    render(
      <>
        <IconButton icon="close" size="small" label="Not now" />
        <IconButton icon="edit" label="Edit message" />
        <IconButton size="small" round label="Remove Priya">
          <span aria-hidden="true">×</span>
        </IconButton>
      </>,
    );
    // jsdom lays nothing out, so the size is read from the classes that set it.
    expect(screen.getByRole("button", { name: "Not now" })).toHaveClass("size-6");
    expect(screen.getByRole("button", { name: "Edit message" })).toHaveClass("size-8");
    expect(screen.getByRole("button", { name: "Remove Priya" })).toHaveClass(
      "size-6",
      "rounded-full",
    );
  });

  it("passes its ref, state and handlers to the button", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(
      <>
        <IconButton icon="pin" label="Pinned" aria-pressed onClick={onClick} ref={ref} />
        <IconButton icon="dots" label="More actions" aria-haspopup="menu" aria-expanded={false} />
        <IconButton icon="trash" label="Delete" disabled />
      </>,
    );
    const pinned = screen.getByRole("button", { name: "Pinned" });
    expect(ref.current).toBe(pinned);
    expect(pinned).toHaveAttribute("aria-pressed", "true");
    await user.click(pinned);
    expect(onClick).toHaveBeenCalledOnce();
    const more = screen.getByRole("button", { name: "More actions" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("cannot be written without a label", () => {
    // @ts-expect-error A label is required: it is the only name the button has.
    render(<IconButton icon="close" />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

describe("a text field", () => {
  it("shows its label and reads its hint with it, valid until told otherwise", async () => {
    render(
      <main>
        <TextField label="Username" hint="Lowercase letters and numbers" />
      </main>,
    );
    const field = screen.getByLabelText("Username");
    expect(screen.getByText("Username", { selector: "label" })).toBeVisible();
    expect(field).toHaveAccessibleDescription("Lowercase letters and numbers");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await accessibilityProblems()).toEqual([]);
  });

  it("says what is wrong under the field, reads it first, and marks the field invalid", async () => {
    render(
      <main>
        <p id="context">Shown to everyone.</p>
        <TextField
          label="Password"
          type="password"
          hint="At least 8 characters."
          error="Use at least 8 characters for the password."
          aria-describedby="context"
        />
      </main>,
    );
    const field = screen.getByLabelText("Password");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(
      "Use at least 8 characters for the password. At least 8 characters. Shown to everyone.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Use at least 8 characters for the password.",
    );
    expect(await accessibilityProblems()).toEqual([]);
  });

  it("lets a form put the cursor in it through its ref", () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextField label="Request URL" ref={ref} id="request-url" />);
    expect(ref.current).toBe(screen.getByLabelText("Request URL"));
    expect(ref.current).toHaveAttribute("id", "request-url");
    act(() => ref.current?.focus());
    expect(screen.getByLabelText("Request URL")).toHaveFocus();
  });

  it("draws every field from one set of classes", () => {
    expect(inputCls).toBe(inputClass("regular"));
    for (const size of ["small", "regular", "large"] as const) {
      expect(inputClass(size)).toContain("aria-invalid:border-alert");
      expect(inputClass(size)).toContain("w-full");
    }
    // The tests run from the package; no other module writes a field's classes.
    const root = join(process.cwd(), "src");
    const copies = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".tsx") && !file.endsWith("TextField.tsx"))
      .filter((file) => /\b(const|let)\s+inputCls\b/.test(readFileSync(join(root, file), "utf8")));
    expect(copies).toEqual([]);
  });
});

describe("a key", () => {
  it("is drawn as a keycap", () => {
    render(
      <p>
        Press <Kbd>Esc</Kbd> to close.
      </p>,
    );
    const key = screen.getByText("Esc");
    expect(key.tagName).toBe("KBD");
    expect(key).toHaveClass("border-b-2", "font-mono");
  });
});

describe("a select", () => {
  function choices() {
    return (
      <>
        <option value="">A new app</option>
        <option value="deploy">Deploy Bot</option>
      </>
    );
  }

  it("is named by the label above it alone, not by its options, and reads its hint", async () => {
    render(
      <main>
        <Select label="Post as" hint="The app the message comes from." defaultValue="">
          {choices()}
        </Select>
      </main>,
    );
    const select = screen.getByRole("combobox", { name: "Post as" });
    expect(select.tagName).toBe("SELECT");
    expect(screen.getByText("Post as", { selector: "label" })).not.toContainElement(select);
    expect(select).toHaveAccessibleDescription("The app the message comes from.");
    expect(select).not.toHaveAttribute("aria-invalid");
    expect(select).toHaveDisplayValue("A new app");
    expect(await accessibilityProblems()).toEqual([]);
  });

  it("says what is wrong under it, reads it first, and marks it invalid", async () => {
    render(
      <main>
        <p id="context">Members see this.</p>
        <Select
          label="Channel"
          hint="Where the webhook posts."
          error="Choose a channel to post to."
          aria-describedby="context"
          defaultValue=""
        >
          <option value="">Choose one…</option>
          <option value="general">#general</option>
        </Select>
      </main>,
    );
    const select = screen.getByRole("combobox", { name: "Channel" });
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAccessibleDescription(
      "Choose a channel to post to. Where the webhook posts. Members see this.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a channel to post to.");
    expect(await accessibilityProblems()).toEqual([]);
  });

  it("gives a form its select through its ref, and says what was chosen", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLSelectElement>();
    const onChange = vi.fn();
    render(
      <Select label="Post as" ref={ref} id="post-as" defaultValue="" onChange={onChange}>
        {choices()}
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Post as" });
    expect(ref.current).toBe(select);
    expect(select).toHaveAttribute("id", "post-as");
    act(() => ref.current?.focus());
    expect(select).toHaveFocus();
    await user.selectOptions(select, "Deploy Bot");
    expect(onChange).toHaveBeenCalledOnce();
    expect(select).toHaveValue("deploy");
  });

  it("is drawn from a text field's classes for its size", () => {
    render(
      <>
        <Select label="Small" size="small" selectClassName="font-mono">
          {choices()}
        </Select>
        <Select label="Regular">{choices()}</Select>
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Small" })).toHaveAttribute(
      "class",
      inputClass("small", "font-mono"),
    );
    expect(screen.getByRole("combobox", { name: "Regular" })).toHaveAttribute(
      "class",
      inputClass("regular"),
    );
  });
});
