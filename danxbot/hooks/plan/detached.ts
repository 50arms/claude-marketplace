// DX-4586: the host refuses every call of an environment that is gone (a reload, the process ending) with this text.
export const ENVIRONMENT_GONE = /no hooks module of that name is loaded/

// A task detached from its event reports its own failures in the pane; only its environment ending under it escapes, and nobody is left to tell.
export async function settleDetached(task: Promise<unknown>): Promise<void> {
  try {
    await task
  } catch (err: any) {
    if (!ENVIRONMENT_GONE.test(String(err?.message ?? err))) throw err
  }
}
