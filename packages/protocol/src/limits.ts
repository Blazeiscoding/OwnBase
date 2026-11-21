/*
 * Field limits, each named once: rest.ts's schemas check them, and the ui sets
 * them on its fields and says them in its hints. Kept apart from the schemas,
 * which a client's first download must not bring in.
 */
export const HANDLE_MIN = 2;
export const HANDLE_MAX = 32;
export const HANDLE_CHARS = /^[a-z0-9][a-z0-9._-]*$/;
export const DISPLAY_NAME_MAX = 80;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;
export const STATUS_TEXT_MAX = 120;
export const TWO_STEP_CODE_MAX = 16;
export const CHANNEL_NAME_MAX = 80;
export const CHANNEL_TOPIC_MAX = 250;
export const CHANNEL_DESCRIPTION_MAX = 500;
/** The most people a group conversation names besides whoever starts it. */
export const GROUP_DM_OTHERS_MAX = 8;
export const USER_GROUP_NAME_MAX = 80;
export const USER_GROUP_DESCRIPTION_MAX = 250;
export const SEARCH_WORDS_MAX = 200;

/** Whether `text` is a username `handleSchema` takes. */
export function isHandle(text: string): boolean {
  return text.length >= HANDLE_MIN && text.length <= HANDLE_MAX && HANDLE_CHARS.test(text);
}
