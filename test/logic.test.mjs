import assert from 'node:assert/strict'
import {test} from 'node:test'

import {flowNameFromPath, parseDeletedFlows, parseGrep, referenceKind} from '../dist/lib/git.js'
import {packageXml} from '../dist/lib/manifest.js'
import {planFlow, summarize} from '../dist/lib/plan.js'

test('flowNameFromPath handles source and metadata formats', () => {
  assert.equal(flowNameFromPath('force-app/main/default/flows/Lead_Router.flow-meta.xml'), 'Lead_Router')
  assert.equal(flowNameFromPath('src/flows/Lead_Router-3.flow'), 'Lead_Router')
  assert.equal(flowNameFromPath('force-app\\main\\default\\flows\\A.flow-meta.xml'), 'A')
  assert.equal(flowNameFromPath('force-app/main/default/flowDefinitions/A.flowDefinition-meta.xml'), undefined)
  assert.equal(flowNameFromPath('force-app/main/default/classes/flows.cls'), undefined)
})

test('parseDeletedFlows keeps only deleted Flow files, once per Flow', () => {
  const z = [
    'D', 'force-app/main/default/flows/Old_One.flow-meta.xml',
    'M', 'force-app/main/default/flows/Kept.flow-meta.xml',
    'A', 'force-app/main/default/flows/New_One.flow-meta.xml',
    'D', 'force-app/main/default/classes/Gone.cls',
    'D', 'src/flows/Old_One-2.flow',
    'D', 'src/flows/Other-1.flow',
  ].join('\0') + '\0'
  assert.deepEqual(parseDeletedFlows(z), [
    {name: 'Old_One', path: 'force-app/main/default/flows/Old_One.flow-meta.xml'},
    {name: 'Other', path: 'src/flows/Other-1.flow'},
  ])
})

test('parseGrep strips the revision prefix and classifies files', () => {
  const out = [
    'HEAD:force-app/main/default/flows/Parent.flow-meta.xml:42:        <flowName>Old_One</flowName>',
    'HEAD:force-app/main/default/quickActions/Lead.Route.quickAction-meta.xml:5:<flowDefinition>Old_One</flowDefinition>',
    '',
  ].join('\n')
  const refs = parseGrep(out, 'HEAD')
  assert.equal(refs.length, 2)
  assert.deepEqual(refs[0], {
    kind: 'Flow (subflow or action)',
    line: 42,
    path: 'force-app/main/default/flows/Parent.flow-meta.xml',
    text: '<flowName>Old_One</flowName>',
  })
  assert.equal(refs[1].kind, 'Quick action')
  assert.equal(referenceKind('force-app/main/default/classes/X.cls'), 'Apex')
})

const flow = {name: 'Old_One', path: 'force-app/main/default/flows/Old_One.flow-meta.xml'}
const ref = {kind: 'Apex', line: 1, path: 'classes/A.cls', text: 'Old_One'}
const orgState = {
  activeVersionNumber: 2,
  definitionId: '300000000000001',
  name: 'Old_One',
  pausedInterviews: 0,
  versions: [
    {id: '301000000000001', status: 'Obsolete', versionNumber: 1},
    {id: '301000000000002', status: 'Active', versionNumber: 2},
  ],
}

test('planFlow without an org is not-checked, or blocked by references', () => {
  assert.equal(planFlow(flow, [], undefined, {ignoreReferences: false}).status, 'not-checked')
  const blocked = planFlow(flow, [ref], undefined, {ignoreReferences: false})
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.blockers[0], /referenced in 1 file/)
  assert.equal(planFlow(flow, [ref], undefined, {ignoreReferences: true}).status, 'not-checked')
})

test('planFlow with org state: ready, paused interviews, already gone', () => {
  const ready = planFlow(flow, [], orgState, {ignoreReferences: false})
  assert.equal(ready.status, 'ready')
  assert.ok(ready.steps.includes('Deactivate version 2'))
  assert.ok(ready.steps.includes('Delete version(s) 1, 2'))

  const paused = planFlow(flow, [], {...orgState, pausedInterviews: 3}, {ignoreReferences: false})
  assert.equal(paused.status, 'blocked')
  assert.match(paused.blockers[0], /3 paused interview/)

  const unknown = planFlow(flow, [], {...orgState, pausedInterviews: undefined, pausedInterviewsError: 'no access'}, {ignoreReferences: false})
  assert.equal(unknown.status, 'ready')
  assert.match(unknown.warnings[0], /no access/)

  assert.equal(planFlow(flow, [], {name: 'Old_One', versions: []}, {ignoreReferences: false}).status, 'already-gone')
})

test('summarize counts each status', () => {
  const findings = [
    planFlow(flow, [], orgState, {ignoreReferences: false}),
    planFlow(flow, [ref], orgState, {ignoreReferences: false}),
    planFlow(flow, [], {name: 'Old_One', versions: []}, {ignoreReferences: false}),
  ]
  assert.deepEqual(summarize(findings), {'already-gone': 1, blocked: 1, 'not-checked': 0, ready: 1})
})

test('packageXml lists sorted Flow members, or none', () => {
  assert.doesNotMatch(packageXml('62.0'), /<types>/)
  const xml = packageXml('62.0', ['B_Flow', 'A_Flow'])
  assert.ok(xml.indexOf('A_Flow') < xml.indexOf('B_Flow'))
  assert.match(xml, /<name>Flow<\/name>/)
  assert.match(xml, /<version>62.0<\/version>/)
})
