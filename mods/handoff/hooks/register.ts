import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PATCH_CAP = 300000
const filesAtom = atom({ plugin: 'handoff', key: 'files' } as const, [])

// secret-looking files stay out of the patch. Plain pathspecs use fnmatch, where
// `*` also matches `/`, so `*.pem` covers every depth; `**/*.pem` would need a
// slash and miss a top-level `private.pem`.
const EXCLUDE = [':(exclude).env*', ':(exclude)*/.env*', ':(exclude)*.pem', ':(exclude)*.key', ':(exclude)*secret*', ':(exclude)*credential*']

export const register: Register = on => {
  let lastSig = ''

  on('prompt.submit', async ($, e, next) => {
    await update($, filesAtom, () => [])

    return next(e)
  })

  for (const tool of ['Edit', 'Write', 'MultiEdit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        await update($, filesAtom, f => (f.includes(e.file_path) ? f : [...f, e.file_path].slice(-50)))
      }

      return ran
    })
  }

  on('turn.complete', async ($, e, next) => {
    const git = (argv: string[]) => $.process.run(['git', ...argv]).catch(() => null)
    const stat = await git(['diff', '--stat', 'HEAD'])
    const status = await git(['status', '--porcelain'])
    const patch = await git(['diff', 'HEAD', '--', '.', ...EXCLUDE])
    // write only when the tree moved since the last export; the patch is in the
    // signature because a second edit to the same lines leaves stat and status alike
    const sig = (stat?.stdout ?? '') + (status?.stdout ?? '') + (patch?.stdout ?? '')
    if (stat && stat.exitCode === 0 && sig !== lastSig) {
      lastSig = sig
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
      const head = await git(['rev-parse', '--short', 'HEAD'])
      const files = await read($, filesAtom)
      const root = await $.session.root()
      const dir = `${root}/.claude/handoff`
      const md = [
        '# Handoff',
        '',
        `Written ${new Date(await $.clock.now()).toISOString()}. Branch \`${branch?.stdout.trim() || 'unknown'}\` at \`${head?.stdout.trim() || 'unknown'}\`. Model ${await $.session.model()}.`,
        '',
        '## Edited this turn',
        files.length ? files.map(f => `- \`${f}\``).join('\n') : '- no file edits through Edit or Write',
        '',
        '## Working tree',
        '```',
        stat.stdout.trim() || 'no tracked changes',
        '```',
        status?.stdout.trim() ? '```\n' + status.stdout.trim() + '\n```' : '',
        '',
        '## Resume',
        '1. Read this file, then `LATEST.patch` for the full diff (secret-looking files excluded).',
        '2. Run the project checks before trusting the changes.',
        '3. `git apply --check .claude/handoff/LATEST.patch` shows whether the patch still applies.',
        '',
      ].join('\n')
      await $.fs.write(`${dir}/.gitignore`, '*\n')
      await $.fs.write(`${dir}/LATEST.md`, md)
      await $.fs.write(`${dir}/LATEST.patch`, patch && patch.exitCode === 0 ? patch.stdout.slice(0, PATCH_CAP) : '')
    }

    return next(e)
  })
}
