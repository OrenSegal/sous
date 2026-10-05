import { expect, test } from 'claude-code/testing'

const done = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never

test('turn.complete writes the handoff files', async ($, on) => {
  const writes: string[] = []
  on('process.run', () => ({ value: { exitCode: 0, stdout: ' a.ts | 2 +-\n', stderr: '' } }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-02T19:00:00Z') }))
  on('fs.write', (_: unknown, e: { path: string }) => {
    writes.push(e.path)

    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(done)
  expect(writes).toContain('/work/app/.claude/handoff/LATEST.md')
  expect(writes).toContain('/work/app/.claude/handoff/LATEST.patch')
})

// Git matches a plain pathspec with fnmatch, where `*` crosses `/` but a
// written `/` must be there: `**/*.pem` misses a top-level `private.pem`.
test('the patch leaves out secret-looking files at the repo root too', async ($, on) => {
  const diffs: string[][] = []
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    if (e.argv[1] === 'diff' && e.argv[2] === 'HEAD') diffs.push(e.argv)

    return { value: { exitCode: 0, stdout: ' a.ts | 2 +-\n', stderr: '' } }
  })
  on('session.root', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'm' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.write', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(done)
  expect(diffs.length).toBe(1)
  for (const p of ['.env*', '*/.env*', '*.pem', '*.key', '*secret*', '*credential*', '*id_rsa*', '.npmrc', '*/.npmrc',
    '.netrc', '*/.netrc', '*service-account*.json', '*.p12', '*.pfx']) {
    expect(diffs[0]).toContain(`:(exclude)${p}`)
  }
})

// Editing a line twice keeps `diff --stat` and `status` the same; the patch
// still has to follow the content.
test('a content change with the same diffstat refreshes LATEST.patch', async ($, on) => {
  let turn = 0
  const patches: string[] = []
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const out = e.argv[1] === 'diff' && e.argv[2] === 'HEAD' ? `+line v${turn}\n` : ' a.ts | 2 +-\n'

    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  })
  on('session.root', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'm' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    if (e.path.endsWith('LATEST.patch')) patches.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  turn = 1
  await $.turn.complete(done)
  turn = 2
  await $.turn.complete(done)
  expect(patches).toEqual(['+line v1\n', '+line v2\n'])
})

// Binary files changed in the tree reach the patch as `GIT binary patch` sections
// git apply can use, not as "Binary files differ" lines it can't.
test('the patch carries binary changes', async ($, on) => {
  const diffs: string[][] = []
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    if (e.argv[1] === 'diff' && e.argv[2] === 'HEAD') diffs.push(e.argv)

    return { value: { exitCode: 0, stdout: ' a.ts | 2 +-\n', stderr: '' } }
  })
  on('session.root', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'm' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.write', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(done)
  expect(diffs[0]).toContain('--binary')
})

const fileDiff = (name: string, hunks: string[]) =>
  `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n` + hunks.join('')
const hunk = (at: number, size: number) => `@@ -${at},1 +${at},1 @@\n-old\n+${'x'.repeat(size)}\n`

// Over the cap, the patch stops before the first file that doesn't fit, so every
// hunk in it is whole and git apply still reads it, and it says what it left out.
test('an oversized patch is cut at a file boundary, with a note', async ($, on) => {
  const a = fileDiff('a.ts', [hunk(1, 200000)])
  const b = fileDiff('b.ts', [hunk(1, 200000)])
  const out: Record<string, string> = {}
  on('process.run', (_: unknown, e: { argv: string[] }) => ({
    value: { exitCode: 0, stdout: e.argv[1] === 'diff' && e.argv[2] === 'HEAD' ? a + b : ' a | 1 +\n', stderr: '' },
  }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'm' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    out[e.path.slice(e.path.lastIndexOf('/') + 1)] = e.text

    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(done)
  const patch = out['LATEST.patch']
  expect(patch.startsWith(a)).toBe(true)
  expect(patch.includes('diff --git a/b.ts')).toBe(false)
  expect(patch.slice(a.length)).toMatch(/^\n# sous handoff: .*cut.*b\.ts/)
  expect(out['LATEST.md'].includes('cut')).toBe(true)
})

test('one file over the cap is cut at a hunk boundary, with a note', async ($, on) => {
  const first = hunk(1, 150000)
  const a = fileDiff('a.ts', [first, hunk(9, 200000)])
  let patch = ''
  on('process.run', (_: unknown, e: { argv: string[] }) => ({
    value: { exitCode: 0, stdout: e.argv[1] === 'diff' && e.argv[2] === 'HEAD' ? a : ' a | 1 +\n', stderr: '' },
  }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'm' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    if (e.path.endsWith('LATEST.patch')) patch = e.text

    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(done)
  const kept = fileDiff('a.ts', [first])
  expect(patch.startsWith(kept)).toBe(true)
  expect(patch.slice(kept.length)).toMatch(/^\n# sous handoff: .*cut.*a\.ts/)
})
