import type {SweepResult} from './org.js'
import type {FlowFinding, FlowStatus, PlanSummary} from './plan.js'

const LABEL: Record<FlowStatus, string> = {
  'already-gone': 'ALREADY GONE',
  blocked: 'BLOCKED',
  'not-checked': 'NOT CHECKED',
  ready: 'READY',
}

const MARK: Record<string, string> = {done: '[ok]', failed: '[x]', skipped: '[-]'}

export type Header = Readonly<{base: string; head: string; org?: string; story?: string}>

export function renderHeader(header: Header): string[] {
  const lines = [`FlowSweep  ${header.base}...${header.head}`]
  if (header.story) lines.push(`Story      ${header.story}`)
  lines.push(`Org        ${header.org ?? '(none: pass --target-org to check the org)'}`)
  return lines
}

export function renderFindings(findings: readonly FlowFinding[]): string[] {
  if (findings.length === 0) return ['', 'No deleted Flows in this diff. Nothing to sweep.']
  const lines: string[] = []
  for (const finding of findings) {
    lines.push('', `${LABEL[finding.status].padEnd(12)} ${finding.name}`, `             ${finding.path}`)
    if (finding.org?.definitionId) {
      const versions = finding.org.versions.map((v) => `v${v.versionNumber} ${v.status}`).join(', ')
      lines.push(`             In org: ${versions || 'no versions'}`)
    }
    for (const blocker of finding.blockers) lines.push(`  blocker    ${blocker}`)
    for (const ref of finding.references.slice(0, 8)) lines.push(`    ref      ${ref.kind}: ${ref.path}:${ref.line}`)
    if (finding.references.length > 8) lines.push(`    ...      ${finding.references.length - 8} more reference(s)`)
    for (const warning of finding.warnings) lines.push(`  warning    ${warning}`)
    if (finding.status !== 'already-gone') for (const step of finding.steps) lines.push(`  step       ${step}`)
  }
  return lines
}

export function renderSummary(summary: PlanSummary): string[] {
  const parts = (Object.keys(summary) as FlowStatus[]).filter((key) => summary[key] > 0).map((key) => `${summary[key]} ${LABEL[key].toLowerCase()}`)
  return ['', `Summary: ${parts.length > 0 ? parts.join(', ') : 'nothing to do'}`]
}

export function renderResults(results: readonly SweepResult[]): string[] {
  const lines: string[] = []
  for (const result of results) {
    lines.push('', `${result.ok ? 'SWEPT' : 'FAILED'}  ${result.name}`)
    for (const step of result.steps) {
      lines.push(`  ${MARK[step.status] ?? '   '} ${step.title}${step.detail ? `: ${step.detail}` : ''}`)
    }
  }
  return lines
}

/** A compact, tool-free summary of the plan for the Copado Release agent. */
export function aiPrompt(findings: readonly FlowFinding[], header: Header): string {
  const facts = findings.map((f) => ({
    blockers: f.blockers,
    flow: f.name,
    references: f.references.slice(0, 10).map((r) => `${r.kind}: ${r.path}`),
    status: f.status,
    versionsInOrg: f.org?.versions.map((v) => `v${v.versionNumber} ${v.status}`),
  }))
  return [
    'You are reviewing Salesforce Flow deletions in a Copado user story before promotion.',
    `Story: ${header.story ?? 'unknown'}. Target org: ${header.org ?? 'not checked'}.`,
    'For each Flow give: the release risk in one line, what to tell business users, and anything to check before deleting.',
    'End with a one-line go / no-go recommendation. Be brief.',
    JSON.stringify(facts),
  ].join('\n')
}
