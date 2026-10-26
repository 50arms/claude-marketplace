// a whole test suite is for a broad change; a narrow one runs only the tests it affects. This is the pure half of the reminder
// a Bash call gets when it starts a whole suite (no test file named): the command text in, the reminder or null out.

export const WHOLE_SUITE_REMINDER =
  'That started a whole test suite. Run a whole suite only for a broad change that touches many parts of the system; otherwise pass the test files the change affects (and the tests that import what you changed) instead.'

// A HEURISTIC, not a parser: it reads the command's words, so a flag's value (`-t name`) counts as an operand and a command that
// hides its runner (a script file, a wrapper) is never seen. A miss is a missing reminder, never a refused command.
const FILE_PICKERS = /^(FILES|AFFECTED|AFFECTED_FILES)=/ // the make variables that narrow a run to named files or the changed ones
const MAKE_TEST_TARGETS = new Set(['test', 'test-frontend'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn'])

const words = (segment: string): string[] => segment.trim().split(/\s+/).filter(w => w !== '')
// a word that names a file or a pattern: not a flag, and not a runner's subcommand
const isOperand = (w: string): boolean => !w.startsWith('-')

// `make test` and `make test-frontend`, narrowed by FILES= or AFFECTED=
function makeStartsWholeSuite(args: string[]): boolean {
  const target = args.find(a => !a.includes('=') && isOperand(a))
  return target !== undefined && MAKE_TEST_TARGETS.has(target) && !args.some(a => FILE_PICKERS.test(a))
}

// `<npm|pnpm|yarn> test` and `<pm> run test`: anything after the script that is not a flag (past `--` or not) is a file for it
function packageManagerStartsWholeSuite(args: string[]): boolean {
  const first = args.findIndex(isOperand)
  if (first === -1) return false
  const scriptAt = args[first] === 'run' ? args.findIndex((a, i) => i > first && isOperand(a)) : first
  if (scriptAt === -1 || args[scriptAt] !== 'test') return false
  return !args.slice(scriptAt + 1).some(a => a !== '--' && isOperand(a))
}

// `vitest [run] [files]`, directly or through npx/pnpx: any operand besides the `run` subcommand is a file filter
function vitestStartsWholeSuite(program: string, args: string[]): boolean {
  const start = program === 'vitest' ? 0 : args.indexOf('vitest') + 1
  const operands = args.slice(start).filter(isOperand)
  if (operands[0] === 'run') operands.shift()
  return operands.length === 0
}

function wholeSuiteSegment(segment: string): boolean {
  // leading VAR=value words are the caller's environment, not the command; make reads them too (a FILES= before make)
  const w = words(segment)
  const env: string[] = []
  while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) env.push(w.shift()!)
  const [program, ...args] = w
  if (program === undefined) return false
  if (program === 'make') return makeStartsWholeSuite([...env, ...args])
  if (PACKAGE_MANAGERS.has(program)) return packageManagerStartsWholeSuite(args)
  if (program === 'vitest') return vitestStartsWholeSuite(program, args)
  if ((program === 'npx' || program === 'pnpx') && args.includes('vitest')) return vitestStartsWholeSuite(program, args)
  return false
}

/** The reminder when any command of the Bash line starts a whole suite, else null. */
export function wholeSuiteReminder(command: unknown): string | null {
  if (typeof command !== 'string') return null
  return command.split(/&&|[;|\n]/).some(wholeSuiteSegment) ? WHOLE_SUITE_REMINDER : null
}
