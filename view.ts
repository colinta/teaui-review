import {
  Checkbox,
  Input,
  Separator,
  Stack,
  Style,
  Text,
  type View,
} from '@teaui/core'

import type {
  FileDiff,
  Patch,
  Reviewable,
  Section,
  SectionBlock,
  ParsedDiff,
} from './diff.js'
import {Sticky, StickyScroll, type StickyGroup} from './sticky.js'
import {textRuns} from './text-runs.js'

const STYLE_DIFF_LINE = new Style({bold: true})
const STYLE_EXTRA_HEADER = new Style({dim: true})
const STYLE_SECTION_HEADER = new Style({foreground: 'cyan', bold: true})
const STYLE_CONTEXT = new Style({})
const STYLE_ADD = new Style({foreground: 'green'})
const STYLE_REMOVE = new Style({foreground: 'red'})
const STYLE_META = new Style({dim: true, italic: true})
const STYLE_COLLAPSED = new Style({dim: true})

/**
 * A "[ ] ______" row: a checkbox that marks the item as reviewed (collapsing
 * whatever it precedes) paired with a free-text comment input. Only the
 * comment drives what ends up in the output patch; the checkbox is purely
 * for decluttering the view while reading.
 */
function reviewRow(
  indent: number,
  item: Reviewable,
  onReviewedChange: (value: boolean) => void,
  onChange: () => void,
): View {
  const checkbox = new Checkbox({
    value: item.reviewed,
    onChange: value => {
      item.reviewed = value
      onReviewedChange(value)
      onChange()
    },
  })
  const input = new Input({
    value: item.comment,
    placeholder: 'add a comment…',
    multiline: true,
    wrap: true,
    onChange: value => {
      item.comment = value
      onChange()
    },
  })
  return Stack.right({
    paddingLeft: indent,
    // keeps the checkbox on the first line of a multi-line comment
    children: [Stack.down([checkbox]), ['flex1', input]],
  })
}

function line(text: string, style: Style, indent: number): Text {
  return new Text({text, style, paddingLeft: indent})
}

/**
 * `trailing` is the context that follows the patch (up to the next patch) -
 * it's folded along with the patch lines.
 */
function buildPatchView(
  patch: Patch,
  trailing: View[],
  indent: number,
  onChange: () => void,
): View {
  const changes: View[] = []
  let kind: Patch['lines'][number]['kind'] | undefined
  let run: string[] = []
  const flush = () => {
    const style = kind === 'add' ? STYLE_ADD : STYLE_REMOVE
    changes.push(...textRuns(run).map(text => line(text, style, indent)))
    run = []
  }
  for (const change of patch.lines) {
    if (change.kind !== kind) {
      flush()
      kind = change.kind
    }
    run.push(`${change.kind === 'add' ? '+' : '-'}${change.text}`)
  }
  flush()

  const content = Stack.down({children: [...changes, ...trailing]})
  content.isVisible = !patch.reviewed

  const header = reviewRow(
    indent,
    patch,
    value => {
      content.isVisible = !value
    },
    onChange,
  )

  return Stack.down({children: [header, content]})
}

function buildContextView(
  block: Exclude<SectionBlock, {type: 'patch'}>,
  indent: number,
): View {
  if (block.type === 'meta') {
    return line(block.raw, STYLE_META, indent)
  }
  const views = textRuns(block.lines.map(text => ` ${text}`)).map(text =>
    line(text, STYLE_CONTEXT, indent),
  )
  return views.length === 1 ? views[0] : Stack.down({children: views})
}

/**
 * Each patch owns the context after it, up to the next patch, so that folding
 * a patch hides everything until the next checkbox. Context before the first
 * patch isn't owned by any patch and stays visible.
 */
function buildSectionBlockViews(
  blocks: SectionBlock[],
  indent: number,
  onChange: () => void,
): View[] {
  const views: View[] = []
  let current: {patch: Patch; trailing: View[]} | undefined

  function flush() {
    if (current) {
      views.push(
        buildPatchView(current.patch, current.trailing, indent, onChange),
      )
    }
  }

  for (const block of blocks) {
    if (block.type === 'patch') {
      flush()
      current = {patch: block.patch, trailing: []}
    } else if (current) {
      current.trailing.push(buildContextView(block, indent))
    } else {
      views.push(buildContextView(block, indent))
    }
  }
  flush()

  return views
}

function buildSectionView(
  section: Section,
  indent: number,
  onChange: () => void,
): StickyGroup {
  const blocksContent = Stack.down({
    children: buildSectionBlockViews(section.blocks, indent + 2, onChange),
  })
  blocksContent.isVisible = !section.reviewed

  const headerText = line(section.headerLine, STYLE_SECTION_HEADER, indent)
  if (section.reviewed) {
    headerText.style = STYLE_COLLAPSED
  }

  const header = reviewRow(
    indent,
    section,
    value => {
      blocksContent.isVisible = !value
      headerText.style = value ? STYLE_COLLAPSED : STYLE_SECTION_HEADER
      sticky.unpin()
    },
    onChange,
  )

  const sticky = new Sticky(Stack.down({children: [header, headerText]}))
  const block = Stack.down({children: [sticky, blocksContent]})
  return {block, sticky, children: []}
}

function buildFileView(file: FileDiff, onChange: () => void): StickyGroup {
  const metaLines: View[] = file.extraHeaderLines.map(l =>
    line(l, STYLE_EXTRA_HEADER, 2),
  )
  if (file.fromLine !== undefined) {
    metaLines.push(line(file.fromLine, STYLE_EXTRA_HEADER, 2))
  }
  if (file.toLine !== undefined) {
    metaLines.push(line(file.toLine, STYLE_EXTRA_HEADER, 2))
  }

  const sections = file.sections.map(s => buildSectionView(s, 2, onChange))
  const belowHeader = Stack.down({
    children: [...metaLines, ...sections.map(s => s.block)],
  })
  belowHeader.isVisible = !file.reviewed

  const diffLineText = line(file.diffLine, STYLE_DIFF_LINE, 0)
  if (file.reviewed) {
    diffLineText.style = STYLE_COLLAPSED
  }

  const header = reviewRow(
    0,
    file,
    value => {
      belowHeader.isVisible = !value
      diffLineText.style = value ? STYLE_COLLAPSED : STYLE_DIFF_LINE
      sticky.unpin()
    },
    onChange,
  )

  const sticky = new Sticky(Stack.down({children: [header, diffLineText]}))
  const block = Stack.down({children: [sticky, belowHeader]})
  return {block, sticky, children: sections}
}

/**
 * `onChange` is called whenever a checkbox or comment changes (the new state
 * has already been written to `parsed`).
 */
export function buildReviewView(
  parsed: ParsedDiff,
  onChange: () => void,
): View {
  const children: View[] = []
  const groups: StickyGroup[] = []

  if (parsed.preamble.length) {
    children.push(
      Stack.down({
        children: parsed.preamble.map(l => line(l, STYLE_META, 0)),
      }),
    )
  }

  for (const file of parsed.files) {
    const group = buildFileView(file, onChange)
    groups.push(group)
    children.push(group.block)
    children.push(Separator.horizontal())
  }

  return new StickyScroll({children, groups})
}
