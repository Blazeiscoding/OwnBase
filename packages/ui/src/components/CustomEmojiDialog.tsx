import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@ownbase/client-core";
import { CUSTOM_EMOJI_NAME, isAdministrator, type CustomEmoji } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { failureText } from "../lib/failure.js";
import { EmojiPictureProblem, prepareEmojiPicture } from "../lib/emojiImage.js";
import { buttonClass } from "./Button.js";
import { CustomEmojiImage, useMayAddEmoji } from "./CustomEmoji.js";
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

/**
 * The workspace's own emoji (J12): adding one, a picture under a name with a
 * preview, and the list, where whoever added one, or an admin, removes it.
 * Removing leaves messages that used it showing `:name:` as text.
 */
export function CustomEmojiDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const custom = useWorkspace((s) => s.customEmoji);
  const self = useWorkspace((s) => s.self);
  const users = useWorkspace((s) => s.users);
  const adminsOnly = useWorkspace((s) => s.emojiAddingAdminsOnly);
  const mayAdd = useMayAddEmoji();
  const list = useMemo(
    () => Object.values(custom).sort((a, b) => a.name.localeCompare(b.name)),
    [custom],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(emoji: CustomEmoji) {
    setRemoving(emoji.id);
    setProblem(null);
    const refused = await client.removeCustomEmoji(emoji);
    setRemoving(null);
    if (refused) setProblem(failureText(`:${emoji.name}: was not removed.`, refused, "Try again."));
  }

  return (
    <Dialog title="Custom emoji" onClose={onClose} width={460} ownScroll>
      <DialogScroll>
        {mayAdd ? (
          <AddEmojiForm />
        ) : (
          <p className="text-sm text-ink-dim">
            {self?.role === "guest"
              ? "Guests can use this workspace's emoji but can't add them."
              : adminsOnly
                ? "Only the workspace's owner and admins can add emoji here."
                : "You can't add emoji here."}
          </p>
        )}
        <h3 className="mb-2 mt-6 text-[13px] font-medium text-ink-dim">
          In this workspace ({list.length})
        </h3>
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
              const mayRemove =
                !!self && (emoji.createdBy === self.id || isAdministrator(self.role));
              const by = emoji.createdBy === self?.id ? "you" : users[emoji.createdBy]?.displayName;
              return (
                <li key={emoji.id} className="flex items-center gap-3 py-2">
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
                      className={buttonClass("quiet")}
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
function AddEmojiForm() {
  const client = useClient();
  const nameId = useId();
  const problemId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [picture, setPicture] = useState<{ blob: Blob; url: string } | null>(null);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => () => void (picture && URL.revokeObjectURL(picture.url)), [picture]);

  async function choose(file: File) {
    setProblem(null);
    setAdded(null);
    try {
      const blob = await prepareEmojiPicture(file);
      setPicture({ blob, url: URL.createObjectURL(blob) });
      setName((typed) => typed || nameFromFile(file.name));
    } catch (error) {
      setProblem(
        error instanceof EmojiPictureProblem
          ? error.message
          : "OwnBase could not open that picture. Choose another one.",
      );
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const chosen = name.trim().replace(/^:|:$/g, "");
    if (!picture) {
      setProblem("Choose a picture for the emoji.");
      fileInput.current?.focus();
      return;
    }
    if (!CUSTOM_EMOJI_NAME.test(chosen)) {
      setProblem("A name has 1 to 32 lowercase letters, digits, dashes or underscores.");
      return;
    }
    setBusy(true);
    setProblem(null);
    const answer = await client.addCustomEmoji(chosen, picture.blob);
    setBusy(false);
    if (answer instanceof ApiError) {
      setProblem(failureText(`:${chosen}: was not added.`, answer, "Try again."));
      return;
    }
    setAdded(`:${answer.name}: was added.`);
    setPicture(null);
    setName("");
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      <div className="flex items-center gap-4">
        <div
          aria-hidden="true"
          className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-dashed border-edge bg-ground"
        >
          {picture && <img src={picture.url} alt="" className="size-10 object-contain" />}
        </div>
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className={buttonClass("secondary")}
          >
            {picture ? "Choose another picture" : "Choose a picture"}
          </button>
          <p className="mt-1 text-[12px] text-ink-faint">
            PNG, GIF or WebP. Larger still pictures are made smaller.
          </p>
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
          id={nameId}
          value={name}
          maxLength={34}
          placeholder="party-parrot"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setName(event.target.value.toLowerCase());
            setProblem(null);
            setAdded(null);
          }}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          className={inputCls}
        />
        <p className="mt-1 text-[12px] text-ink-faint">
          People write it as :{name.trim().replace(/^:|:$/g, "") || "name"}: in messages.
        </p>
      </div>
      {problem && (
        <p id={problemId} role="alert" className="text-sm text-alert">
          {problem}
        </p>
      )}
      {added && (
        <p role="status" className="text-sm text-ink-dim">
          {added}
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
