import {AgentiaCommand, getAgentiaHost, type PluginAiAskResult, type PluginWorkItem} from '@copado/agentia-plugin-sdk'
import {confirm} from '@inquirer/prompts'
import {Flags} from '@oclif/core'
import {join, resolve} from 'node:path'

import {
  type DeletedFlow,
  FLOW_API_NAME,
  findReferences,
  listDeletedFlows,
  resolveBase,
  resolveRepoRoot,
} from '../../lib/git.js'
import {writeDestructiveManifest} from '../../lib/manifest.js'
import {inspectFlows, type OrgFlowState, sweepFlow, type SweepResult} from '../../lib/org.js'
import {type FlowFinding, planFlow, summarize} from '../../lib/plan.js'
import {aiPrompt, type Header, renderFindings, renderHeader, renderResults, renderSummary} from '../../lib/render.js'
import {SfOrg} from '../../lib/sf.js'

const DEFAULT_API_VERSION = '62.0'

export default class FlowSweep extends AgentiaCommand {
  static description =
    'Find Salesforce Flows deleted in the current user story and clear what blocks their deletion: references that still use them, paused interviews, the active version, and the old versions a destructive deploy leaves behind. Reports by default; with --apply it backs up, deactivates, deletes every version, and verifies, in the target org.'

  static examples = [
    '<%= config.bin %> flow sweep',
    '<%= config.bin %> flow sweep --target-org uat',
    '<%= config.bin %> flow sweep --target-org uat --apply',
    '<%= config.bin %> flow sweep --target-org uat --apply --yes --json',
    '<%= config.bin %> flow sweep --base origin/main --check',
    '<%= config.bin %> flow sweep --flow Legacy_Lead_Router --target-org dev --explain',
    '<%= config.bin %> flow sweep --write-manifest destructive',
  ]

  static flags = {
    apply: Flags.boolean({
      dependsOn: ['target-org'],
      description: 'Delete the READY Flows in --target-org: back up every version, deactivate, delete each version, verify.',
    }),
    'backup-dir': Flags.string({
      default: '.flowsweep/backups',
      description: 'Where --apply saves each version as JSON before deleting it, relative to the repository root.',
    }),
    base: Flags.string({
      description: "Base ref to diff against. Defaults to the active Copado story's base branch, then main, then master.",
    }),
    check: Flags.boolean({
      default: false,
      description: 'Exit with code 1 when any Flow is blocked. For git hooks and CI.',
    }),
    explain: Flags.boolean({
      default: false,
      description: 'Ask the Copado Release agent for a release-risk summary of the plan. Uses AI quota.',
    }),
    flow: Flags.string({
      description: 'Flow API name to sweep even if the diff does not delete it. Repeatable.',
      multiple: true,
    }),
    head: Flags.string({default: 'HEAD', description: 'Head ref of the story.'}),
    'ignore-references': Flags.boolean({
      default: false,
      description: 'Do not block on files that still mention the Flow name.',
    }),
    path: Flags.string({description: 'Repository to inspect. Defaults to the current directory.'}),
    'target-org': Flags.string({
      char: 'o',
      description: 'Salesforce CLI alias or username of the org to check (and, with --apply, to clean).',
    }),
    'write-manifest': Flags.string({
      description: 'Also write package.xml and destructiveChangesPost.xml for the sweepable Flows into this folder.',
    }),
    yes: Flags.boolean({
      dependsOn: ['apply'],
      description: 'Apply without asking. Required with --apply when there is no terminal or with --json.',
    }),
  }

