import assert from 'node:assert/strict'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {inspectFlows, sweepFlow} from '../dist/lib/org.js'
import {parseLooseJson, SfOrg, soqlInList} from '../dist/lib/sf.js'

const ok = (result) => ({code: 0, stderr: '', stdout: JSON.stringify({result, status: 0})})

/** A fake `sf` backed by an in-memory org with one Flow (two versions, v2 active) and one paused interview elsewhere. */
function fakeOrg({failDeleteOf} = {}) {
  const calls = []
  const state = {
    active: '301000000000002AAA',
    definitions: [{DeveloperName: 'Legacy_Router', Id: '300000000000001AAA'}],
    interviews: [{FlowVersionViewId: '301999999999999AAA', Id: '0Fo1'}],
    versions: [
      {DefinitionId: '300000000000001AAA', Id: '301000000000001AAA', Status: 'Obsolete', VersionNumber: 1},
      {DefinitionId: '300000000000001AAA', Id: '301000000000002AAA', Status: 'Active', VersionNumber: 2},
    ],
  }
  const run = async (args) => {
    calls.push(args)
    const [a, b] = args
    if (a === 'org' && b === 'display') return ok({apiVersion: '62.0'})
    if (a === 'data' && b === 'query') {
      const soql = args[args.indexOf('--query') + 1]
      if (soql.includes('FROM FlowDefinition')) {
        return ok({done: true, records: state.definitions.map((d) => ({...d, ActiveVersionId: state.active})), totalSize: 1})
      }
      if (soql.includes('FROM Flow ')) return ok({done: true, records: state.versions, totalSize: state.versions.length})
      if (soql.includes('FROM FlowInterview')) return ok({done: true, records: state.interviews, totalSize: 1})
    }
    if (a === 'api') {
      const url = args[3]
      const method = args[args.indexOf('--method') + 1]
      if (method === 'GET') return {code: 0, stderr: '', stdout: JSON.stringify({Id: url.split('/').pop(), Metadata: {}})}
      if (method === 'PATCH') {
        const bodyArg = args[args.indexOf('--body') + 1]
        assert.deepEqual(JSON.parse(readFileSync(bodyArg.slice(1), 'utf8')), {Metadata: {activeVersionNumber: 0}})
        state.active = null
        return {code: 0, stderr: '', stdout: ''}
      }
      if (method === 'DELETE') {
        const id = url.split('/').pop()
        if (id === failDeleteOf) {
          return {code: 1, stderr: '', stdout: JSON.stringify([{errorCode: 'DELETE_FAILED', message: 'Cannot delete active version'}])}
        }
        state.versions = state.versions.filter((v) => v.Id !== id)
        if (state.versions.length === 0) state.definitions = []
        return {code: 0, stderr: '', stdout: ''}
      }
    }
    throw new Error(`unexpected sf call: ${args.join(' ')}`)
  }
  return {calls, org: new SfOrg('uat', run), state}
}

test('soqlInList quotes safe values and rejects injection', () => {
  assert.equal(soqlInList(['A', 'B_1']), "('A', 'B_1')")
  assert.throws(() => soqlInList(["x' OR Name != '"]), /Unsafe SOQL literal/)
})

test('SfOrg rejects unsafe aliases', () => {
  assert.throws(() => new SfOrg('uat & calc'), /Not a valid org alias/)
})

test('parseLooseJson skips warnings printed before JSON', () => {
  assert.deepEqual(parseLooseJson('Warning: update available\n{"status":0}'), {status: 0})
  assert.equal(parseLooseJson('no json here'), undefined)
})

test('inspectFlows maps versions, active version, and paused interviews', async () => {
  const {org} = fakeOrg()
  const states = await inspectFlows(org, ['Legacy_Router', 'Missing_Flow'])
  const flow = states.get('Legacy_Router')
  assert.equal(flow.activeVersionNumber, 2)
  assert.equal(flow.versions.length, 2)
  assert.equal(flow.pausedInterviews, 0)
  assert.deepEqual(states.get('Missing_Flow'), {name: 'Missing_Flow', versions: []})
})

test('sweepFlow backs up, deactivates, deletes every version, then verifies', async () => {
  const {calls, org} = fakeOrg()
  const state = (await inspectFlows(org, ['Legacy_Router'])).get('Legacy_Router')
  const dir = mkdtempSync(join(tmpdir(), 'flowsweep-backup-'))
  try {
    const result = await sweepFlow(org, state, dir)
    assert.equal(result.ok, true)
    assert.deepEqual(result.steps.map((s) => s.title), [
      'Back up versions',
      'Deactivate',
      'Delete version 1',
      'Delete version 2',
      'Verify',
    ])
    assert.equal(result.backupFiles.length, 2)
    assert.ok(readFileSync(result.backupFiles[0], 'utf8').includes('301000000000001AAA'))
    const methods = calls.filter((c) => c[0] === 'api').map((c) => c[c.indexOf('--method') + 1])
    assert.deepEqual(methods, ['GET', 'GET', 'PATCH', 'DELETE', 'DELETE'])
    assert.ok(calls.filter((c) => c[0] === 'api').every((c) => c[3].startsWith('/services/data/v62.0/tooling/sobjects/')))
  } finally {
    rmSync(dir, {force: true, recursive: true})
  }
})

test('sweepFlow stops at the first failed delete and reports it', async () => {
  const {org} = fakeOrg({failDeleteOf: '301000000000002AAA'})
  const state = (await inspectFlows(org, ['Legacy_Router'])).get('Legacy_Router')
  const dir = mkdtempSync(join(tmpdir(), 'flowsweep-backup-'))
  try {
    const result = await sweepFlow(org, state, dir)
    assert.equal(result.ok, false)
    const last = result.steps.at(-1)
    assert.equal(last.title, 'Delete version 2')
    assert.equal(last.status, 'failed')
    assert.match(last.detail, /Cannot delete active version/)
  } finally {
    rmSync(dir, {force: true, recursive: true})
  }
})
