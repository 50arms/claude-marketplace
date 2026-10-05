// DX-4586: a detached task ends quietly only when its environment is gone; any other failure stays loud.
import { describe, expect, test } from 'claude-code/testing'

import { settleDetached } from '../hooks/plan/detached'

describe('settleDetached', () => {
  test('a task that resolves settles', async () => {
    await expect(settleDetached(Promise.resolve(1))).resolves.toBeUndefined()
  })

  test('environment gone: the refusal ends quietly', async () => {
    const gone = new Error('$.state.get refused: no hooks module of that name is loaded, so there is no scan to allow it (host rule)')
    await expect(settleDetached(Promise.reject(gone))).resolves.toBeUndefined()
  })

  test('environment alive: a real failure is rethrown', async () => {
    const real = new Error('the dashboard answered nonsense')
    await expect(settleDetached(Promise.reject(real))).rejects.toBe(real)
  })
})
