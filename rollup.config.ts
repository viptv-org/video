import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'

import typescript from '@rollup/plugin-typescript'
import type { RollupOptions } from 'rollup'

interface PackageManifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(join(cwd(), 'package.json'), 'utf8'),
) as PackageManifest

/** Scoped package names also import through subpaths (`@tauri-apps/api/core`). */
const escape = (name: string) => name.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
const externalNames = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]
const externalPatterns = externalNames.map((name) => new RegExp(`^${escape(name)}(?:/.*)?$`))

const config: RollupOptions = {
  input: { index: 'src/index.ts' },
  output: {
    dir: 'dist-js',
    entryFileNames: '[name].js',
    format: 'esm',
    sourcemap: true,
  },
  plugins: [
    typescript({
      declaration: true,
      declarationDir: 'dist-js',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
    }),
  ],
  external: externalPatterns,
}

export default config
