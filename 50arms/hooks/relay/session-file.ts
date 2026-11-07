// The per-session files the session's MCP server keeps for the plugin: one directory per kind under the home directory's `.config`, one file per session id. The compaction control,
// the ready loop's clear release, and the record a `session_connect` writes all follow this one layout, which is the MCP server's own.
export type SessionFileKind = 'compaction' | 'clear' | 'plan-sessions'

// the MCP server keeps a file only for a plain session id, so an id with anything else in it (a path separator, a dot) names no file and never reaches a path
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

// The file's path, or null for an id that is not plain: the caller says what that means for what it reads.
export const sessionFilePath = (home: string, kind: SessionFileKind, sessionId: string): string | null =>
  SESSION_ID_PATTERN.test(sessionId) ? `${home}/.config/danxbot/${kind}/${sessionId}.json` : null
