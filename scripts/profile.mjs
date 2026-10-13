#!/usr/bin/env node
// Real PTY + RemoteControl replay. Node 22+; run `pnpm build` first.
// Usage: node scripts/profile.mjs diff.diff [--burst] [--reference result.json]
// Artifacts are private in a fresh temp directory. Never edits the input patch,
// existing review state, or the app's usual patch.diff output.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {performance} from 'node:perf_hooks'
import pty from 'node-pty'
import xterm from '@xterm/headless'

const diff = path.resolve(process.argv[2] ?? 'diff.diff')
fs.accessSync(diff, fs.constants.R_OK)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-profile-'))
const endpoint = path.join(dir, 'remote.json')
const burst = process.argv.includes('--burst')
const referenceArg = process.argv.indexOf('--reference')
const referenceDir =
  referenceArg < 0
    ? undefined
    : JSON.parse(fs.readFileSync(process.argv[referenceArg + 1], 'utf8')).dir
const app = fileURLToPath(new URL('../.dist/bin.js', import.meta.url))
const quote = s => `'${s.replaceAll("'", "'\\''")}'`
const command =
  [process.execPath, app, path.join(dir, 'reviewed.diff'), '--remote', endpoint]
    .map(quote)
    .join(' ') + ` < ${quote(diff)}`
const terminal = new xterm.Terminal({
  cols: 120,
  rows: 40,
  allowProposedApi: true,
})
const child = pty.spawn('/bin/sh', ['-c', `exec ${command}`], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: dir,
  env: {...process.env, HOME: dir, TERM: 'xterm-256color'},
})
// Respond to terminal queries; never use PTY input to drive the UI.
terminal.onData(data => child.write(data))
let tail = ''
child.onData(data => {
  tail = (tail + data).slice(-4096)
  terminal.write(data)
})
let exited = false
const exit = new Promise(resolve =>
  child.onExit(event => {
    exited = true
    resolve(event)
  }),
)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket
const pending = new Map()
let sequence = 0
const samples = []

async function request(event, label) {
  const expected = ++sequence
  const start = performance.now()
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(expected)
      reject(new Error(`Timed out: ${label}`))
    }, 30_000)
    pending.set(expected, message => {
      clearTimeout(timer)
      pending.delete(expected)
      resolve(message)
    })
    socket.send(JSON.stringify(event))
  })
  if (reply.type === 'error') throw new Error(reply.message)
  if (label) samples.push({label, ms: performance.now() - start})
  return reply
}
const mouse = (name, x, y, button = 'left') => ({
  type: 'mouse',
  name: `mouse.${name}`,
  x,
  y,
  button,
  ctrl: false,
  alt: false,
  gui: false,
  shift: false,
})
async function click(x, y, label) {
  await request(mouse('button.down', x, y), `${label}.down`)
  await request(mouse('button.up', x, y), `${label}.up`)
}
async function snapshot(label, expected) {
  const deadline = performance.now() + 10_000
  let reply = await request({type: 'snapshot', format: 'plain'})
  while (expected !== undefined && reply.snapshot !== expected) {
    if (performance.now() > deadline)
      throw new Error(`Frame did not settle: ${label}`)
    await wait(2)
    reply = await request({type: 'snapshot', format: 'plain'})
  }
  if (!reply.snapshot || reply.snapshot.split('\n').length !== 40) {
    throw new Error(`Missing/incomplete screen: ${label}`)
  }
  fs.writeFileSync(path.join(dir, `${label}.txt`), reply.snapshot, {
    mode: 0o600,
  })
  const ansi = await request({type: 'snapshot', format: 'ansi'})
  fs.writeFileSync(path.join(dir, `${label}.ansi`), ansi.snapshot, {
    mode: 0o600,
  })
  return reply.snapshot
}

