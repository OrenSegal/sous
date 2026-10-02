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
  for (const p of ['.env*', '*/.env*', '*.pem', '*.key', '*secret*', '*credential*']) {
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
