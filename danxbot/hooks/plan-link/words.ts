// The browser's wording, per problem type (frontend/src/routes/board/card/problem-vocabulary.ts).
export const WORDS = {
  question: {
    recommended: 'Recommended',
    body: 'Description',
    proCon: 'For and against',
    pro: 'For',
    con: 'Against',
    use: 'Use this',
    useNote: 'This but…',
    freeform: 'Or answer in your own words…',
    send: 'Send answer',
  },
  action: {
    recommended: 'Start here',
    body: 'What taking this route involves',
    proCon: 'Why this route',
    pro: 'Pick this when',
    con: 'Watch out for',
    use: 'Mark done',
    useNote: 'Mark done, with a note',
    freeform: 'Or say how you did it your own way…',
    send: 'Record it',
  },
} as const

export function age(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
