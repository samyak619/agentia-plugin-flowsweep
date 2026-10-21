import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

export type SfResult = Readonly<{code: number; stderr: string; stdout: string}>
export type SfRunner = (args: readonly string[]) => Promise<SfResult>

// On Windows `sf` is a .cmd shim, so it has to go through cmd.exe. Arguments are quoted, and anything
// cmd.exe could still interpret inside quotes is refused instead of escaped.
const CMD_SAFE = /^[^"%^!\r\n]*$/

export const runSf: SfRunner = (args) =>
  new Promise((resolve, reject) => {
    const env = {...process.env, SF_JSON_TO_STDOUT: 'true', SF_SKIP_NEW_VERSION_CHECK: 'true', SF_DISABLE_TELEMETRY: 'true'}
    let child
    if (process.platform === 'win32') {
      const bad = args.find((arg) => !CMD_SAFE.test(arg))
      if (bad !== undefined) {
        reject(new Error(`Refusing to pass an argument with cmd.exe metacharacters to sf: ${bad}`))
        return
      }
      const line = ['sf', ...args].map((arg) => `"${arg}"`).join(' ')
      child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        env,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    } else {
      child = spawn('sf', [...args], {env})
    }

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) =>
      reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('Salesforce CLI (sf) is not on PATH') : error),
    )
    child.on('close', (code) => resolve({code: code ?? 1, stderr, stdout}))
  })

export class SfError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
  ) {
    super(message)
    this.name = 'SfError'
  }
}

/** sf can print warnings before the JSON document; parse from the first brace or bracket. */
export function parseLooseJson(text: string): unknown {
  const start = text.search(/[[{]/)
  if (start === -1) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

type SfEnvelope<T> = {message?: string; name?: string; result?: T; status?: number}

export type QueryResult<T> = Readonly<{done: boolean; records: T[]; totalSize: number}>

export const ORG_ALIAS = /^[A-Za-z0-9_.@+\-]+$/

export class SfOrg {
  private apiVersionPromise?: Promise<string>

  constructor(
    readonly alias: string,
    private readonly run: SfRunner = runSf,
  ) {
    if (!ORG_ALIAS.test(alias)) throw new Error(`Not a valid org alias or username: ${alias}`)
  }

  private async json<T>(args: readonly string[]): Promise<T> {
    const result = await this.run([...args, '--json'])
    const parsed = parseLooseJson(result.stdout || result.stderr) as SfEnvelope<T> | undefined
    if (!parsed || parsed.status !== 0 || parsed.result === undefined) {
      throw new SfError(parsed?.message ?? (result.stderr.trim() || `sf exited with ${result.code}`), parsed?.name)
    }
    return parsed.result
  }

  apiVersion(): Promise<string> {
    this.apiVersionPromise ??= this.json<{apiVersion: string}>(['org', 'display', '--target-org', this.alias]).then(
      (info) => info.apiVersion,
    )
    return this.apiVersionPromise
  }

  async display(): Promise<{apiVersion: string; instanceUrl?: string; username?: string}> {
    return this.json(['org', 'display', '--target-org', this.alias])
  }

  async query<T>(soql: string, tooling = false): Promise<T[]> {
    const args = ['data', 'query', '--target-org', this.alias, '--query', soql]
    if (tooling) args.push('--use-tooling-api')
    const result = await this.json<QueryResult<T>>(args)
    return result.records
  }

  /** Calls a REST path relative to `/services/data/vXX.X/`. Returns parsed JSON, or undefined for an empty body. */
  async rest(method: 'DELETE' | 'GET' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    const version = await this.apiVersion()
    const url = `/services/data/v${version}/${path.replace(/^\/+/, '')}`
    const args = ['api', 'request', 'rest', url, '--method', method, '--target-org', this.alias]
    let bodyFile: string | undefined
    // The beta `sf api request rest` rejects DELETE without a body, and an inline "" too; an empty file works.
    if (method !== 'GET') {
      bodyFile = join(tmpdir(), `flowsweep-${randomUUID()}.json`)
      await writeFile(bodyFile, body === undefined ? '' : JSON.stringify(body), 'utf8')
      args.push('--body', `@${bodyFile}`)
    }
    try {
      const result = await this.run(args)
      const parsed = parseLooseJson(result.stdout)
      const apiError = Array.isArray(parsed) ? (parsed[0] as {errorCode?: string; message?: string} | undefined) : undefined
      if (apiError?.errorCode) throw new SfError(apiError.message ?? apiError.errorCode, apiError.errorCode)
      if (result.code !== 0) {
        throw new SfError(result.stderr.trim() || result.stdout.trim() || `sf exited with ${result.code}`)
      }
      return parsed
    } finally {
      if (bodyFile) await rm(bodyFile, {force: true})
    }
  }
}

export function soqlInList(values: readonly string[]): string {
  for (const value of values) {
    if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`Unsafe SOQL literal: ${value}`)
  }
  return `(${values.map((value) => `'${value}'`).join(', ')})`
}
