// Postbuild: emit .gz/.br siblings next to dist assets so chatserver.py can
// serve them precompressed (zero runtime compression cost). Pure node:zlib.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'

const dist = new URL('../dist', import.meta.url).pathname
const EXT = /\.(js|css|html|svg|json|woff2?)$/
let orig = 0, gz = 0, br = 0

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (!EXT.test(name)) continue
    const src = readFileSync(p)
    orig += src.length
    const g = gzipSync(src, { level: 9 })
    writeFileSync(p + '.gz', g)
    gz += g.length
    const b = brotliCompressSync(src, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    })
    writeFileSync(p + '.br', b)
    br += b.length
    console.log(`${name}: ${src.length} -> gz ${g.length} / br ${b.length}`)
  }
}
walk(dist)
console.log(`total: ${orig} raw -> ${gz} gzip (${((1 - gz / orig) * 100).toFixed(0)}%) / ${br} br (${((1 - br / orig) * 100).toFixed(0)}%)`)
