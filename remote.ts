import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {Screen} from '@teaui/core'
import {RemoteControlServer} from '@teaui/remote-control'

export const DEFAULT_REMOTE_ENDPOINT = path.join(
  os.tmpdir(),
  'review-remote.json',
)

/**
 * Opt-in debugging: exposes the running TUI over a local WebSocket so another
 * process (a CLI, or a chat/agent session) can send key/mouse events and read
 * snapshots of the screen. See `scripts/remote.mjs` for the driver.
 *
 * The connection URL contains a secret token, so it is written to a private
 * (0600) endpoint file, never to stdout (that would corrupt the TUI). The file
 * is removed when the screen exits.
 */
export function startRemoteControl(screen: Screen, endpointFile: string) {
  const remote = new RemoteControlServer()
  const detachSource = screen.addEventSource(remote)
  const detachSnapshot = remote.setSnapshotProvider(() => screen.snapshot())

  const removeEndpoint = () => fs.rmSync(endpointFile, {force: true})

  remote.onError(error => {
    console.error(`review: remote control: ${error.message}`)
  })
  remote.onListening(({url, port}) => {
    fs.writeFileSync(endpointFile, JSON.stringify({url, port}), {mode: 0o600})
  })

  screen.onExit(() => {
    detachSource()
    detachSnapshot()
    removeEndpoint()
    void remote.close()
  })

  void remote.listen()
}
