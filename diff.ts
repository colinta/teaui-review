export type PatchLineKind = 'add' | 'remove'

export interface PatchLine {
  kind: PatchLineKind
  text: string
}

export interface Patch {
  lines: PatchLine[]
  reviewed: boolean
  comment: string
}

export type SectionBlock =
  | {type: 'context'; lines: string[]}
  | {type: 'patch'; patch: Patch}
  | {type: 'meta'; raw: string}

export interface Section {
  headerLine: string
  blocks: SectionBlock[]
  reviewed: boolean
  comment: string
}

export interface FileDiff {
  diffLine: string
  extraHeaderLines: string[]
  fromLine?: string
  toLine?: string
  sections: Section[]
  reviewed: boolean
  comment: string
}

export interface ParsedDiff {
  preamble: string[]
  files: FileDiff[]
}

const DIFF_HEADER_RE = /^diff\s+\S/
const SECTION_RE = /^@@ /

/**
 * Parses a unified diff (as produced by `git diff`, `diff -u`, etc) from
 * plain text into a tree of files, sections (hunks), and patches
 * (consecutive runs of removed/added lines).
 */
export function parseDiff(input: string): ParsedDiff {
  const lines = input.split('\n')
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const preamble: string[] = []
  const files: FileDiff[] = []

  let currentFile: FileDiff | undefined
  let currentSection: Section | undefined
  let state: 'top' | 'header' | 'hunk' = 'top'

  function closeSection() {
    if (currentSection) {
      currentFile!.sections.push(currentSection)
      currentSection = undefined
    }
  }

  function closeFile() {
    closeSection()
    if (currentFile) {
      files.push(currentFile)
      currentFile = undefined
    }
  }

  function lastBlock(): SectionBlock | undefined {
    return currentSection!.blocks.at(-1)
  }

  function addContextLine(text: string) {
    const last = lastBlock()
    if (last && last.type === 'context') {
      last.lines.push(text)
    } else {
      currentSection!.blocks.push({type: 'context', lines: [text]})
    }
  }

  function addPatchLine(kind: PatchLineKind, text: string) {
    const last = lastBlock()
    if (last && last.type === 'patch') {
      last.patch.lines.push({kind, text})
    } else {
      currentSection!.blocks.push({
        type: 'patch',
        patch: {lines: [{kind, text}], reviewed: false, comment: ''},
      })
    }
  }

  for (const line of lines) {
    if (DIFF_HEADER_RE.test(line)) {
      closeFile()
      currentFile = {
        diffLine: line,
        extraHeaderLines: [],
        sections: [],
        reviewed: false,
        comment: '',
      }
      state = 'header'
      continue
    }

    if (state === 'top') {
      preamble.push(line)
      continue
    }

    if (state === 'header') {
      if (line.startsWith('index ')) {
        currentFile!.extraHeaderLines.push(line)
        continue
      }
      if (line.startsWith('--- ') || line === '---') {
        currentFile!.fromLine = line
        continue
      }
      if (line.startsWith('+++ ') || line === '+++') {
        currentFile!.toLine = line
        continue
      }
      if (SECTION_RE.test(line)) {
        closeSection()
        currentSection = {
          headerLine: line,
          blocks: [],
          reviewed: false,
          comment: '',
        }
        state = 'hunk'
        continue
      }
      // extended header lines: old/new mode, similarity index, rename
      // from/to, "Binary files ... differ", etc.
      currentFile!.extraHeaderLines.push(line)
      continue
    }

    // state === 'hunk'
    if (SECTION_RE.test(line)) {
      closeSection()
      currentSection = {
        headerLine: line,
        blocks: [],
        reviewed: false,
        comment: '',
      }
      continue
    }
    if (line.startsWith('-')) {
      addPatchLine('remove', line.slice(1))
    } else if (line.startsWith('+')) {
      addPatchLine('add', line.slice(1))
    } else if (line.startsWith(' ')) {
      addContextLine(line.slice(1))
    } else if (line === '') {
      addContextLine('')
    } else {
      currentSection!.blocks.push({type: 'meta', raw: line})
    }
  }

  closeFile()

  return {preamble, files}
}

function commentLines(comment: string): string[] {
  return comment
    .trim()
    .split('\n')
    .map(line => `#> ${line}`.trimEnd())
}

function sectionHasComment(section: Section): boolean {
  if (section.comment.trim()) {
    return true
  }
  return section.blocks.some(
    block => block.type === 'patch' && Boolean(block.patch.comment.trim()),
  )
}

/**
 * Serializes the (possibly edited) diff back into unified-diff text,
 * keeping only files/sections that have review comments attached.
 * Review comments are embedded as `#>` lines immediately following the
 * header/patch they annotate, so an LLM reading the resulting patch can
 * see exactly what was flagged and why.
 */
export function serializeDiff(parsed: ParsedDiff): string {
  const out: string[] = []

  for (const file of parsed.files) {
    const qualifyingSections = file.sections.filter(sectionHasComment)
    const fileHasComment = Boolean(file.comment.trim())
    if (!fileHasComment && qualifyingSections.length === 0) {
      continue
    }

    out.push(file.diffLine)
    if (fileHasComment) {
      out.push(...commentLines(file.comment))
    }
    out.push(...file.extraHeaderLines)
    if (file.fromLine !== undefined) {
      out.push(file.fromLine)
    }
    if (file.toLine !== undefined) {
      out.push(file.toLine)
    }

    for (const section of qualifyingSections) {
      out.push(section.headerLine)
      if (section.comment.trim()) {
        out.push(...commentLines(section.comment))
      }
      for (const block of section.blocks) {
        if (block.type === 'context') {
          out.push(...block.lines.map(line => ` ${line}`))
        } else if (block.type === 'meta') {
          out.push(block.raw)
        } else {
          out.push(
            ...block.patch.lines.map(
              line => `${line.kind === 'add' ? '+' : '-'}${line.text}`,
            ),
          )
          if (block.patch.comment.trim()) {
            out.push(...commentLines(block.patch.comment))
          }
        }
      }
    }
  }

  if (out.length === 0) {
    return ''
  }

  return out.join('\n') + '\n'
}
