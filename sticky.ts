import {
  Container,
  Point,
  Rect,
  Scrollable,
  Size,
  Stack,
  Style,
  type View,
  type Viewport,
} from '@teaui/core'

/**
 * Holds a header in the scroll content. While pinned, the header is drawn by
 * the StickyScroll overlay instead, and this slot renders nothing - but it
 * still reports the header's size, so the content below doesn't shift.
 *
 * The header never changes parents, so Inputs keep their focus/state while
 * it moves between the content and the overlay.
 */
export class Sticky extends Container {
  isPinned = false

  constructor(readonly header: View) {
    super({child: header})
  }

  /**
   * If pinned, puts the header back in the content and scrolls so that it
   * stays on the row where it's drawn now. Call this after changing the
   * content (e.g. collapsing the block), otherwise the scroll view jumps.
   */
  unpin() {
    if (!this.isPinned) {
      return
    }

    let view = this.parent
    while (view && !(view instanceof StickyContent)) {
      view = view.parent
    }
    view?.reveal(this)
  }

  render(viewport: Viewport) {
    if (!this.isPinned) {
      super.render(viewport)
    }
  }
}

/**
 * A `block` is the whole region that "owns" the sticky header (the header
 * slot itself plus everything below it). The header stays pinned for as long
 * as any of the block is under the pinned area. `children` are the nested
 * sticky groups, pinned below this one.
 */
export interface StickyGroup {
  block: View
  sticky: Sticky
  children: StickyGroup[]
}

interface Pinned {
  sticky: Sticky
  // where the header is drawn (less than `base` while being pushed up)
  y: number
  // the row just below the parent pinned headers
  base: number
}

/**
 * The root of the scroll content. When rendered, its visibleRect origin is
 * the scroll offset, which is all we need to decide which headers are pinned.
 * This runs before any of its children render, so every Sticky slot knows
 * whether to draw itself.
 */
class StickyContent extends Stack {
  groups: StickyGroup[] = []
  pinned: Pinned[] = []
  visibleWidth = 0
  #available = Size.zero
  #scrollTarget: number | undefined

  render(viewport: Viewport) {
    this.visibleWidth = viewport.visibleRect.size.width
    this.#available = viewport.contentSize
    this.#updatePinned(viewport.visibleRect.origin.y, viewport.contentSize)
    super.render(viewport)
  }

  get #scrollable() {
    return this.parent as Scrollable
  }

  reveal(sticky: Sticky) {
    const pinned = this.pinned.find(p => p.sticky === sticky)
    const top = offsetWithin(this, sticky, this.#available)
    if (!pinned || top === undefined) {
      return
    }

    sticky.isPinned = false
    this.#scrollTarget = top - pinned.base
    this.#scrollable.scrollTo({y: this.#scrollTarget})
  }

  /**
   * scrollTo() clamps against the content size from the previous render. If
   * the content just shrank (a block was collapsed), that clamp was too
   * generous - scroll again now that the new size is known.
   */
  settleScroll() {
    if (this.#scrollTarget !== undefined) {
      this.#scrollable.scrollTo({y: this.#scrollTarget})
      this.#scrollTarget = undefined
    }
  }

  #updatePinned(scrollY: number, available: Size) {
    for (const {sticky} of this.pinned) {
      sticky.isPinned = false
    }
    this.pinned = []

    // This pass uses one set of dimensions and an unchanged tree. Reuse
    // sibling prefixes across group lookups, but never across renders/edits.
    const offsets: SiblingOffsets = new Map()
    // `base` is the screen row just below the pinned headers so far
    let base = 0
    let groups = this.groups
    while (groups.length) {
      const threshold = scrollY + base
      let found: {group: StickyGroup; bottom: number} | undefined
      for (const group of groups) {
        const top = offsetWithin(this, group.block, available, offsets)
        if (top === undefined) {
          continue
        }
        if (top >= threshold) {
          break
        }
        const bottom = top + group.block.naturalSize(available).height
        if (bottom > threshold) {
          found = {group, bottom}
          break
        }
      }
      if (!found) {
        break
      }

      const {group, bottom} = found
      const height = group.sticky.naturalSize(available).height
      // when the end of the block reaches the pinned header, push it up
      const y = Math.min(base, bottom - scrollY - height)
      group.sticky.isPinned = true
      this.pinned.push({sticky: group.sticky, y, base})
      base = y + height
      groups = group.children
    }
  }
}

type SiblingOffsets = Map<
  View,
  {
    next: number
    height: number
    positions: Map<View, number>
  }
>

/**
 * Sum of the heights of everything above `view`, in `root`'s coordinates.
 * Assumes every container in between is a vertical Stack. Returns undefined
 * if the view (or any ancestor) is hidden. Prefixes are local to a single pass.
 */
function offsetWithin(
  root: View,
  view: View,
  available: Size,
  offsets: SiblingOffsets = new Map(),
): number | undefined {
  let y = 0
  let current = view
  while (current !== root) {
    const parent = current.parent
    if (!parent || !current.isVisible) {
      return undefined
    }
    let prefix = offsets.get(parent)
    if (!prefix) {
      prefix = {next: 0, height: 0, positions: new Map()}
      offsets.set(parent, prefix)
    }
    // Advance only as far as requested. Each sibling is visited/measured at
    // most once per pass, even when hundreds of groups share this parent.
    while (
      !prefix.positions.has(current) &&
      prefix.next < parent.children.length
    ) {
      if (prefix.next > 0) {
        const previous = parent.children[prefix.next - 1]
        if (previous.isVisible) {
          prefix.height += previous.naturalSize(available).height
        }
      }
      const sibling = parent.children[prefix.next++]
      prefix.positions.set(sibling, prefix.height)
    }
    y += prefix.positions.get(current) ?? 0
    y += parent.padding?.top ?? 0
    current = parent
  }
  return y
}

/**
 * A Scrollable whose sticky headers stay visible at the top while the rest of
 * their block is on screen. Nested groups (e.g. sections within a file) pin
 * below their parent's header.
 */
export class StickyScroll extends Container {
  #scrollable: Scrollable
  #content: StickyContent

  constructor({children, groups}: {children: View[]; groups: StickyGroup[]}) {
    super({})
    this.#content = new StickyContent({direction: 'down', children})
    this.#content.groups = groups
    this.#scrollable = Scrollable.down({
      children: [this.#content],
      scrollable: 'vertical',
    })
    this.add(this.#scrollable)
  }

  render(viewport: Viewport) {
    super.render(viewport)
    this.#content.settleScroll()

    const width = this.#content.visibleWidth
    // deepest first, so a header being pushed up slides under its parent
    for (const {sticky, y} of [...this.#content.pinned].reverse()) {
      const height = sticky.header.naturalSize(
        new Size(width, viewport.contentSize.height),
      ).height
      viewport.clipped(
        new Rect(new Point(0, y), new Size(width, height)),
        inside => {
          inside.paint(Style.NONE)
          sticky.header.render(inside)
        },
      )
    }
  }
}
