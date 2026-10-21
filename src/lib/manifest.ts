import {mkdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>'

export function packageXml(apiVersion: string, flowNames: readonly string[] = []): string {
  const types =
    flowNames.length > 0
      ? `    <types>\n${[...flowNames].sort().map((name) => `        <members>${name}</members>\n`).join('')}        <name>Flow</name>\n    </types>\n`
      : ''
  return `${xmlHeader}\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}    <version>${apiVersion}</version>\n</Package>\n`
}

/** Writes an empty package.xml plus destructiveChangesPost.xml for pipelines that deploy with the Metadata API. */
export async function writeDestructiveManifest(dir: string, apiVersion: string, flowNames: readonly string[]): Promise<string[]> {
  await mkdir(dir, {recursive: true})
  const files = [join(dir, 'package.xml'), join(dir, 'destructiveChangesPost.xml')]
  await writeFile(files[0], packageXml(apiVersion), 'utf8')
  await writeFile(files[1], packageXml(apiVersion, flowNames), 'utf8')
  return files
}
