import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { DIST, launchBrowser, poll, screenshot } from '../helpers/setup.mjs';

// Verifies the inline .scad viewer (OpenSCAD compiled to WebAssembly in a
// worker, STL drawn with three.js):
//  1. read of a .scad file → live WebGL canvas + OpenSCAD render summary
//  2. a SECOND .scad read renders too — OpenSCAD's main() runs once per wasm
//     instance, so a reused instance aborts and the second viewer errors
//  3. read of a broken .scad → parser error in the caption, no crash
//  4. read of a non-.scad file → no viewer
//  5. FAILED read of a .scad file → no viewer (nothing to compile, no 11 MB fetch)
//  6. pointer controls: left-drag orbits, wheel zooms, right-drag pans
//  7. re-reading an EDITED file re-renders it (a path-keyed cache served the
//     first version forever)

const PORT = 8171;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_scadview';

const GOOD = 'cube([10, 20, 30]);\n';
const ALSO_GOOD = 'difference() { cube(20, 20, 20); sphere(15); }\n';
const BROKEN = 'cube([1, 2, 3;\n';
const GOOD_PATH = '/workspace/part.scad';
const ALSO_GOOD_PATH = '/workspace/diff.scad';
const BROKEN_PATH = '/workspace/bad.scad';
const MISSING_PATH = '/workspace/gone.scad';
// re-read of an EDITED file: same path, different source on the second request
const EDITED_PATH = '/workspace/edited.scad';
// v1 is a plain cube (CGAL PolySet backend), v2 a difference (manifold
// backend) — the caption distinguishes them without magic numbers
const EDITED_V1 = 'cube([10, 10, 10]);\n';
const EDITED_V2 = 'difference() { cube([40, 40, 40]); sphere(30); }\n';
const TXT_PATH = '/workspace/notes.md';

const results = [];
const pageErrors = [];
let editReads = 0;

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// ---- minimal dist server ---------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  const p = (req.url ?? '/').split('?')[0];
  const rel = p === '/' ? '/index.html' : p;
  try {
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST))) return res.writeHead(403).end();
    const b = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'Content-Length': b.length,
    });
    res.end(b);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const MSGS = [
  {
    info: { id: 'msg_u1', role: 'user', time: { created: 1000 } },
    parts: [{ id: 'p0', type: 'text', text: 'render these' }],
  },
  {
    info: { id: 'msg_a1', role: 'assistant', time: { created: 2000 } },
    parts: [
      { id: 'p1', type: 'text', text: 'Three models.' },
      {
        id: 'p2',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: { filePath: GOOD_PATH }, output: 'ok' },
      },
      {
        id: 'p3',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: { filePath: ALSO_GOOD_PATH }, output: 'ok' },
      },
      {
        id: 'p4',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: { filePath: BROKEN_PATH }, output: 'ok' },
      },
      {
        id: 'p5',
        type: 'tool',
        tool: 'read',
        state: {
          status: 'error',
          input: { filePath: MISSING_PATH },
          error: 'File not found',
        },
      },
      {
        id: 'p6',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: { filePath: EDITED_PATH }, output: 'ok' },
      },
      {
        id: 'p7',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: { filePath: EDITED_PATH }, output: 'ok' },
      },
      {
        id: 'p8',
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: TXT_PATH },
          output: `<path>${TXT_PATH}</path>\n<content>\nhello\n</content>`,
        },
      },
    ],
  },
];

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => pageErrors.push(e.message));

