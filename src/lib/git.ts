import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

export const FLOW_API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>

export const runGit: GitRunner = async (args, cwd) => {
  const {stdout} = await execFileAsync('git', [...args], {
    cwd,
    env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

export type DeletedFlow = Readonly<{name: string; path: string}>

export type FlowReference = Readonly<{kind: string; line: number; path: string; text: string}>

const FLOW_FILE = /(?:^|\/)flows\/([^/]+?)(?:-\d+)?\.flow(?:-meta\.xml)?$/

export function flowNameFromPath(path: string): string | undefined {
  const match = FLOW_FILE.exec(path.replaceAll('\\', '/'))
  return match && FLOW_API_NAME.test(match[1]) ? match[1] : undefined
}

/** Parses `git diff --name-status -z --no-renames` output and keeps deleted Flow files, one entry per Flow. */
export function parseDeletedFlows(nameStatusZ: string): DeletedFlow[] {
  const fields = nameStatusZ.split('\0').filter((field) => field.length > 0)
  const found = new Map<string, DeletedFlow>()
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]
    const path = fields[index + 1]
    if (!status.startsWith('D')) continue
    const name = flowNameFromPath(path)
    if (name && !found.has(name)) found.set(name, {name, path})
  }
  return [...found.values()]
}

export async function resolveRepoRoot(cwd: string, run: GitRunner = runGit): Promise<string> {
  try {
    return (await run(['rev-parse', '--show-toplevel'], cwd)).trim()
  } catch {
    throw new Error(`${cwd} is not inside a Git working tree`)
  }
}

export async function refExists(root: string, ref: string, run: GitRunner = runGit): Promise<boolean> {
  try {
    await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root)
    return true
  } catch {
    return false
  }
}

/** An explicit base is used exactly as given. Otherwise the first candidate branch that exists, remote first. */
export async function resolveBase(
  root: string,
  explicit: string | undefined,
  candidates: readonly (string | undefined)[],
  run: GitRunner = runGit,
): Promise<string> {
  if (explicit) {
    if (await refExists(root, explicit, run)) return explicit
    throw new Error(`Base ref not found: ${explicit}`)
  }
  const tried: string[] = []
  for (const candidate of candidates) {
    if (!candidate) continue
    for (const ref of candidate.includes('/') ? [candidate] : [`origin/${candidate}`, candidate]) {
      tried.push(ref)
      if (await refExists(root, ref, run)) return ref
    }
  }
  throw new Error(`No base ref found (tried ${tried.join(', ')}). Pass --base.`)
}

export async function listDeletedFlows(
  root: string,
  base: string,
  head: string,
  run: GitRunner = runGit,
): Promise<DeletedFlow[]> {
  const out = await run(['diff', '--name-status', '-z', '--no-renames', `${base}...${head}`, '--'], root)
  return parseDeletedFlows(out)
}

const REFERENCE_PATHSPECS = ['*.xml', '*.cls', '*.trigger', '*.js', '*.html', '*.cmp', '*.page', '*.component']

export function referenceKind(path: string): string {
  const p = path.replaceAll('\\', '/')
  if (/\/flows\//.test(p) || p.startsWith('flows/')) return 'Flow (subflow or action)'
  if (/quickActions\//.test(p)) return 'Quick action'
  if (/flexipages\//.test(p)) return 'Lightning page'
  if (/flowtests\//.test(p)) return 'Flow test'
  if (/(classes|triggers)\//.test(p)) return 'Apex'
  if (/(lwc|aura)\//.test(p)) return 'Lightning component'
  if (/(pages|components)\//.test(p)) return 'Visualforce'
  return 'Other metadata'
}

/** Parses `git grep -n <rev> ...` output, whose lines are `<rev>:<path>:<line>:<text>`. */
export function parseGrep(output: string, rev: string): FlowReference[] {
  const prefix = `${rev}:`
  const refs: FlowReference[] = []
  for (const raw of output.split('\n')) {
    const line = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
    const match = /^(.+?):(\d+):(.*)$/.exec(line)
    if (!match) continue
    const [, path, lineNo, text] = match
    refs.push({kind: referenceKind(path), line: Number(lineNo), path, text: text.trim().slice(0, 160)})
  }
  return refs
}

/** Files at `rev` that still mention the Flow's API name as a whole word. The deleted Flow itself is gone at `rev`. */
export async function findReferences(
  root: string,
  rev: string,
  name: string,
  run: GitRunner = runGit,
): Promise<FlowReference[]> {
  if (!FLOW_API_NAME.test(name)) throw new Error(`Not a Flow API name: ${name}`)
  try {
    const out = await run(['grep', '-n', '-w', '-F', '-I', '-e', name, rev, '--', ...REFERENCE_PATHSPECS], root)
    return parseGrep(out, rev).filter((ref) => flowNameFromPath(ref.path) !== name)
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as {code?: unknown}).code === 1) return []
    throw error
  }
}
