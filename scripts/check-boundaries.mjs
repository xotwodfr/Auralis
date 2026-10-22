// Enforces the dependency rules in docs/STRUCTURE.md: every import is resolved to a path, and a directory may only reach
// into the directories it is allowed to depend on. Run by `npm run lint`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))

// A directory's own files are always fine; this lists what else it may import from.
const ALLOWED = {
  'shared/ui': [],
  server: [],
  web: ['shared/ui', 'server'],
  tauri: ['shared/ui', 'server'],
  android: ['shared/ui', 'server'],
}
const SKIP = new Set(['node_modules', 'dist', '.e2e-dist', 'target', 'gen', 'test-results', 'playwright-report'])
const SOURCE = /\.(ts|tsx|mjs|mts|js)$/
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)['"]([^'"]+)['"]/g

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    if (SKIP.has(f)) return []
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : SOURCE.test(f) ? [p] : []
  })

const owner = (abs) =>
  Object.keys(ALLOWED)
    .filter((d) => abs === join(repo, d) || abs.startsWith(join(repo, d) + sep))
    .sort((a, b) => b.length - a.length)[0]

const violations = []
for (const [dir, allowed] of Object.entries(ALLOWED)) {
  for (const file of walk(join(repo, dir)).filter((f) => owner(f) === dir)) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      // `@auralis/ui/...` is the alias for shared/ui/src; relative imports are resolved; other bare imports are packages.
      const target = spec.startsWith('@auralis/ui') ? join(repo, 'shared/ui') : spec.startsWith('.') ? resolve(dirname(file), spec) : null
      if (!target) continue
      const to = owner(target)
      if (to && to !== dir && !allowed.includes(to)) violations.push(`${relative(repo, file)}: imports ${spec} (${dir} must not depend on ${to})`)
    }
  }
}

if (violations.length) {
  console.error(`Dependency boundary violations:\n${violations.map((v) => `  ${v}`).join('\n')}`)
  process.exit(1)
}
console.log(`Dependency boundaries OK (${Object.keys(ALLOWED).join(', ')}).`)
