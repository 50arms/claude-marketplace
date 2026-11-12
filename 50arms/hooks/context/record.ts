// a write to the session's own plan or a card, through 50arms_api: the call after which the band and the title's Needs You mark re-read the plan at once.
// Pure: nothing here reads a clock, a file or a session.

/** A call that writes a plan or a card (the session's own, through 50arms_api). */
export function isRecordWrite(method: unknown, path: unknown): boolean {
  return typeof method === 'string' && method.toUpperCase() !== 'GET' && typeof path === 'string' && /^\/api\/(issues|plans)(\/|$)/.test(path)
}
