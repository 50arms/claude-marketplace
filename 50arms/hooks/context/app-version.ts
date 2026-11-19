// The app has one version, `<major>.<minor>.<patch>`. The dashboard sends it as the `X-50Arms-Version` response header, and the dashboard MCP
// copies it into the `app_version` field of its `50arms_api` and `session_connect` answers (the plugin never sees an HTTP header). The checkout carries its own in the file
// `50ARMS_VERSION` at the git toplevel. A checkout a minor or major version behind the dashboard is told to rebase onto main; a patch difference never asks for one.
// Everything here is pure: `register.tsx` gathers the facts through `$`.

export const APP_VERSION_FILE = '50ARMS_VERSION'

// three non-negative decimal integers joined by dots: no `v`, no suffix, no leading zeros
const APP_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

export type AppVersion = { major: number; minor: number; patch: number }

export function parseAppVersion(text: unknown): AppVersion | null {
  const found = typeof text === 'string' ? APP_VERSION.exec(text) : null
  return found === null ? null : { major: Number(found[1]), minor: Number(found[2]), patch: Number(found[3]) }
}

// the string itself when it is a valid version, else undefined: an answer whose `app_version` is anything else carries no version
export function validAppVersion(value: unknown): string | undefined {
  return parseAppVersion(value) === null ? undefined : (value as string)
}

// the file's content: the version and ONE trailing newline, nothing else
export function parseVersionFile(text: unknown): AppVersion | null {
  return typeof text === 'string' ? parseAppVersion(text.replace(/\r?\n$/, '')) : null
}

// whether the checkout is behind by a minor or major version: the parts compare as numbers, major first, and the patch never counts
export function behindByMinorOrMajor(checkout: AppVersion, dashboard: AppVersion): boolean {
  if (checkout.major !== dashboard.major) return checkout.major < dashboard.major
  return checkout.minor < dashboard.minor
}

export function rebaseLine(checkout: string, dashboard: string): string {
  return `50 Arms is at app version ${dashboard} and this checkout is at ${checkout}, a minor or major version behind. Rebase onto origin/main now, before any more work: git fetch origin, then git rebase origin/main.`
}

export function versionFaultLine(dashboard: string, reason: string): string {
  return `50 Arms could not read this checkout's app version (${reason.replace(/\s+/g, ' ').trim().slice(0, 200)}), so it cannot tell whether the checkout is behind the dashboard's ${dashboard}.`
}

// The line to tell for a checkout file's content against the dashboard's version, or null: a repo with no version file (`fileText` null), a file that is no version, an equal,
// newer or patch-only-older checkout carry nothing to say.
export function appVersionLine(fileText: string | null, dashboard: string): string | null {
  const theirs = parseAppVersion(dashboard)
  const mine = parseVersionFile(fileText)
  if (theirs === null || mine === null) return null
  return behindByMinorOrMajor(mine, theirs) ? rebaseLine(fileText!.replace(/\r?\n$/, ''), dashboard) : null
}
