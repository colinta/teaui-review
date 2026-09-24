import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {reviewItems, type ParsedDiff} from './diff.js'

/**
 * Keyed by the item's index in `reviewItems()`. Only items that are checked
 * or have a comment are stored.
 */
type SavedReview = Record<number, SavedItem>

interface SavedItem {
  checked: boolean
  comment: string
}

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * Reviews are saved per working directory *and* per diff, so indexes only
 * ever refer to the same diff they were saved against.
 */
export function reviewPath(cwd: string, diffText: string): string {
  return path.join(
    os.homedir(),
    '.config',
    'tui-review',
    `${hash(cwd)}-${hash(diffText)}`,
  )
}

/**
 * Copies saved checkbox/comment state into `parsed`. A missing or unreadable
 * file just means there's nothing to restore.
 */
export function loadReview(file: string, parsed: ParsedDiff) {
  let saved: SavedReview
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return
  }

  const items = reviewItems(parsed)
  for (const [key, entry] of Object.entries(saved)) {
    const item = items[Number(key)]
    if (!item || !entry) {
      continue
    }
    item.reviewed = entry.checked === true
    item.comment = typeof entry.comment === 'string' ? entry.comment : ''
  }
}

export function saveReview(file: string, parsed: ParsedDiff) {
  const saved: SavedReview = {}
  reviewItems(parsed).forEach((item, index) => {
    if (item.reviewed || item.comment) {
      saved[index] = {checked: item.reviewed, comment: item.comment}
    }
  })

  if (Object.keys(saved).length === 0) {
    fs.rmSync(file, {force: true})
    return
  }

  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n')
}
