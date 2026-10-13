import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Input, Point, Screen, Stack, Text, TestProgram} from '@teaui/core'
import {Sticky, StickyScroll} from '../.dist/sticky.js'

function group(name, children = [], paddingTop = 0) {
  const comment = new Input({value: name, multiline: true, wrap: true})
  const sticky = new Sticky(
    Stack.down([comment, new Text({text: `${name} header`})]),
  )
  const body = Stack.down([
    new Text({text: `${name} body\nsecond line\nthird line`}),
    ...children.map(g => g.block),
  ])
  const block = Stack.down({paddingTop, children: [sticky, body]})
  return {block, sticky, children, comment, body}
}

function mount(groups, width = 32, height = 9) {
  const root = new StickyScroll({children: groups.map(g => g.block), groups})
  const scroll = root.children[0]
  const content = scroll.children[0]
  let offset = Point.zero
  scroll.update({
    onOffsetChange: next => {
      offset = next
    },
  })
  const program = new TestProgram({cols: width, rows: height})
  const screen = new Screen(program, root)
  screen.start()
  return {
    root,
    scroll,
    content,
    program,
    screen,
    get offset() {
      return offset
    },
  }
}

// Deliberately uncached reference of the original lookup. It checks the new
// prefix reuse against the same sizing/padding/visibility rules, not a second
// copy of the optimized algorithm.
function slowOffset(root, view, available) {
  let y = 0
  while (view !== root) {
    const parent = view.parent
    if (!parent || !view.isVisible) return undefined
    for (const sibling of parent.children) {
      if (sibling === view) break
      if (sibling.isVisible) y += sibling.naturalSize(available).height
    }
    y += parent.padding?.top ?? 0
    view = parent
  }
  return y
}

function expectedPins(root, groups, scrollY) {
  const available = root.contentSize
  const pinned = []
  let base = 0
  while (groups.length) {
    let found
    for (const group of groups) {
      const top = slowOffset(root, group.block, available)
      if (top === undefined) continue
      if (top >= scrollY + base) break
      const bottom = top + group.block.naturalSize(available).height
      if (bottom > scrollY + base) {
        found = {group, bottom}
        break
      }
    }
    if (!found) break
    const {group, bottom} = found
    const height = group.sticky.naturalSize(available).height
    const y = Math.min(base, bottom - scrollY - height)
    pinned.push({sticky: group.sticky, y, base})
    base = y + height
    groups = group.children
  }
  return pinned
}

function checkPins(t, groups) {
  const expected = expectedPins(t.content, groups, t.offset.y)
  assert.deepEqual(t.content.pinned, expected)
  function visit(groups) {
    for (const g of groups) {
      assert.equal(
        g.sticky.isPinned,
        expected.some(p => p.sticky === g.sticky),
      )
      visit(g.children)
    }
  }
  visit(groups)
}

test('sticky positions match uncached lookup after scrolling, wrapping, hiding, and resize', () => {
  const groups = Array.from({length: 8}, (_, i) =>
    group(`file ${i}`, [
      group(`section ${i}.0`),
      group(`section ${i}.1`, [], 1),
    ]),
  )
  const t = mount(groups)
  try {
    const sweep = () => {
      for (let y = 0; y < 140; y += 3) {
        t.scroll.scrollTo({y})
        t.screen.render()
        checkPins(t, groups)
      }
    }
    sweep()
    groups[1].body.isVisible = false
    groups[2].children[0].block.isVisible = false
    groups[3].comment.value =
      'long comment that wraps across several lines\nand a newline'
    t.screen.render()
    sweep()
    t.program.terminal.cols = 20
    t.program.terminal.reset()
    t.program.sendResize()
    sweep()
    groups[1].body.isVisible = true
    groups[2].children[0].block.isVisible = true
    groups[3].comment.value = 'short again'
    t.screen.render()
    sweep()
  } finally {
    t.screen.stop()
  }
})

test('collapsing a pinned section uses fresh prefixes and retains header identity/focus', () => {
  const section = group('section')
  const file = group('file', [section, group('next section')])
  const groups = [file, group('next file')]
  const t = mount(groups, 32, 7)
  try {
    t.scroll.scrollBy(0, 6)
    t.screen.render()
    checkPins(t, groups)
    assert.equal(section.sticky.isPinned, true)
    const parent = section.comment.parent
    t.screen.requestFocus(section.comment)
    t.screen.render()
    section.comment.value = 'kept comment'
    section.body.isVisible = false
    section.sticky.unpin()
    t.screen.render()
    t.screen.render() // settle any clamp against the shorter content
    checkPins(t, groups)
    assert.equal(section.comment.parent, parent)
    assert.equal(section.comment.hasFocus, true)
    assert.equal(section.comment.value, 'kept comment')
    assert.ok(t.program.terminal.textContent().includes('section header'))
    section.body.isVisible = true
    t.screen.render()
    checkPins(t, groups)
    assert.equal(section.comment.hasFocus, true)
  } finally {
    t.screen.stop()
  }
})

test('a bottom-of-diff pinning pass visits siblings linearly, not quadratically', () => {
  const groups = Array.from({length: 100}, (_, i) => group(`file ${i}`))
  const t = mount(groups)
  try {
    t.scroll.scrollTo({y: 1e6})
    t.screen.render()
    // Count indexed child reads, including ordinary render traversal. A cached
    // prefix pass is linear; the original repeated sibling scans exceed this
    // bound by an order of magnitude. No production instrumentation is needed.
    let visits = 0
    const children = new Proxy(t.content.children, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) visits++
        return Reflect.get(target, key, receiver)
      },
    })
    Object.defineProperty(t.content, 'children', {
      configurable: true,
      get: () => children,
    })
    t.screen.render()
    delete t.content.children
    assert.ok(visits <= groups.length * 10, `read ${visits} sibling entries`)
    checkPins(t, groups)
    assert.ok(
      groups
        .slice(-3)
        .some(group =>
          t.content.pinned.some(pin => pin.sticky === group.sticky),
        ),
      'did not reach the bottom groups',
    )
  } finally {
    delete t.content.children
    t.screen.stop()
  }
})
