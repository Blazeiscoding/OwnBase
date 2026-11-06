/**
 * The locale dates and times are written in. In a browser that is the
 * browser's own (undefined). The desktop app sets the system's regional
 * format before the app renders, since Chromium formats in its UI language:
 * an English install on a Windows set to 24-hour times showed "3:05 PM".
 */

let current: string | undefined;

/** Sets the locale times are written in; an unusable one leaves the browser's. */
export function setReaderLocale(locale: string | undefined): void {
  try {
    new Intl.DateTimeFormat(locale);
    current = locale;
  } catch {
    current = undefined;
  }
}

export function readerLocale(): string | undefined {
  return current;
}

/**
 * A date formatter in the reader's locale, made on first use and made again
 * if the locale changes, so it can be declared once at the top of a module
 * that loads before the locale is set.
 */
export function dateFormat(options: Intl.DateTimeFormatOptions): {
  format(at: number | Date): string;
} {
  let made: { locale: string | undefined; format: Intl.DateTimeFormat } | null = null;
  return {
    format(at) {
      if (!made || made.locale !== current)
        made = { locale: current, format: new Intl.DateTimeFormat(current, options) };
      return made.format.format(at);
    },
  };
}
