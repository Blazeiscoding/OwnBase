/**
 * Every `error` code a REST answer can carry, and the few a client makes up
 * itself when no answer arrives. A client compares against these, so a code
 * that is renamed or retired fails to compile where it is still expected.
 */
export const ERROR_CODES = [
  // Requests
  "bad_request",
  "invalid_request",
  "internal",
  "not_found",
  "too_many_requests",
  "usage",

  // Signing in and accounts
  "account_deactivated",
  "auth_busy",
  "auth_failed",
  "challenge_failed",
  "claim_required",
  "credentials_changed",
  "guest_account",
  "invalid_credentials",
  "invalid_time_zone",
  "invalid_two_step_code",
  "password_change_required",
  "protocol_mismatch",
  "session_not_found",
  "two_step_expired",
  "two_step_off",
  "two_step_on",
  "two_step_required",
  "two_step_setup_expired",
  "unauthorized",
  "workspace_unclaimed",

  // Roles and people
  "admin_only",
  "admins_are_equals",
  "admins_can_always_invite",
  "already_owner",
  "bots_cannot_invite",
  "bots_have_no_password",
  "bots_have_no_role",
  "cannot_block_app",
  "cannot_block_self",
  "cannot_change_self",
  "cannot_reset_self",
  "guest_access_off",
  "guest_not_allowed",
  "guest_restricted",
  "guests_full",
  "handle_taken",
  "invalid_friend",
  "invalid_owner",
  "invite_not_found",
  "invite_permission_required",
  "invite_required",
  "not_a_guest",
  "owner_is_protected",
  "owner_only",
  "unknown_user",
  "user_not_found",

  // Conversations
  "cannot_edit_dm",
  "cannot_invite_to_dm",
  "cannot_leave_dm",
  "channel_archived",
  "channel_invite_forbidden",
  "channel_management_required",
  "channel_manager_assignment_forbidden",
  "channel_membership_required",
  "channel_not_found",
  "channel_removal_forbidden",
  "invalid_seq",
  "invalid_unread_target",
  "name_taken",
  "not_a_member",
  "not_direct",
  "section_not_found",
  "sections_changed",
  "too_many_sections",

  // Messages, threads, polls and calls
  "attachments_scheduled",
  "bad_choice",
  "bad_poll",
  "bad_reply_target",
  "bad_thread_root",
  "call_not_editable",
  "cannot_report_own_message",
  "empty_message",
  "forward_unavailable",
  "invalid_attachments",
  "invalid_search_date",
  "message_changed",
  "message_deleted",
  "message_kept",
  "message_not_found",
  "msg_too_long",
  "nonce_conflict",
  "not_a_thread_root",
  "not_your_message",
  "poll_closed",
  "poll_not_editable",
  "poll_not_found",
  "preview_not_found",
  "reminder_in_past",
  "reminder_limit",
  "reminder_too_far",
  "report_not_found",
  "scheduled_changed",
  "scheduled_limit",
  "scheduled_removed",
  "send_at_in_past",
  "thread_not_found",

  // Files, pictures and storage
  "file_not_found",
  "file_too_large",
  "icon_too_large",
  "invalid_icon",
  "no_avatar",
  "no_file",
  "no_icon",
  "not_enough_space",
  "storage_quota_exceeded",
  "unsupported_icon_type",
  "uploads_disabled",

  // Copies of the workspace
  "copies_unavailable",
  "copy_downloading",
  "no_copy",

  // Apps, commands and forms
  "action_not_found",
  "app_busy",
  "command_taken",
  "in_app_command",
  "link_action",
  "no_interactivity_url",
  "not_a_command",
  "not_an_app_message",
  "request_not_found",
  "unknown_command",
  "view_has_no_submit",
  "view_not_found",
  "view_submitting",

  // Posting as an app or to an incoming webhook, in Slack's words
  "invalid_payload",
  "invalid_webhook",
  "missing_scope",
  "no_text",
  "not_in_channel",

  // Reaching an app's address
  "aborted",
  "blocked_host",
  "timeout",
  "too_large",
  "unreachable",

  // Single sign-on, compliance and licensing (ee)
  "invalid_domains",
  "license_required",
  "public_url_required",
  "sso_code_invalid",
  "sso_discovery_failed",
  "sso_incomplete",
  "sso_off",
  "sso_required",
  "export_running",
  "no_export_choice",

  // Made by the client when no answer explains a failure
  "avatar_unavailable",
  "history_changed",
  "http_error",
  "invalid_response",
  "network_error",
  "not_connected",
  "upload_timeout",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(ERROR_CODES);

/** A code read off the wire, or `http_error` for one this client does not know. */
export function errorCodeOf(value: unknown): ErrorCode {
  return typeof value === "string" && KNOWN.has(value) ? (value as ErrorCode) : "http_error";
}