async function handle(route) {
  const req = route.request();
  const p = new URL(req.url()).pathname;
  const m = req.method();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (m === 'GET' && p === `/oc/session/${SID}/message`) return json(MSGS);
  if (m === 'GET' && p === `/oc/session/${SID}`) return json({ id: SID, title: 'mock', revert: null });
  if (m === 'GET' && p === '/oc/file/content') {
    const q = new URL(req.url()).searchParams.get('path') ?? '';
    const src = { [GOOD_PATH]: GOOD, [ALSO_GOOD_PATH]: ALSO_GOOD, [BROKEN_PATH]: BROKEN }[q];
    if (src !== undefined) return json({ type: 'text', content: src });
    // same path, new content on the second read — the file was edited
    if (q === EDITED_PATH) {
      editReads++;
      return json({ type: 'text', content: editReads === 1 ? EDITED_V1 : EDITED_V2 });
    }
    return json({ type: 'text', content: '' });
  }
  if (p === '/oc/session/status') return json({});
  if (p === '/oc/config/providers')
    return json({ providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }] });
  if (p === '/oc/command' || p === '/oc/permission' || p === '/oc/question' || p === '/oc/skill') return json([]);
  if (p === '/api/history/sessions')
    return json([{ id: SID, title: 'scadview render mock', created: 1, updated: 9, message_count: MSGS.length, cost: 0 }]);
  if (p === `/api/history/session/${SID}/errors`) return json([]);
  if (p === '/oc/event') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
  return route.fallback();
}
await page.route('**/oc/**', handle);
await page.route('**/api/**', handle);

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const item = page.locator('.sidebar button.item', { hasText: 'scadview render mock' }).first();
  await item.waitFor({ timeout: 15000 });
  await item.click();

  // 1. both good models compile — the wasm pipeline plus a live GL context
  const cards = page.locator('#m-msg_a1 .scadview');
  await cards.nth(1).waitFor({ timeout: 60000 });
  // renders are serialized in the worker, so the failing model (last part)
  // reporting its error means every viewer finished
  // Renders are serialized, so all five captions leaving "rendering…" means
  // everything finished. Poll-and-capture rather than wait-then-read: the app
  // rebuilds the transcript subtree once or twice after load, which restarts
  // every viewer mid-render.
  let caps = await page.locator('#m-msg_a1 .scadview .meta').allInnerTexts();
  const settled = await poll(async () => {
    caps = await page.locator('#m-msg_a1 .scadview .meta').allInnerTexts();
    // NB: match the ellipsis — a finished caption says "Total rendering time"
    return caps.length === 5 && caps.every((t) => !t.includes('rendering…'));
  }, 45000, 300);
  check('V', 'every viewer finished rendering', settled, JSON.stringify(caps.map((c) => c.slice(0, 34))));
  check('V', 'five viewers (2 good + 1 broken + 2 edits)', caps.length === 5, `got ${caps.length}`);
  check('V', 'first model rendered', /rendering time/.test(caps[0] ?? ''), (caps[0] ?? '').slice(0, 60));
  // a reused wasm instance aborts — this is the regression this test exists for
  check('V', 'second model rendered', /rendering time/.test(caps[1] ?? ''), (caps[1] ?? '').slice(0, 60));
  check('V', 'broken model reports the parser error', /Parser error/.test(caps[2] ?? ''), (caps[2] ?? '').slice(0, 60));
  check(
    'V',
    'error caption is styled as an error',
    (await page.locator('#m-msg_a1 .scadview .st.err').count()) === 1,
  );
  check(
    'V',
    'no viewer for a non-.scad or failed read',
    (await page.locator('#m-msg_a1 .scadview').count()) === 5,
    '8 toolcards, 5 viewers',
  );
  // 7. the re-read sees the NEW source — a cache keyed by path would hand the
  // first read's STL to the second viewer and no caption would mention manifold
  const editCaps = caps.filter((c) => c.includes('edited.scad'));
  check(
    'V',
    're-read of an edited file renders the new source',
    editCaps.some((c) => c.includes('manifold')),
    `${editCaps.length} edited viewers, manifold in ${editCaps.filter((c) => c.includes('manifold')).length}`,
  );

  const ctx = await page.evaluate(() => {
    const c = document.querySelector('#m-msg_a1 .scadview canvas');
    if (!c) return null;
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    return { w: c.width, h: c.height, gl: !!gl, lost: gl ? gl.isContextLost() : null };
  });
  check('V', 'GL context alive and sized', ctx?.gl === true && ctx?.lost === false && ctx?.w > 0, JSON.stringify(ctx));

  // 6. pointer controls — compare composited pixels; swiftshader is
  // deterministic, so an unchanged view hashes identically
  const hash = async () =>
    crypto
      .createHash('md5')
      .update(await page.locator('#m-msg_a1 .scadview canvas').first().screenshot())
      .digest('hex');
  // mouse events need the canvas inside the viewport, and the viewers sit
  // below the fold in a 6-card message
  const canvas = page.locator('#m-msg_a1 .scadview canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const cbox = (await canvas.boundingBox()) ?? { x: 0, y: 0, width: 100, height: 100 };
  const cx = cbox.x + cbox.width / 2;
  const cy = cbox.y + cbox.height / 2;
  const before = await hash();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy - 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterOrbit = await hash();
  check('V', 'left-drag orbits the model', afterOrbit !== before);
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 80, cy + 40, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(250);
  check('V', 'right-drag pans the model', (await hash()) !== afterOrbit);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(250);
  check('V', 'wheel zooms', (await hash()) !== afterOrbit);

  await screenshot(page, 'scadview');
} finally {
  try {
    await browser.close();
  } finally {
    await new Promise((r) => server.close(r));
  }
}

console.log('\n================ SUMMARY ================');
let fails = 0;
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  if (!r.pass) fails++;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('\nChecks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
