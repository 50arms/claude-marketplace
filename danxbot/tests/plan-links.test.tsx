// DX-4630: a link's markdown. Labels carry problem statements and plan names, so Markdown's own characters in them must read as written
// and never end or alter the link.
import { expect, test } from 'claude-code/testing'

import { linkMarkdown } from '../hooks/plan/links'

test('a plain label and url are one markdown link', () => {
  expect(linkMarkdown('Open plan', 'https://d.test/plans/23')).toBe('[Open plan](https://d.test/plans/23)')
})

test("Markdown's own characters in a label are backslash-escaped, a literal backslash too", () => {
  expect(linkMarkdown('a_b *x* [y]', 'https://d.test/')).toBe('[a\\_b \\*x\\* \\[y\\]](https://d.test/)')
  expect(linkMarkdown('a\\b `c` <d> ~e~ f|g !h &i', 'https://d.test/')).toBe('[a\\\\b \\`c\\` \\<d\\> \\~e\\~ f\\|g \\!h \\&i](https://d.test/)')
})

test('a label is one line', () => {
  expect(linkMarkdown('one\n\ntwo   three', 'https://d.test/')).toBe('[one two three](https://d.test/)')
})

test('a url that would end the destination is percent-encoded', () => {
  expect(linkMarkdown('x', 'https://d.test/a (b)')).toBe('[x](https://d.test/a%20%28b%29)')
})
