/** The longest address SMTP carries (RFC 5321). */
export const EMAIL_MAX = 254;

/**
 * Whether `text` reads as an email address as people type one (G10):
 * something@somewhere.tld, without spaces or the brackets and quotes a
 * display name brings. Whether it receives mail is for the link sent to it
 * to find out. Checked by hand rather than by a regular expression, whose
 * backtracking over the dots could be made slow by a long crafted address.
 */
export function isEmailAddress(text: string): boolean {
  if (text.length === 0 || text.length > EMAIL_MAX || /[\s<>()",;]/.test(text)) return false;
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@")) return false;
  const domain = text.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}
