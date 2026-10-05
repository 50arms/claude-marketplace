// DX-4538: argument parsing for scripts/capture-screenshot.mjs, pure so a test needs no browser.

export const CAPTURE_DEFAULTS = {
  width: 1440,
  height: 900,
  dpr: 2,
  /** Below this viewport width the capture emulates a phone (mobile viewport semantics). */
  mobileBelowWidth: 768,
  /** Bound on waiting for the page to be ready; the script exits non-zero past it. */
  readyTimeoutMs: 15_000,
};

/** Still on screen after --login means the ticket was spent or refused. */
export const SIGN_IN_FORM_SELECTOR = 'input[type="password"]';

/** Present while any part of the page is still loading; the default readiness wait is for it to go. */
export const BUSY_SELECTOR = '[aria-busy="true"]';

/**
 * DX-4539: a page whose app never mounted (a script threw during load) has no busy element, so the busy wait
 * alone passes on a blank page. Rendered means the body shows text, or a visible replaced/form element
 * (image, svg, canvas, video, iframe, input, button, ...) with a box: generic, no app-specific selector.
 */
export const RENDERED_EXPRESSION = `(() => {
  const body = document.body;
  if (!body) return false;
  if (body.innerText.trim() !== "") return true;
  return [...body.querySelectorAll("img,svg,canvas,video,iframe,input,button,select,textarea,object,embed")].some((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
  });
})()`;

const FLAGS = ["login", "width", "height", "dpr", "wait-for"];

export const CAPTURE_USAGE =
  "usage: node capture-screenshot.mjs <url> <out.png> " + FLAGS.map((f) => `[--${f} <value>]`).join(" ");

function positive(flag, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${flag} must be a positive number, got "${raw}". ${CAPTURE_USAGE}`);
  }
  return n;
}

/** @returns {{url:string,out:string,login:string|null,waitFor:string|null,width:number,height:number,dpr:number,isMobile:boolean}} */
export function parseCaptureArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!FLAGS.includes(name)) throw new Error(`unknown flag ${a}. ${CAPTURE_USAGE}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${a} needs a value, got ${value === undefined ? "nothing" : `"${value}"`}. ${CAPTURE_USAGE}`);
    }
    flags[name] = value;
  }
  if (positionals.length !== 2) throw new Error(`need exactly <url> and <out.png>. ${CAPTURE_USAGE}`);
  const [url, out] = positionals;
  if (!out.toLowerCase().endsWith(".png")) {
    throw new Error(`out path must end in .png (attachments are PNG, not JPEG), got "${out}". ${CAPTURE_USAGE}`);
  }
  const width = flags.width === undefined ? CAPTURE_DEFAULTS.width : positive("width", flags.width);
  return {
    url,
    out,
    login: flags.login ?? null,
    waitFor: flags["wait-for"] ?? null,
    width,
    height: flags.height === undefined ? CAPTURE_DEFAULTS.height : positive("height", flags.height),
    dpr: flags.dpr === undefined ? CAPTURE_DEFAULTS.dpr : positive("dpr", flags.dpr),
    isMobile: width < CAPTURE_DEFAULTS.mobileBelowWidth,
  };
}
