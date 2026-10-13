import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Scrollable, Stack, Style, Text, testRender} from '@teaui/core'
import {textRuns} from '../.dist/text-runs.js'
import {parseDiff} from '../.dist/diff.js'
import {buildReviewView} from '../.dist/view.js'

function textTree(view) {
  return [
    ...(view instanceof Text ? [view] : []),
    ...view.children.flatMap(textTree),
  ]
}

test('plain runs are joined, while empty and escaped lines stay isolated', () => {
  assert.deepEqual(textRuns([]), [])
  assert.deepEqual(
    textRuns([' a', ' b', '', ' c', '\x1b[31mred', ' d', ' e']),
    [' a\n b', '', ' c', '\x1b[31mred', ' d\n e'],
  )
  assert.deepEqual(textRuns(['a', '\x9b31mred', 'b']), ['a', '\x9b31mred', 'b'])
})

test('batched and individual Text views have identical styled frames while scrolling', () => {
  const lines = [
    '+short',
    '+',
    '+wide 界🙂 e\u0301',
    '+tab\there',
    '+' + 'long '.repeat(15),
    '+\x1b[31mred without reset',
    '+green again',
    '+\x1b]8;;https://example.test\x1b\\link without close',
    '+not linked',
    '+last',
    '',
  ]
  for (const width of [5, 12, 30]) {
    const render = input => {
      const style = new Style({foreground: 'green'})
      const content = Stack.down(
        input.map(text => new Text({text, style, paddingLeft: 2})),
      )
      const view = new Scrollable({showScrollbars: false, children: [content]})
      return {view, t: testRender(view, {width, height: 4})}
    }
    const original = render(lines)
    const batched = render(textRuns(lines))
    try {
      const compare = () =>
        assert.equal(
          batched.view.screen.snapshot(),
          original.view.screen.snapshot(),
        )
      compare()
      for (const [x, y] of [
        [0, 1],
        [0, 3],
        [0, 1],
        [4, 0],
        [0, 2],
        [-4, -8],
      ]) {
        for (const {view, t} of [original, batched]) {
          view.scrollBy(x, y)
          t.render()
        }
        compare()
      }
    } finally {
      original.view.screen.stop()
      batched.view.screen.stop()
    }
  }
})

test('patch grouping preserves sign/style boundaries and patch folding', () => {
  const parsed = parseDiff(
    [
      'diff --git a/example b/example',
      'index abc..def 100644',
      '--- a/example',
      '+++ b/example',
      '@@ -1,5 +1,5 @@',
      ' leading',
      ' context',
      '-old one',
      '-old two',
      '+new one',
      '+new two',
      '-old three',
      '+new three',
      ' trailing',
      ' context',
      '',
    ].join('\n'),
  )
  const root = buildReviewView(parsed, () => {})
  const texts = textTree(root)
  const removals = texts.filter(t => t.text.startsWith('-old'))
  const additions = texts.filter(t => t.text.startsWith('+new'))
  assert.deepEqual(
    removals.map(t => t.text),
    ['-old one\n-old two', '-old three'],
  )
  assert.deepEqual(
    additions.map(t => t.text),
    ['+new one\n+new two', '+new three'],
  )
  for (const text of removals)
    assert.ok(text.style.isEqual(new Style({foreground: 'red'})))
  for (const text of additions)
    assert.ok(text.style.isEqual(new Style({foreground: 'green'})))
  assert.ok(texts.some(t => t.text === ' leading\n context'))
  assert.ok(texts.some(t => t.text === ' trailing\n context'))
  const t = testRender(root, {width: 40, height: 25})
  try {
    const initial = t.terminal.textContent()
    const patch = parsed.files[0].sections[0].blocks.find(
      b => b.type === 'patch',
    ).patch
    // File header/meta (5), section header (2), leading context (2): patch row 9.
    t.sendMouse('mouse.button.down', {x: 4, y: 9})
    t.sendMouse('mouse.button.up', {x: 4, y: 9})
    assert.equal(patch.reviewed, true)
    assert.ok(!t.terminal.textContent().includes('old one'))
    assert.ok(!t.terminal.textContent().includes('trailing'))
    assert.ok(t.terminal.textContent().includes('leading'))
    t.sendMouse('mouse.button.down', {x: 4, y: 9})
    t.sendMouse('mouse.button.up', {x: 4, y: 9})
    assert.equal(patch.reviewed, false)
    // Mouse hover changes ANSI styling; compare the visible text after unfolding.
    assert.equal(t.terminal.textContent(), initial)
  } finally {
    root.screen.stop()
  }
})
