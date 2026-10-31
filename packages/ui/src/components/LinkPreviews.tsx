import type { LinkPreview, Message } from "@ownbase/protocol";
import { previewImageKey } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { useFileResource } from "./Attachments.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { useToast } from "./Toast.js";

/** Only web addresses become links, whatever a preview's address says. */
function webAddress(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** A picture wide enough to show under the words; a smaller one sits beside them. */
const isWide = (image: { width: number; height: number }) =>
  image.width >= 400 && image.width / image.height > 1.3;

/**
 * The previews a message's links have (E2), under its words: the site, the
 * page's title as a link to it, its description and its picture, which the
 * server fetched, so this device asks the site for nothing. The sender can
 * remove one, which takes it off for everyone.
 */
export function LinkPreviews({ message, canRemove }: { message: Message; canRemove: boolean }) {
  const previews = message.previews ?? [];
  if (previews.length === 0) return null;
  return (
    <div className="mt-1 space-y-1.5">
      {previews.map((preview) => (
        <PreviewCard key={preview.id} message={message} preview={preview} canRemove={canRemove} />
      ))}
    </div>
  );
}

function PreviewCard({
  message,
  preview,
  canRemove,
}: {
  message: Message;
  preview: LinkPreview;
  canRemove: boolean;
}) {
  const client = useClient();
  const toast = useToast();
  const href = webAddress(preview.url);
  const image = preview.image;
  const wide = !!image && isWide(image);

  function remove() {
    client
      .removeLinkPreview(message, preview.id)
      .catch(() => toast({ message: "The preview was not removed. Try again.", kind: "error" }));
  }

  return (
    <div className="flex max-w-xl gap-3 rounded-lg border border-edge border-l-2 border-l-ink-faint bg-ink/[0.025] py-2 pl-3 pr-2">
      <div className="min-w-0 flex-1">
        {preview.siteName && (
          <p className="truncate text-xs font-medium text-ink-faint">{preview.siteName}</p>
        )}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 line-clamp-2 text-[15px] font-semibold leading-snug text-copper hover:underline"
          >
            {preview.title || href}
          </a>
        ) : (
          <p className="mt-0.5 line-clamp-2 text-[15px] font-semibold leading-snug text-ink">
            {preview.title}
          </p>
        )}
        {preview.description && (
          <p className="mt-0.5 line-clamp-3 text-sm text-ink-dim">{preview.description}</p>
        )}
        {image && wide && <PreviewImage preview={preview} wide />}
      </div>
      {image && !wide && <PreviewImage preview={preview} wide={false} />}
      {canRemove && (
        <Tooltip label="Remove preview">
          <button
            type="button"
            onClick={remove}
            aria-label={`Remove the preview of ${preview.title || preview.url}`}
            className="flex size-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * A preview's picture, from the server, with its room kept before it loads so
 * the conversation does not jump. One that cannot be loaded leaves nothing.
 */
function PreviewImage({ preview, wide }: { preview: LinkPreview; wide: boolean }) {
  const { url, error } = useFileResource(previewImageKey(preview.id));
  const image = preview.image!;
  if (error) return null;
  return wide ? (
    <div
      className="mt-2 max-h-[200px] w-full max-w-[360px] overflow-hidden rounded-md bg-ink/[0.04]"
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
    >
      {url && <img src={url} alt="" className="size-full object-cover" />}
    </div>
  ) : (
    <div className="size-[72px] shrink-0 overflow-hidden rounded-md bg-ink/[0.04]">
      {url && <img src={url} alt="" className="size-full object-cover" />}
    </div>
  );
}
