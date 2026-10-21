import type {DeletedFlow, FlowReference} from './git.js'
import type {OrgFlowState} from './org.js'

export type FlowStatus = 'already-gone' | 'blocked' | 'not-checked' | 'ready'

export type FlowFinding = Readonly<{
  blockers: readonly string[]
  name: string
  org?: OrgFlowState
  path: string
  references: readonly FlowReference[]
  status: FlowStatus
  steps: readonly string[]
  warnings: readonly string[]
}>

export type PlanOptions = Readonly<{ignoreReferences: boolean}>

export function planFlow(
  flow: DeletedFlow,
  references: readonly FlowReference[],
  org: OrgFlowState | undefined,
  options: PlanOptions,
): FlowFinding {
  const blockers: string[] = []
  const warnings: string[] = []
  const steps: string[] = []

  if (references.length > 0) {
    const files = new Set(references.map((ref) => ref.path)).size
    const message = `Still referenced in ${files} file(s) at the story head; Salesforce refuses to delete a Flow that is in use`
    if (options.ignoreReferences) warnings.push(`${message} (ignored by --ignore-references)`)
    else blockers.push(message)
  }

  if (!org) {
    steps.push(
      'Deactivate the active version in each target org',
      'Delete every version (Salesforce keeps old versions after a destructive deploy)',
      'Confirm no paused interviews remain',
    )
    return {
      blockers,
      name: flow.name,
      path: flow.path,
      references,
      status: blockers.length > 0 ? 'blocked' : 'not-checked',
      steps,
      warnings: [...warnings, 'No --target-org: org state not checked'],
    }
  }

  if (!org.definitionId) {
    return {
      blockers,
      name: flow.name,
      org,
      path: flow.path,
      references,
      status: blockers.length > 0 ? 'blocked' : 'already-gone',
      steps,
      warnings,
    }
  }

  if (org.pausedInterviews === undefined) {
    warnings.push(`Could not check paused interviews: ${org.pausedInterviewsError ?? 'unknown error'}`)
  } else if (org.pausedInterviews > 0) {
    blockers.push(`${org.pausedInterviews} paused interview(s); resume or delete them in Setup > Paused and Failed Flow Interviews`)
  }

  steps.push(`Back up ${org.versions.length} version(s) as JSON`)
  if (org.activeVersionNumber !== undefined) steps.push(`Deactivate version ${org.activeVersionNumber}`)
  steps.push(`Delete version(s) ${org.versions.map((v) => v.versionNumber).join(', ')}`, 'Verify the Flow is gone')

  return {
    blockers,
    name: flow.name,
    org,
    path: flow.path,
    references,
    status: blockers.length > 0 ? 'blocked' : 'ready',
    steps,
    warnings,
  }
}

export type PlanSummary = Readonly<Record<FlowStatus, number>>

export function summarize(findings: readonly FlowFinding[]): PlanSummary {
  const summary: Record<FlowStatus, number> = {'already-gone': 0, blocked: 0, 'not-checked': 0, ready: 0}
  for (const finding of findings) summary[finding.status] += 1
  return summary
}