try {
  const deadline = Date.now() + 60_000
  while (!fs.existsSync(endpoint)) {
    if (exited) throw new Error(`App exited during startup: ${tail}`)
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for RemoteControl')
    await wait(25)
  }
  socket = new WebSocket(JSON.parse(fs.readFileSync(endpoint, 'utf8')).url)
  socket.addEventListener('message', ({data}) => {
    const message = JSON.parse(String(data))
    pending.get(message.sequence)?.(message)
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Connect timed out')),
      10_000,
    )
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      {once: true},
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('Connect failed'))
      },
      {once: true},
    )
  })
  await wait(100) // allow startup/focus work to settle
  const initial = await snapshot('initial')
  for (const [label, scrollbarY] of [
    ['top', 0],
    ['middle', 19],
    ['bottom', 35], // Inside the vertical track, not the scrollbar corner.
  ]) {
    if (scrollbarY) await click(119, scrollbarY, `jump.${label}`)
    const start = performance.now()
    const replies = []
    for (let i = 0; i < 12; i++) {
      const reply = request(
        mouse('wheel.down', 60, 20, 'wheel'),
        `scroll.${label}`,
      )
      replies.push(reply)
      if (burst) {
        // Handle early rejections while issuing the remaining events;
        // Promise.all below still reports any failure.
        void reply.catch(() => {})
        // Separate input arrival rate from rendering/ACK rate, like a trackpad.
        if (i < 11) await wait(4)
      } else {
        await reply
      }
    }
    await Promise.all(replies)
    const expected =
      referenceDir === undefined
        ? undefined
        : fs.readFileSync(path.join(referenceDir, `${label}.txt`), 'utf8')
    // ACK means delivered, not painted when wheel rendering is batched. Prefer
    // a baseline frame barrier; otherwise allow one frame interval to settle.
    if (expected === undefined) await wait(32)
    const current = await snapshot(label, expected)
    samples.push({label: `painted.${label}`, ms: performance.now() - start})
    if (current === initial)
      throw new Error(`Scrolling did not change the screen: ${label}`)
  }
  // Return to the top before toggling: don't assume a pinned header remains
  // at the same screen coordinates after a collapse/reveal.
  await click(119, 0, 'jump.top')
  const beforeCollapse = await snapshot('before-collapse')
  await click(0, 0, 'collapse')
  const collapsed = await snapshot('collapsed')
  if (collapsed === beforeCollapse)
    throw new Error('Checkbox did not collapse the file')
  await click(0, 0, 'expand')
  const expanded = await snapshot('expanded')
  if (expanded !== beforeCollapse)
    throw new Error('Checkbox did not restore the file')

  await click(10, 0, 'focus.comment')
  const annotation = 'profile annotation\nsecond line'
  await request({type: 'paste', text: annotation}, 'annotate')
  const annotated = await snapshot('annotated')
  if (
    !annotated.includes('profile annotation') ||
    !annotated.includes('second line')
  ) {
    throw new Error('Multiline annotation did not render')
  }

  // Screen.exit can close the transport before acknowledging quit.
  socket.send(
    JSON.stringify({
      type: 'key',
      name: 'c',
      char: 'c',
      full: 'C-c',
      ctrl: true,
      alt: false,
      gui: false,
      shift: false,
    }),
  )
  let quitTimer
  try {
    const status = await Promise.race([
      exit,
      new Promise((_, reject) => {
        quitTimer = setTimeout(() => reject(new Error('Quit timed out')), 5000)
      }),
    ])
    if (status.exitCode !== 0)
      throw new Error(`App exited with ${status.exitCode}`)
  } finally {
    clearTimeout(quitTimer)
  }
  const patch = fs.readFileSync(path.join(dir, 'reviewed.diff'), 'utf8')
  if (!patch.includes('#> profile annotation\n#> second line')) {
    throw new Error('Annotation was not serialized to the reviewed patch')
  }
  if (fs.existsSync(endpoint)) throw new Error('Remote endpoint not cleaned up')
  fs.writeFileSync(
    path.join(dir, 'samples.json'),
    JSON.stringify(samples, null, 2),
    {mode: 0o600},
  )
  console.log(
    JSON.stringify(
      {
        dir,
        burst,
        referenceDir,
        samples,
      },
      null,
      2,
    ),
  )
} finally {
  socket?.close()
  if (!exited) child.kill()
  terminal.dispose()
}
