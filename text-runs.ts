/**
 * Combine plain diff lines without changing their row count or ANSI isolation.
 * Each escaped line keeps its own Text view so unclosed SGR/OSC styling cannot
 * leak into the next line. Empty Text strings occupy zero rows, not one.
 */
export function textRuns(lines: readonly string[]): string[] {
  const runs: string[] = []
  let plain: string[] = []
  const flush = () => {
    if (plain.length) {
      runs.push(plain.join('\n'))
      plain = []
    }
  }
  for (const line of lines) {
    if (line === '' || line.includes('\x1b') || /[\u0080-\u009f]/.test(line)) {
      flush()
      runs.push(line)
    } else {
      plain.push(line)
    }
  }
  flush()
  return runs
}