  async run() {
    const {flags} = await this.parse(FlowSweep)
    const interactive = !this.jsonEnabled() && process.stdin.isTTY === true && process.stdout.isTTY === true

    for (const name of flags.flow ?? []) {
      if (!FLOW_API_NAME.test(name)) this.error(`Not a Flow API name: ${name}`, {exit: 2})
    }

    const root = await resolveRepoRoot(resolve(flags.path ?? process.cwd()))
    const story = await this.activeStory()
    const base = await resolveBase(root, flags.base, [story?.baseBranch, 'main', 'master']).catch((error: Error) =>
      this.error(error.message, {exit: 2}),
    )

    const deleted: DeletedFlow[] = await listDeletedFlows(root, base, flags.head)
    for (const name of flags.flow ?? []) {
      if (!deleted.some((flow) => flow.name === name)) deleted.push({name, path: '(named with --flow)'})
    }

    const org = flags['target-org'] ? new SfOrg(flags['target-org']) : undefined
    const header: Header = {
      base,
      head: flags.head,
      org: flags['target-org'],
      story: story ? [story.name, story.title].filter(Boolean).join(' ') : undefined,
    }

    const findings = await this.withSpinner('Checking deleted Flows', async () => {
      const states: Map<string, OrgFlowState> | undefined = org
        ? await inspectFlows(org, deleted.map((flow) => flow.name))
        : undefined
      const out: FlowFinding[] = []
      for (const flow of deleted) {
        const references = await findReferences(root, flags.head, flow.name)
        out.push(planFlow(flow, references, states?.get(flow.name), {ignoreReferences: flags['ignore-references']}))
      }
      return out
    })
    const summary = summarize(findings)

    this.display(() => {
      this.logLines(renderHeader(header))
      this.logLines(renderFindings(findings))
      this.logLines(renderSummary(summary))
    })

    const result: {
      ai?: PluginAiAskResult
      base: string
      findings: FlowFinding[]
      head: string
      manifest?: string[]
      org?: string
      results?: SweepResult[]
      story?: string
      summary: typeof summary
    } = {base, findings, head: flags.head, org: flags['target-org'], story: header.story, summary}

    const sweepable = findings.filter((f) => f.status === 'ready' || f.status === 'not-checked').map((f) => f.name)

    if (flags['write-manifest']) {
      const apiVersion = org ? await org.apiVersion() : DEFAULT_API_VERSION
      result.manifest = await writeDestructiveManifest(resolve(root, flags['write-manifest']), apiVersion, sweepable)
      this.display(() => this.log(`\nWrote ${result.manifest!.join(' and ')}`))
    }

    if (flags.explain && findings.length > 0) {
      try {
        const host = getAgentiaHost({requires: ['ai.ask']})
        result.ai = await this.withSpinner('Asking the Copado Release agent', () =>
          host.ai.ask({agent: 'release', prompt: aiPrompt(findings, header)}),
        )
        this.display(() => this.logLines(['', 'Release agent:', result.ai!.content]))
      } catch (error) {
        this.warn(`Release agent unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (flags.apply && org) {
      const ready = findings.filter((f) => f.status === 'ready' && f.org)
      if (ready.length === 0) {
        this.display(() => this.log('\nNothing is ready to delete.'))
      } else {
        if (!flags.yes) {
          if (!interactive) this.error('Refusing to delete without confirmation. Pass --yes to apply.', {exit: 2})
          const names = ready.map((f) => f.name).join(', ')
          const ok = await confirm({default: false, message: `Delete ${ready.length} Flow(s) from ${org.alias}: ${names}?`})
          if (!ok) {
            this.log('Nothing was changed.')
            return result
          }
        }
        const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
        const backupDir = resolve(root, flags['backup-dir'], org.alias, stamp)
        result.results = []
        for (const finding of ready) {
          const swept = await this.withSpinner(`Sweeping ${finding.name}`, () =>
            sweepFlow(org, finding.org!, join(backupDir, finding.name)),
          )
          result.results.push(swept)
        }
        this.display(() => this.logLines(renderResults(result.results!)))
        if (result.results.some((r) => !r.ok)) {
          this.error('One or more Flows could not be deleted. Backups are in ' + backupDir, {exit: 1})
        }
      }
    }

    if ((flags.check || flags.apply) && summary.blocked > 0) {
      this.error(`${summary.blocked} Flow(s) blocked. Fix the blockers above, then run again.`, {exit: 1})
    }

    return result
  }

  private async activeStory(): Promise<PluginWorkItem | undefined> {
    try {
      return await getAgentiaHost({requires: ['work.getWorkItem']}).work.getWorkItem()
    } catch {
      return undefined
    }
  }

  private logLines(lines: readonly string[]) {
    for (const line of lines) this.log(line)
  }
}
