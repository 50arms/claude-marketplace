// DX-4539: uncaught page exceptions, made safe to print. The page URL, a script URL or a stack frame can
// carry a credential in its query string or fragment, so no URL is ever printed with either.

/** The most errors a message lists; the rest are counted. */
export const MAX_PAGE_ERRORS = 5;

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`()<>\]]+/gi;

/** Every URL in `text`, cut at its first `?` or `#`. */
export function redactUrls(text) {
  return String(text).replace(URL_IN_TEXT, (url) => url.split(/[?#]/, 1)[0]);
}

/** One printable line group for a Runtime.exceptionThrown payload: an Error's description, or a thrown value. */
export function describeException(details) {
  const ex = details.exception;
  const text = ex?.description ?? (ex && "value" in ex ? `Uncaught ${JSON.stringify(ex.value)}` : details.text);
  return redactUrls(text);
}

/** Distinct errors in the order thrown. */
export class PageErrors {
  #seen = new Set();

  record(details) {
    this.#seen.add(describeException(details));
  }

  get size() {
    return this.#seen.size;
  }

  /** The errors for a message, capped at MAX_PAGE_ERRORS. */
  format() {
    const all = [...this.#seen];
    const more = all.length > MAX_PAGE_ERRORS ? [`(+${all.length - MAX_PAGE_ERRORS} more)`] : [];
    return [...all.slice(0, MAX_PAGE_ERRORS), ...more].join("\n");
  }
}
