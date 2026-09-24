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
  Section,
  SectionBlock,
  ParsedDiff,
} from './diff.js'
import {Sticky, StickyScroll, type StickyGroup} from './sticky.js'

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
  reviewed: boolean,
  comment: string,
  onReviewedChange: (value: boolean) => void,
  onCommentChange: (value: string) => void,
): View {
  const checkbox = new Checkbox({
    value: reviewed,
    onChange: onReviewedChange,
  })
  const input = new Input({
    value: comment,
    placeholder: 'add a comment…',
    multiline: true,
    wrap: true,
    onChange: onCommentChange,
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

function buildPatchView(patch: Patch, indent: number): View {
  const content = Stack.down({
    children: patch.lines.map(l =>
      line(
        `${l.kind === 'add' ? '+' : '-'}${l.text}`,
        l.kind === 'add' ? STYLE_ADD : STYLE_REMOVE,
        indent,
      ),
    ),
  })
  content.isVisible = !patch.reviewed

  const header = reviewRow(
    indent,
    patch.reviewed,
    patch.comment,
    value => {
      patch.reviewed = value
      content.isVisible = !value
    },
    value => {
      patch.comment = value
    },
  )

  return Stack.down({children: [header, content]})
}

function buildSectionBlockView(block: SectionBlock, indent: number): View {
  if (block.type === 'context') {
    return Stack.down({
      children: block.lines.map(text =>
        line(` ${text}`, STYLE_CONTEXT, indent),
      ),
    })
  }
  if (block.type === 'meta') {
    return line(block.raw, STYLE_META, indent)
  }
  return buildPatchView(block.patch, indent)
}

function buildSectionView(section: Section, indent: number): StickyGroup {
  const blocksContent = Stack.down({
    children: section.blocks.map(b => buildSectionBlockView(b, indent + 2)),
  })
  blocksContent.isVisible = !section.reviewed

  const headerText = line(section.headerLine, STYLE_SECTION_HEADER, indent)
  if (section.reviewed) {
    headerText.style = STYLE_COLLAPSED
  }

  const header = reviewRow(
    indent,
    section.reviewed,
    section.comment,
    value => {
      section.reviewed = value
      blocksContent.isVisible = !value
      headerText.style = value ? STYLE_COLLAPSED : STYLE_SECTION_HEADER
    },
    value => {
      section.comment = value
    },
  )

  const sticky = new Sticky(Stack.down({children: [header, headerText]}))
  const block = Stack.down({children: [sticky, blocksContent]})
  return {block, sticky, children: []}
}

function buildFileView(file: FileDiff): StickyGroup {
  const metaLines: View[] = file.extraHeaderLines.map(l =>
    line(l, STYLE_EXTRA_HEADER, 2),
  )
  if (file.fromLine !== undefined) {
    metaLines.push(line(file.fromLine, STYLE_EXTRA_HEADER, 2))
  }
  if (file.toLine !== undefined) {
    metaLines.push(line(file.toLine, STYLE_EXTRA_HEADER, 2))
  }

  const sections = file.sections.map(s => buildSectionView(s, 2))
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
    file.reviewed,
    file.comment,
    value => {
      file.reviewed = value
      belowHeader.isVisible = !value
      diffLineText.style = value ? STYLE_COLLAPSED : STYLE_DIFF_LINE
    },
    value => {
      file.comment = value
    },
  )

  const sticky = new Sticky(Stack.down({children: [header, diffLineText]}))
  const block = Stack.down({children: [sticky, belowHeader]})
  return {block, sticky, children: sections}
}

export function buildReviewView(parsed: ParsedDiff): View {
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
    const group = buildFileView(file)
    groups.push(group)
    children.push(group.block)
    children.push(Separator.horizontal())
  }

  return new StickyScroll({children, groups})
}
