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
import {DEFAULT_REMOTE_ENDPOINT, startRemoteControl} from './remote.js'
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

async function run(outputPath: string, remoteEndpoint: string | undefined) {
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

  const save = () => saveReview(savePath, parsed)
  const view = buildReviewView(parsed, save)

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

  if (remoteEndpoint) {
    startRemoteControl(screen, remoteEndpoint)
  }

  screen.onExit(() => {
    save()
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
  .option(
    '--remote [endpoint-file]',
    'debugging: let another process drive the TUI (keys, mouse, screen ' +
      'snapshots) over a local WebSocket. The connection URL (a secret) is ' +
      `written to the endpoint file (default: ${DEFAULT_REMOTE_ENDPOINT}). ` +
      'See scripts/remote.mjs',
  )
  .action(async (output: string, options: {remote?: string | true}) => {
    const remoteEndpoint =
      options.remote === true ? DEFAULT_REMOTE_ENDPOINT : options.remote
    try {
      await run(output, remoteEndpoint)
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    }
  })
  .parseAsync()
