#!/usr/bin/env node
/**
 * Regenerate every README support-matrix block from the code.
 *
 * The matrix in `src/matrix.js` is derived from the vendor adapter tables, so
 * the code is the single source of truth. This script writes that render into
 * each README between `<!-- MATRIX:START -->` and `<!-- MATRIX:END -->`, and
 * `test/matrix-readme.test.js` fails when any of them drift.
 *
 * Every translated README is listed here deliberately: a translated document
 * that is not regenerated would be able to overclaim capability in a language
 * the drift test never reads, which is exactly the failure mode the matrix
 * exists to prevent.
 *
 * @module dsh-compat-adapter/scripts/write-matrix
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { MATRIX_END as END, MATRIX_START as START, README_FILES } from '../src/matrix.js'

const projectDir = join(new URL('.', import.meta.url).pathname, '..')
const { renderMatrixMarkdown } = await import(pathToFileURL(join(projectDir, 'src/matrix.js')).href)

if (process.argv.includes('--print')) {
  process.stdout.write(`${renderMatrixMarkdown().trim()}\n`)
  process.exit(0)
}

let failed = false
for (const file of README_FILES) {
  const readmePath = join(projectDir, file)
  let readme
  try {
    readme = readFileSync(readmePath, 'utf8')
  } catch {
    process.stderr.write(`write-matrix: cannot read ${file}\n`)
    failed = true
    continue
  }
  const start = readme.indexOf(START)
  const end = readme.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    process.stderr.write(`write-matrix: ${file} needs both ${START} and ${END} markers\n`)
    failed = true
    continue
  }
  const next = `${readme.slice(0, start + START.length)}\n\n${renderMatrixMarkdown().trim()}\n\n${readme.slice(end)}`
  writeFileSync(readmePath, next, 'utf8')
  process.stdout.write(`write-matrix: ${file} matrix block regenerated from src/matrix.js\n`)
}
if (failed) process.exitCode = 1
