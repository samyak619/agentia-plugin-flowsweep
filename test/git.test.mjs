import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, before, test} from 'node:test'

import {findReferences, listDeletedFlows, resolveBase, resolveRepoRoot} from '../dist/lib/git.js'

let repo

const git = (...args) => execFileSync('git', args, {cwd: repo, stdio: 'pipe'}).toString()
const write = (path, content) => {
  mkdirSync(join(repo, path, '..'), {recursive: true})
  writeFileSync(join(repo, path), content)
}
const flowXml = (body = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">${body}</Flow>\n`
const FLOWS = 'force-app/main/default/flows'

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'flowsweep-git-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  write(`${FLOWS}/Legacy_Router.flow-meta.xml`, flowXml())
  write(`${FLOWS}/Orphan_Flow.flow-meta.xml`, flowXml())
  write(`${FLOWS}/Parent.flow-meta.xml`, flowXml('<subflows><flowName>Legacy_Router</flowName></subflows>'))
  write('force-app/main/default/classes/Router.cls', 'public class Router { Flow.Interview.Legacy_Router f; }')
  write('force-app/main/default/classes/Unrelated.cls', 'public class Unrelated { String s = \'Legacy_Router_v2\'; }')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', 'feature/US-1')
  git('rm', '-q', `${FLOWS}/Legacy_Router.flow-meta.xml`, `${FLOWS}/Orphan_Flow.flow-meta.xml`)
  git('commit', '-q', '-m', 'remove flows')
})

after(() => rmSync(repo, {force: true, recursive: true}))

test('resolveRepoRoot and resolveBase find the repo and main', async () => {
  assert.ok((await resolveRepoRoot(join(repo, 'force-app'))).length > 0)
  assert.equal(await resolveBase(repo, undefined, [undefined, 'main']), 'main')
  assert.equal(await resolveBase(repo, undefined, ['does-not-exist', 'main']), 'main')
  await assert.rejects(resolveBase(repo, undefined, ['nope']), /No base ref found/)
})

test('an explicit base is used exactly, never rewritten to origin/', async () => {
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  try {
    assert.equal(await resolveBase(repo, 'main', []), 'main')
    assert.equal(await resolveBase(repo, undefined, ['main']), 'origin/main')
    await assert.rejects(resolveBase(repo, 'nope', ['main']), /Base ref not found: nope/)
  } finally {
    git('update-ref', '-d', 'refs/remotes/origin/main')
  }
})

test('listDeletedFlows finds both deleted Flows', async () => {
  const deleted = await listDeletedFlows(repo, 'main', 'HEAD')
  assert.deepEqual(deleted.map((f) => f.name).sort(), ['Legacy_Router', 'Orphan_Flow'])
})

test('findReferences finds the subflow and Apex use, as whole words only', async () => {
  const refs = await findReferences(repo, 'HEAD', 'Legacy_Router')
  assert.deepEqual(refs.map((r) => r.kind).sort(), ['Apex', 'Flow (subflow or action)'])
  assert.ok(refs.every((r) => !r.path.endsWith('Unrelated.cls')))
  assert.deepEqual(await findReferences(repo, 'HEAD', 'Orphan_Flow'), [])
})

test('findReferences rejects names that are not Flow API names', async () => {
  await assert.rejects(findReferences(repo, 'HEAD', 'x; rm -rf'), /Not a Flow API name/)
})
