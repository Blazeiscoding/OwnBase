import { useEffect } from "react";
import { planMembers, type MemberNotice } from "@ownbase/protocol";
import { selfIsAdministrator } from "@ownbase/client-core";
import { usePlatform, useWorkspace } from "../context.js";
import { useSnoozed } from "../lib/noticeSnooze.js";
import { Banner, BannerAction } from "./Banner.js";

/**
 * The plan's notice and how many members it counts now, for the owner and
 * admins (P5); null for everyone else, or where the host set no plan.
 */
export function usePlanMembers(): { notice: MemberNotice; members: number } | null {
  const notice = useWorkspace((s) => (selfIsAdministrator(s) ? s.memberNotice : null));
  const members = useWorkspace((s) => (notice ? planMembers(Object.values(s.users)) : 0));
  return notice ? { notice, members } : null;
}

/** "This workspace has 51 members, more than the 50 the Team plan includes." */
export function memberNoticeText(notice: MemberNotice, members: number): string {
  const plan = notice.planName ? `the ${notice.planName} plan` : "its plan";
  return `This workspace has ${members} members, more than the ${notice.members} ${plan} includes.`;
}

/** The link to a bigger plan, styled as the words around it. */
export function UpgradeLink({ href, className }: { href: string; className: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      See plans
    </a>
  );
}

/**
 * Told to the owner and admins once the workspace has more members than its
 * plan includes. It locks nobody out, so it is a status, not an alert, and
 * "Not now" puts it away for two weeks. Workspace settings says the same
 * for as long as it is true.
 */
export function MemberNoticeBanner({
  now = Date.now,
  onShowing,
}: {
  now?: () => number;
  /** Told whether it is on show, so what comes after it in the banner place waits. */
  onShowing?: (showing: boolean) => void;
}) {
  const platform = usePlatform();
  const plan = usePlanMembers();
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const over = !!plan && plan.members > plan.notice.members;
  const { snoozed, snooze } = useSnoozed(
    platform.storage,
    over ? `memberNoticeSnoozedAt:${workspaceId ?? "workspace"}` : null,
    now,
  );
  const showing = over && snoozed === false;

  useEffect(() => onShowing?.(showing), [onShowing, showing]);
  useEffect(() => () => onShowing?.(false), [onShowing]);

  if (!showing || !plan) return null;

  return (
    <Banner
      tone="status"
      actions={
        <>
          {plan.notice.upgradeUrl && (
            <UpgradeLink
              href={plan.notice.upgradeUrl}
              className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
            />
          )}
          <BannerAction onClick={snooze}>Not now</BannerAction>
        </>
      }
    >
      {memberNoticeText(plan.notice, plan.members)} Nobody is locked out, and people can keep
      joining.
    </Banner>
  );
}
