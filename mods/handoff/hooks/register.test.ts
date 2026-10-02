import { expect, test } from 'claude-code/testing'

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
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect(writes).toContain('/work/app/.claude/handoff/LATEST.md')
  expect(writes).toContain('/work/app/.claude/handoff/LATEST.patch')
})
