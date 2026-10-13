# Diff rendering performance

## Implemented optimizations

- **Consistent natural-size cache keys** in TeaUI: look up and store the caller's
  original dimensions, before padding and constraints.
- **Cached Stack placements and View render geometry.** Invalidate on layout,
  size, props, tree, flex, visibility, padding, and pin changes as applicable.
  Probes do not reuse or commit cached geometry. Views still render and register
  their focus, hotkeys, and mouse handlers, including offscreen descendants.
- **Identity viewport clipping** reuses unchanged rectangles while preserving
  pen, coordinate, and registration scopes. Insets that expose overflow still
  use the full clipping path.
- **Offscreen Input and Checkbox drawing skips.** Keep geometry and registration;
  focused/dragging Inputs and Checkboxes with custom children retain their
  original drawing paths.
- **Per-pass sticky sibling prefixes** replace repeated scans of preceding
  siblings. Nothing is reused across edits, resize, collapse, or frames.
- **Batched static diff text.** Context blocks and consecutive additions/removals
  with identical styling use multiline Text views. Escape-containing lines stay
  separate to prevent ANSI styles leaking between lines; zero-row empty strings
  remain separate too. Review controls, comments, and pinned headers are unchanged.
- **Wheel painting is always batched in TeaUI's Screen.** Every wheel event is
  applied immediately, in order, but painting waits for the next available
  ~16 ms frame tick. Further events do not reset the deadline. No deltas are
  dropped or summed, preserving reversals at scroll bounds. Pointer/modifier
  changes and other input flush pending work before dispatch; explicit rendering
  consumes pending work, and stop cancels it. This is independent of input source
  or transport and has no configuration switch.
- **Render-request consumption** occurs before drawing, avoiding redundant queued
  frames without losing invalidations raised during render/commit. Animation
  ticks continue normally.

There is no nested Stack pruning, virtualization, or ScrollableList migration.
Rendering still traverses the mounted tree. Reducing the wheel backlog does not
make individual renders free or guarantee 60 FPS.

## Reproduce

This checkout links `@teaui/core` and `@teaui/remote-control` to the sibling
`../teaui` checkout. Keep those links until the TeaUI optimizations are published.

```sh
pnpm -C ../teaui --filter @teaui/term --filter @teaui/inspect \
  --filter @teaui/core --filter @teaui/remote-control build
pnpm install
pnpm build

# Real app in a 120x40 PTY; serial RemoteControl requests:
node scripts/profile.mjs diff.diff
# Model a trackpad burst: 12 wheel events at 4 ms spacing, independent of ACKs:
node scripts/profile.mjs diff.diff --burst > /tmp/review-baseline.json
# Repeat, polling until the final frame matches the baseline at each position:
node scripts/profile.mjs diff.diff --burst --reference /tmp/review-baseline.json
```

The runner requires Node 22+ (native WebSocket), macOS/Linux (`/dev/tty`), and
`node-pty` / `@xterm/headless`. `pnpm profile diff.diff` builds the app and runs it.

RemoteControl is only the replay transport. The same wheel-render scheduling
applies to terminal input. `scroll.*` samples measure delivery ACK latency, **not
painting**. `painted.*` measures a complete 12-event sequence through its final
snapshot. With `--reference`, the runner polls for the expected frame; without
it, it waits 32 ms after the last ACK before capturing, which is not a precise
paint-completion barrier. `screen.snapshot()` remains capture-only.

The replay scrolls at the top, middle, and bottom, collapses/expands the first
file, pastes a multiline annotation, verifies the output patch, and quits. It
uses a private temporary directory and separate HOME/cwd, leaving existing review
state and input patches untouched. The directory contains `samples.json`, eight
plain snapshots, eight ANSI snapshots, and `reviewed.diff`. **Snapshots and the
output patch contain patch content**; keep the directory private.

The CLI retains `--remote [endpoint-file]` and the `scripts/remote.mjs` driver.
The former diagnostic instrumentation, API, CLI option, and file writer have
been removed. Runtime rendering does not collect timings or counters.

## Recorded measurements

These are historical measurements on the supplied 677,768-byte, 11,551-line,
287-file patch, Node 24.15.0, macOS, and a 120x40 terminal. They were collected
before the diagnostic cleanup, not rerun benchmark guarantees.

### Geometry and drawing optimizations

Before wheel batching, median request-to-ACK latency included synchronous paint:

| Position | First round: before → after | Second round: fresh baseline → after |
| --- | ---: | ---: |
| Top | 169 → 96 ms | 87.4 → 40.5 ms |
| Middle | 124 → 65 ms | 63.5 → 25.6 ms |
| Bottom | 130 → 62 ms | 59.8 → 24.8 ms |

The first round fixed size-cache keys, cached Stack placements, skipped invisible
Input drawing, and indexed sticky siblings per pass. The second batched static
Text, cached View geometry, optimized identity clips, and skipped invisible
Checkbox drawing. Second-round figures pool 36 requests per position across
three independent runs. These ACK numbers are not comparable to ACKs after
asynchronous wheel painting was introduced.

### Wheel bursts

Three runs per version, 12 events sent at 4 ms spacing. Medians measure time
from burst start until the final painted snapshot matches the reference:

| Position | Per-event painting | Batched painting |
| --- | ---: | ---: |
| Top | 487.8 ms | 130.4 ms |
| Middle | 448.3 ms | 93.3 ms |
| Bottom | 298.9 ms | 92.3 ms |

This baseline used the app's vertical-only scrolling configuration and an
interior scrollbar click, unlike the earlier rounds' exact layout/jump targets.
All 17 replay artifacts matched before/after, including the annotated patch.

## Regression coverage

- App tests compare sticky positions to the original uncached algorithm across
  scrolling, wrapping, padding, hiding, resize, and pinned collapse/focus changes.
  Indexed child reads check linear sibling traversal without production counters.
- Batched/unbatched Text produces identical styled frames across scrolling,
  clipping, Unicode, tabs, empty lines, and ANSI escapes; patch folding preserves
  sign/style boundaries.
- TeaUI tests cover cache reuse through geometry identity, invalidation, probes,
  pins, flex, layout markers, offscreen focus/hotkeys/selection, and `scrollTo`.
  Drawing skips are checked with test spies, not production instrumentation.
- Wheel tests exercise terminal and additional event sources, direct dispatch,
  continuous bursts, mixed directions, clamping, fresh hit-testing before clicks,
  keys, other input, stop, inline-region updates, and render-time invalidations.
  The synchronous component-test harness explicitly paints after a wheel event;
  scheduler tests exercise the real deferred behavior directly.
- Known baseline failures: the KITT Spinner snapshot and seven Scrollable tests.
  The latter reproduce in an untouched archive of TeaUI `bb2ac97` (the newer
  scrollbar changes), independently of this cleanup. The core test typecheck
  also has the existing protected `ToggleGroup.add` call in
  `Container.empty.test.ts:37`.
