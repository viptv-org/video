import { rm } from 'node:fs/promises'
import { rollup, type OutputOptions } from 'rollup'

import config from '../rollup.config'

const { output, ...input } = config
const outputs: OutputOptions[] = Array.isArray(output) ? output : output ? [output] : []
await rm('dist-js', { recursive: true, force: true })
const bundle = await rollup(input)

try {
  for (const options of outputs) await bundle.write(options)
} finally {
  await bundle.close()
}
