#!/usr/bin/env node
import fs from 'node:fs'
import tty from 'node:tty'

import {Command} from 'commander'
import {
  AutoLegend,
  Screen,
  Stack,
  Window,
  interceptConsoleLog,
} from '@teaui/core'

import {parseDiff, serializeDiff} from './diff.js'
import {loadReview, reviewPath, saveReview} from './persist.js'
import {buildReviewView} from './view.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The diff text arrives on the same stdin the TUI needs for keyboard/mouse
 * input, so once it's fully read, stdin is reopened against the controlling
 * terminal.
 */
function reopenStdinAsTty() {
  const fd = fs.openSync('/dev/tty', 'r')
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: new tty.ReadStream(fd),
  })
}

async function run(outputPath: string) {
  if (process.stdin.isTTY) {
    console.error(
      'review: expected a unified diff on stdin, e.g.\n\n  git diff | review',
    )
    process.exitCode = 1
    return
  }

  const diffText = await readStdin()
  const parsed = parseDiff(diffText)

  if (parsed.files.length === 0) {
    console.error('review: no files found in the diff on stdin')
    process.exitCode = 1
    return
  }

  const savePath = reviewPath(process.cwd(), diffText)
  loadReview(savePath, parsed)

  reopenStdinAsTty()

  const view = buildReviewView(parsed, () => saveReview(savePath, parsed))

  interceptConsoleLog()
  const [screen] = await Screen.start(
    () =>
      new Window({
        child: Stack.down({
          children: [
            ['flex1', view],
            ['natural', new AutoLegend()],
          ],
        }),
      }),
    {quitChar: 'C-c'},
  )

  screen.onExit(() => {
    saveReview(savePath, parsed)
    fs.writeFileSync(outputPath, serializeDiff(parsed))
    console.log(`review: wrote ${outputPath}`)
  })
}

new Command()
  .name('review')
  .description(
    'Interactively review a unified diff from stdin, marking sections as ' +
      'accepted or leaving comments. On exit, writes a patch containing only ' +
      'the commented sections.',
  )
  .argument('[output]', 'path to write the reviewed patch to', 'patch.diff')
  .action(async (output: string) => {
    try {
      await run(output)
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    }
  })
  .parseAsync()
