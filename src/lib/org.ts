import {mkdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {SfOrg, soqlInList} from './sf.js'

export type OrgFlowVersion = Readonly<{id: string; status: string; versionNumber: number}>

export type OrgFlowState = Readonly<{
  activeVersionNumber?: number
  definitionId?: string
  name: string
  /** Undefined when the org would not answer the FlowInterview query. */
  pausedInterviews?: number
  pausedInterviewsError?: string
  versions: readonly OrgFlowVersion[]
}>

type DefinitionRow = {ActiveVersionId: string | null; DeveloperName: string; Id: string}
type VersionRow = {DefinitionId: string; Id: string; Status: string; VersionNumber: number}
type InterviewRow = {FlowVersionViewId: string | null; Id: string}

const id15 = (id: string | null | undefined) => (id ?? '').slice(0, 15)

export async function inspectFlows(org: SfOrg, names: readonly string[]): Promise<Map<string, OrgFlowState>> {
  const states = new Map<string, OrgFlowState>()
  if (names.length === 0) return states

  const definitions = await org.query<DefinitionRow>(
    `SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition WHERE NamespacePrefix = null AND DeveloperName IN ${soqlInList(names)}`,
    true,
  )
  const definitionIds = definitions.map((row) => row.Id)
  const versions =
    definitionIds.length > 0
      ? await org.query<VersionRow>(
          `SELECT Id, DefinitionId, VersionNumber, Status FROM Flow WHERE DefinitionId IN ${soqlInList(definitionIds)} ORDER BY VersionNumber`,
          true,
        )
      : []

  let interviews: InterviewRow[] | undefined
  let interviewsError: string | undefined
  if (versions.length > 0) {
    try {
      interviews = await org.query<InterviewRow>('SELECT Id, FlowVersionViewId FROM FlowInterview LIMIT 2000')
    } catch (error) {
      interviewsError = error instanceof Error ? error.message : String(error)
    }
  }

  for (const name of names) {
    const definition = definitions.find((row) => row.DeveloperName.toLowerCase() === name.toLowerCase())
    if (!definition) {
      states.set(name, {name, versions: []})
      continue
    }
    const own = versions
      .filter((row) => id15(row.DefinitionId) === id15(definition.Id))
      .map((row) => ({id: row.Id, status: row.Status, versionNumber: row.VersionNumber}))
    const ownIds = new Set([...own.map((v) => id15(v.id)), id15(definition.Id)])
    const active = own.find((v) => id15(v.id) === id15(definition.ActiveVersionId))
    states.set(name, {
      activeVersionNumber: active?.versionNumber,
      definitionId: definition.Id,
      name,
      pausedInterviews: interviews?.filter((row) => ownIds.has(id15(row.FlowVersionViewId))).length,
      pausedInterviewsError: interviewsError,
      versions: own,
    })
  }
  return states
}

export type StepStatus = 'done' | 'failed' | 'skipped'
export type SweepStep = Readonly<{detail?: string; status: StepStatus; title: string}>
export type SweepResult = Readonly<{backupFiles: readonly string[]; name: string; ok: boolean; steps: readonly SweepStep[]}>

/**
 * Backs up every version, deactivates the active one, deletes each version (the last delete removes the
 * Flow), then re-reads the org. Stops at the first failed step so the Flow is never left half-deleted unseen.
 */
export async function sweepFlow(org: SfOrg, state: OrgFlowState, backupDir: string): Promise<SweepResult> {
  const steps: SweepStep[] = []
  const backupFiles: string[] = []
  const fail = (title: string, error: unknown): SweepResult => {
    steps.push({detail: error instanceof Error ? error.message : String(error), status: 'failed', title})
    return {backupFiles, name: state.name, ok: false, steps}
  }

  if (!state.definitionId) {
    steps.push({detail: 'Flow is not in the org', status: 'skipped', title: 'Nothing to delete'})
    return {backupFiles, name: state.name, ok: true, steps}
  }

  try {
    await mkdir(backupDir, {recursive: true})
    for (const version of state.versions) {
      const record = await org.rest('GET', `tooling/sobjects/Flow/${version.id}`)
      const file = join(backupDir, `${state.name}-v${version.versionNumber}.json`)
      await writeFile(file, JSON.stringify(record, null, 2), 'utf8')
      backupFiles.push(file)
    }
    steps.push({detail: `${backupFiles.length} version(s) saved to ${backupDir}`, status: 'done', title: 'Back up versions'})
  } catch (error) {
    return fail('Back up versions', error)
  }

  if (state.activeVersionNumber === undefined) {
    steps.push({detail: 'No active version', status: 'skipped', title: 'Deactivate'})
  } else {
    try {
      await org.rest('PATCH', `tooling/sobjects/FlowDefinition/${state.definitionId}`, {Metadata: {activeVersionNumber: 0}})
      steps.push({detail: `Version ${state.activeVersionNumber} deactivated`, status: 'done', title: 'Deactivate'})
    } catch (error) {
      return fail('Deactivate', error)
    }
  }

  for (const version of state.versions) {
    try {
      await org.rest('DELETE', `tooling/sobjects/Flow/${version.id}`)
      steps.push({status: 'done', title: `Delete version ${version.versionNumber}`})
    } catch (error) {
      return fail(`Delete version ${version.versionNumber}`, error)
    }
  }

  try {
    let after = (await inspectFlows(org, [state.name])).get(state.name)
    if (after?.definitionId && after.versions.length === 0) {
      await org.rest('DELETE', `tooling/sobjects/FlowDefinition/${after.definitionId}`)
      steps.push({status: 'done', title: 'Delete empty definition'})
      after = (await inspectFlows(org, [state.name])).get(state.name)
    }
    if (after?.definitionId) {
      return fail('Verify', new Error(`Flow still exists with ${after.versions.length} version(s)`))
    }
    steps.push({detail: 'Flow no longer in the org', status: 'done', title: 'Verify'})
  } catch (error) {
    return fail('Verify', error)
  }

  return {backupFiles, name: state.name, ok: true, steps}
}
