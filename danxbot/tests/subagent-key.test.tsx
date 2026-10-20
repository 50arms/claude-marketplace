// DX-5328: the one conversion between Claude Code's bare sub-agent id and the canonical `agent-<id>` key.
import { describe, expect, test } from 'claude-code/testing'

import { bareSubagentId, subagentKey } from '../hooks/compaction/subagent-key'

describe('sub-agent key conversion (pure)', () => {
  test("a sub-agent's key is agent-<id> from Claude Code's bare id, and the conversion accepts no other form (DX-5328)", () => {
    expect(subagentKey('abc')).toBe('agent-abc')
    expect(bareSubagentId('agent-abc')).toBe('abc')
    expect(() => subagentKey('agent-abc')).toThrow('bare sub-agent id')
    expect(() => subagentKey('')).toThrow('bare sub-agent id')
    expect(() => bareSubagentId('abc')).toThrow('agent-<id>')
    expect(() => bareSubagentId('agent-')).toThrow('agent-<id>')
  })
})
