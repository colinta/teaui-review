#!/usr/bin/env node
// Driver for `review --remote`. Reads one command per stdin line, sends it to
// the running app over its remote-control WebSocket, prints each reply as JSON.
//
// Usage:
//   node scripts/remote.mjs [endpoint.json] <<'EOF'
//   snapshot            plain-text snapshot (same as: snapshot plain)
//   snapshot ansi       styled snapshot
//   key j               key press; any TeaUI "full" name: j, down, enter, C-c, S-tab
//   type hello          sends each character as a key press
//   click 10 4          mouse down + up at column 10, row 4 (zero-based cells)
//   wheel down 10 4     mouse.wheel.up/down/left/right at x y
//   paste some text
//   wait 200            sleep (ms) - async work isn't covered by an ACK
//   {"type":"key",...}  raw SystemEvent / snapshot request JSON
//
// Default endpoint: $TMPDIR/review-remote.json (what `review --remote` writes).
// Use `snapshot` with `jq -r .snapshot` to see the screen.
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createInterface} from 'node:readline'

const endpointFile =
  process.argv[2] ?? path.join(os.tmpdir(), 'review-remote.json')

let url
try {
  ;({url} = JSON.parse(readFileSync(endpointFile, 'utf8')))
} catch (error) {
  console.error(
    `Cannot read ${endpointFile} (${error.message}). Is \`review --remote\` running?`,
  )
  process.exit(1)
}

const NAMED = new Set([
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'space',
])

function keyEvent(full) {
  const match = /^((?:[CAGS]-)*)(.+)$/.exec(full)
  const [, mods, name] = match
  const char = name === 'space' ? ' ' : NAMED.has(name) ? '' : name
  return {
    type: 'key',
    name,
    char,
    full,
    ctrl: mods.includes('C-'),
    alt: mods.includes('A-'),
    gui: mods.includes('G-'),
    shift: mods.includes('S-'),
  }
}

function mouseEvent(name, x, y, button = 'left') {
  return {
    type: 'mouse',
    name,
    x: Number(x),
    y: Number(y),
    button,
    ctrl: false,
    alt: false,
    gui: false,
    shift: false,
  }
}

/** Returns a list of events to send, or a number (ms) to sleep. */
function parse(line) {
  if (line.startsWith('{')) return [JSON.parse(line)]
  const [cmd, ...rest] = line.split(' ')
  const arg = rest.join(' ')
  switch (cmd) {
    case 'snapshot':
      return [{type: 'snapshot', format: arg || 'plain'}]
    case 'key':
      return [keyEvent(arg)]
    case 'type':
      return [...arg].map(ch => keyEvent(ch))
    case 'click': {
      const [x, y] = rest
      return [
        mouseEvent('mouse.button.down', x, y),
        mouseEvent('mouse.button.up', x, y),
      ]
    }
    case 'wheel': {
      const [dir, x, y] = rest
      return [mouseEvent(`mouse.wheel.${dir}`, x, y, 'wheel')]
    }
    case 'paste':
      return [{type: 'paste', text: arg}]
    case 'wait':
      return Number(arg)
    default:
      throw new Error(`Unknown command: ${line}`)
  }
}

const socket = new WebSocket(url)
let sequence = 0
const pending = new Map()

socket.addEventListener('message', ({data}) => {
  const message = JSON.parse(String(data))
  if (message.sequence === undefined) return // broadcast, not a reply
  pending.get(message.sequence)?.(message)
})
socket.addEventListener('close', () => {
  for (const resolve of pending.values()) resolve({type: 'closed'})
})

function send(event) {
  const expected = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No reply in 30s')), 30_000)
    pending.set(expected, reply => {
      clearTimeout(timer)
      pending.delete(expected)
      resolve(reply)
    })
    socket.send(JSON.stringify(event))
  })
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true})
    socket.addEventListener(
      'error',
      () => reject(new Error('Connect failed')),
      {
        once: true,
      },
    )
  })
  const lines = createInterface({input: process.stdin, crlfDelay: Infinity})
  for await (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const work = parse(line)
    if (typeof work === 'number') {
      await new Promise(resolve => setTimeout(resolve, work))
      continue
    }
    for (const event of work) {
      const reply = await send(event)
      console.log(JSON.stringify(reply))
      if (reply.type === 'closed') process.exit(0)
      if (reply.type === 'error') process.exitCode = 1
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  socket.close()
}
