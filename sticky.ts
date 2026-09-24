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
  y: number
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

  render(viewport: Viewport) {
    this.visibleWidth = viewport.visibleRect.size.width
    this.#updatePinned(viewport.visibleRect.origin.y, viewport.contentSize)
    super.render(viewport)
  }

  #updatePinned(scrollY: number, available: Size) {
    for (const {sticky} of this.pinned) {
      sticky.isPinned = false
    }
    this.pinned = []

    // `base` is the screen row just below the pinned headers so far
    let base = 0
    let groups = this.groups
    while (groups.length) {
      const threshold = scrollY + base
      let found: {group: StickyGroup; bottom: number} | undefined
      for (const group of groups) {
        const top = offsetWithin(this, group.block, available)
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
      this.pinned.push({sticky: group.sticky, y})
      base = y + height
      groups = group.children
    }
  }
}

/**
 * Sum of the heights of everything above `view`, in `root`'s coordinates.
 * Assumes every container in between is a vertical Stack. Returns undefined
 * if the view (or any ancestor) is hidden.
 */
function offsetWithin(
  root: View,
  view: View,
  available: Size,
): number | undefined {
  let y = 0
  let current = view
  while (current !== root) {
    const parent = current.parent
    if (!parent || !current.isVisible) {
      return undefined
    }
    for (const sibling of parent.children) {
      if (sibling === current) {
        break
      }
      if (sibling.isVisible) {
        y += sibling.naturalSize(available).height
      }
    }
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

  constructor({
    children,
    groups,
  }: {
    children: View[]
    groups: StickyGroup[]
  }) {
    super({})
    this.#content = new StickyContent({direction: 'down', children})
    this.#content.groups = groups
    this.#scrollable = Scrollable.down({children: [this.#content]})
    this.add(this.#scrollable)
  }

  render(viewport: Viewport) {
    super.render(viewport)

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
