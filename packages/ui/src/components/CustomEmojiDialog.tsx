import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@ownbase/client-core";
import { CUSTOM_EMOJI_NAME, mayRemoveEmoji, type CustomEmoji } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { failureText } from "../lib/failure.js";
import { EmojiPictureProblem, prepareEmojiPicture } from "../lib/emojiImage.js";
import { buttonClass } from "./Button.js";
import { useConfirm } from "./Confirm.js";
import { CustomEmojiImage, useEmojiAccess } from "./CustomEmoji.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { inputCls } from "./TextField.js";

/** A name from a file's name, as Slack suggests one: "Party Parrot.gif" gives party-parrot. */
export function nameFromFile(fileName: string): string {
  return fileName
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** How long a row just added stays marked, so the eye finds it in the list. */
const JUST_ADDED_MS = 2000;

/** A row's Remove shows while the row is pointed at or holds focus; a touchscreen cannot point. */
const ON_HOVER =
  "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * The workspace's own emoji (J12): adding one, a picture under a name with a
 * preview, and the list, where whoever added one, or an admin, removes it.
 * Members who may not add still open it for the list and their own Removes.
 */
export function CustomEmojiDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const confirm = useConfirm();
  const custom = useWorkspace((s) => s.customEmoji);
  const self = useWorkspace((s) => s.self);
  const users = useWorkspace((s) => s.users);
  const access = useEmojiAccess();
  const list = useMemo(
    () => Object.values(custom).sort((a, b) => a.name.localeCompare(b.name)),
    [custom],
  );
  const listTitle = useRef<HTMLHeadingElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  useEffect(() => {
    if (!justAdded) return;
    const timer = setTimeout(() => setJustAdded(null), JUST_ADDED_MS);
    return () => clearTimeout(timer);
  }, [justAdded]);

  async function remove(emoji: CustomEmoji) {
    const name = `:${emoji.name}:`;
    const sure = await confirm({
      title: `Remove ${name}?`,
      body: (
        <>
          Messages and reactions that use it will show{" "}
          <span className="whitespace-nowrap">{name}</span> as text. This can&apos;t be undone.
        </>
      ),
      confirmLabel: "Remove emoji",
      destructive: true,
    });
    if (!sure) return;
    setRemoving(emoji.id);
    setProblem(null);
    setDone("");
    const refused = await client.removeCustomEmoji(emoji);
    setRemoving(null);
    if (refused) {
      setProblem(failureText(`${name} was not removed.`, refused, "Try again."));
      return;
    }
    setDone(`${name} was removed.`);
    // Its row, and the Remove that had focus, are gone.
    listTitle.current?.focus();
  }

  return (
    <Dialog title="Custom emoji" onClose={onClose} width={460} ownScroll>
      <DialogScroll>
        {access === "add" ? (
          <AddEmojiForm
            onAdded={(name) => {
              setProblem(null);
              setDone(`:${name}: was added. Use it in any message or reaction.`);
              setJustAdded(name);
            }}
          />
        ) : (
          <p className="text-sm text-ink-dim">
            {self?.role === "guest"
              ? "Guests can use this workspace's emoji but can't add them."
              : "Only the workspace's owner and admins can add emoji here. You can still remove the ones you added."}
          </p>
        )}
        <h3
          ref={listTitle}
          tabIndex={-1}
          className="mb-2 mt-6 text-[13px] font-medium text-ink-dim outline-none"
        >
          In this workspace ({list.length})
        </h3>
        <p role="status" className="mb-2 text-sm text-ink empty:hidden">
          {done}
        </p>
        {problem && (
          <p role="alert" className="mb-2 text-sm text-alert">
            {problem}
          </p>
        )}
        {list.length === 0 ? (
          <p className="text-sm text-ink-faint">No custom emoji yet.</p>
        ) : (
          <ul className="divide-y divide-edge/60">
            {list.map((emoji) => {
              const mayRemove = mayRemoveEmoji(self, emoji);
              const by = emoji.createdBy === self?.id ? "you" : users[emoji.createdBy]?.displayName;
              return (
                <li
                  key={emoji.id}
                  data-just-added={justAdded === emoji.name ? "" : undefined}
                  className="group/row -mx-2 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-700 data-[just-added]:bg-copper/15"
                >
                  <span className="text-[17px] leading-none">
                    <CustomEmojiImage emoji={emoji} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      :{emoji.name}:
                    </span>
                    {by && (
                      <span className="block truncate text-[12px] text-ink-faint">
                        Added by {by}
                      </span>
                    )}
                  </span>
                  {mayRemove && (
                    <button
                      type="button"
                      disabled={removing === emoji.id}
                      onClick={() => void remove(emoji)}
                      aria-label={`Remove :${emoji.name}:`}
                      className={buttonClass(
                        "quiet",
                        removing === emoji.id ? undefined : `transition-opacity ${ON_HOVER}`,
                      )}
                    >
                      {removing === emoji.id ? "Removing…" : "Remove"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DialogScroll>
    </Dialog>
  );
}

/** Choose a picture, see it as it will show, name it, add it. */
function AddEmojiForm({ onAdded }: { onAdded: (name: string) => void }) {
  const client = useClient();
  const custom = useWorkspace((s) => s.customEmoji);
  const nameId = useId();
  const nameHelpId = useId();
  const nameProblemId = useId();
  const pictureHelpId = useId();
  const pictureProblemId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [picture, setPicture] = useState<{ blob: Blob; url: string } | null>(null);
  const [name, setName] = useState("");
  const [pictureProblem, setPictureProblem] = useState<string | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => void (picture && URL.revokeObjectURL(picture.url)), [picture]);

  async function choose(file: File) {
    setPictureProblem(null);
    setSendProblem(null);
    try {
      const blob = await prepareEmojiPicture(file);
      setPicture({ blob, url: URL.createObjectURL(blob) });
      setName((typed) => typed || nameFromFile(file.name));
    } catch (error) {
      setPictureProblem(
        error instanceof EmojiPictureProblem
          ? error.message
          : "OwnBase could not open that picture. Choose another one.",
      );
    }
  }

  function nameRefused(text: string) {
    setNameProblem(text);
    nameInput.current?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const chosen = name.trim().replace(/^:|:$/g, "");
    setSendProblem(null);
    if (!picture) {
      setPictureProblem("Choose a picture for the emoji.");
      chooseButton.current?.focus();
      return;
    }
    if (!CUSTOM_EMOJI_NAME.test(chosen))
      return nameRefused("A name has 1 to 32 lowercase letters, digits, dashes or underscores.");
    if (Object.hasOwn(custom, chosen))
      return nameRefused(`:${chosen}: is already in this workspace. Choose another name.`);
    setBusy(true);
    const answer = await client.addCustomEmoji(chosen, picture.blob);
    setBusy(false);
    if (answer instanceof ApiError) {
      if (answer.code === "emoji_name_taken")
        return nameRefused(`:${chosen}: is already in this workspace. Choose another name.`);
      const text = failureText(`:${chosen}: was not added.`, answer, "Try again.");
      if (answer.code === "invalid_emoji_name") return nameRefused(text);
      if (/^(unsupported_emoji_type|emoji_too_large|invalid_emoji)$/.test(answer.code ?? ""))
        setPictureProblem(text);
      else setSendProblem(text);
      return;
    }
    setPicture(null);
    setName("");
    onAdded(answer.name);
    chooseButton.current?.focus();
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      <div className="flex items-center gap-4">
        <div
          aria-hidden="true"
          data-picture-problem={pictureProblem ? "" : undefined}
          className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-dashed border-edge bg-ground data-[picture-problem]:border-alert"
        >
          {picture && <img src={picture.url} alt="" className="size-10 object-contain" />}
        </div>
        <div className="min-w-0">
          <button
            ref={chooseButton}
            type="button"
            onClick={() => fileInput.current?.click()}
            aria-describedby={pictureProblem ? pictureProblemId : pictureHelpId}
            className={buttonClass("secondary")}
          >
            {picture ? "Choose another picture" : "Choose a picture"}
          </button>
          {pictureProblem ? (
            <p id={pictureProblemId} role="alert" className="mt-1 text-[12px] text-alert">
              {pictureProblem}
            </p>
          ) : (
            <p id={pictureHelpId} className="mt-1 text-[12px] text-ink-faint">
              PNG, GIF, WebP or JPEG. Large still pictures are made smaller. Animated GIFs must be
              under 256 KB.
            </p>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/gif,image/webp,image/jpeg"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void choose(file);
            }}
          />
        </div>
      </div>
      <div>
        <label htmlFor={nameId} className="mb-1.5 block text-[13px] font-medium text-ink-dim">
          Name
        </label>
        <input
          ref={nameInput}
          id={nameId}
          value={name}
          maxLength={34}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setName(event.target.value.toLowerCase());
            setNameProblem(null);
          }}
          aria-invalid={nameProblem ? true : undefined}
          aria-describedby={nameProblem ? `${nameProblemId} ${nameHelpId}` : nameHelpId}
          className={inputCls}
        />
        {nameProblem && (
          <p id={nameProblemId} role="alert" className="mt-1 text-sm text-alert">
            {nameProblem}
          </p>
        )}
        <p id={nameHelpId} className="mt-1 text-[12px] text-ink-faint">
          People write it as :{name.trim().replace(/^:|:$/g, "") || "name"}: in messages.
        </p>
      </div>
      {sendProblem && (
        <p role="alert" className="text-sm text-alert">
          {sendProblem}
        </p>
      )}
      <div className="flex justify-end">
        <button type="submit" disabled={busy} className={buttonClass("primary")}>
          {busy ? "Adding…" : "Add emoji"}
        </button>
      </div>
    </form>
  );
}
