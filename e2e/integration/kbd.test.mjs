// verify-kbd.mjs — soft-keyboard / visualViewport fix verification
// Run: node kbd.test.mjs
import { BASE, launchBrowser, screenshot, SHOTS_DIR } from '../helpers/setup.mjs'

let pass = 0, fail = 0;
function check(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}
const pageErrors = [];
function watch(page, tag) {
  page.on('pageerror', (e) => pageErrors.push(`${tag}: ${e.message}`));
}

const browser = await launchBrowser();
const VP = { width: 800, height: 1280 }; // tablet portrait

// ---------- Page A: real environment (keyboard closed) ----------
const ctxA = await browser.newContext({ viewport: VP });
const pageA = await ctxA.newPage();
watch(pageA, 'A');
await pageA.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await pageA.waitForSelector('.app', { timeout: 10000 });
await pageA.waitForTimeout(1500); // let mount + auto-open settle

// (b) viewport meta
const meta = await pageA.evaluate(() => document.querySelector('meta[name="viewport"]')?.content ?? '');
check('b1 meta has interactive-widget=resizes-content', meta.includes('interactive-widget=resizes-content'), meta);
check('b2 meta has viewport-fit=cover', meta.includes('viewport-fit=cover'), '');

// (c) .app height resolves through dvh/var chain with keyboard closed
const aState = await pageA.evaluate(() => ({
  h: getComputedStyle(document.querySelector('.app')).height,
  vvh: document.documentElement.style.getPropertyValue('--vvh'),
  innerH: window.innerHeight,
}));
check('c1 .app computed height == viewport height (1280px)', aState.h === `${VP.height}px`, `got ${aState.h}, innerHeight=${aState.innerH}`);
check('c2 --vvh absent when keyboard closed', aState.vvh === '', `got "${aState.vvh}"`);

// focus insurance: composer focuses cleanly, no errors
await pageA.locator('.tabpane[style*="flex"]').waitFor({ state: 'visible', timeout: 10000 });
await pageA.locator('.tabpane[style*="flex"] #composer-input').click();
await pageA.waitForTimeout(150);
const focused = await pageA.evaluate(() => document.activeElement?.id === 'composer-input');
check('c3 composer textarea focusable, scrollIntoView no-op safe', focused, '');
await screenshot(pageA, 'kbd-before');

// ---------- Page B: stubbed visualViewport (fallback path) ----------
const ctxB = await browser.newContext({ viewport: VP });
const pageB = await ctxB.newPage();
watch(pageB, 'B');
await pageB.addInitScript(() => {
  const state = { height: window.innerHeight || 1280, scale: 1, offsetTop: 0 };
  window.__vvState = state;
  const target = new EventTarget();
  const stub = {
    get height() { return state.height; },
    get scale() { return state.scale; },
    get offsetTop() { return state.offsetTop; },
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
    dispatchEvent: (...a) => target.dispatchEvent(...a),
  };
  Object.defineProperty(window, 'visualViewport', { value: stub, configurable: true, writable: true });
  window.__vvDispatch = (type) => target.dispatchEvent(new Event(type));
});
await pageB.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await pageB.waitForSelector('.app', { timeout: 10000 });
await pageB.waitForTimeout(500);

const twoFrames = () => pageB.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// keyboard open: innerHeight 1280, vv.height 840 → kb=440 → --vvh=840px
await pageB.evaluate(() => { window.__vvState.height = 840; window.__vvDispatch('resize'); });
let okOpen = true, detOpen = '';
try {
  await pageB.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '840px', null, { timeout: 4000 });
} catch { okOpen = false; }
const bOpen = await pageB.evaluate(() => ({
  vvh: document.documentElement.style.getPropertyValue('--vvh'),
  h: getComputedStyle(document.querySelector('.app')).height,
}));
if (bOpen.h !== '840px') { okOpen = false; }
detOpen = `--vvh="${bOpen.vvh}" .app=${bOpen.h}`;
check('d1 keyboard-open: --vvh=840px and .app height 840px', okOpen, detOpen);
await screenshot(pageB, 'kbd-open');

// keyboard closed: vv.height 1280 → kb=0 → property removed, back to 1280
await pageB.evaluate(() => { window.__vvState.height = 1280; window.__vvDispatch('resize'); });
let okClosed = true;
try {
  await pageB.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '', null, { timeout: 4000 });
} catch { okClosed = false; }
const bClosed = await pageB.evaluate(() => ({
  vvh: document.documentElement.style.getPropertyValue('--vvh'),
  h: getComputedStyle(document.querySelector('.app')).height,
}));
if (bClosed.h !== `${VP.height}px`) okClosed = false;
check('d2 keyboard-closed: --vvh removed, .app back to 1280px', okClosed, `--vvh="${bClosed.vvh}" .app=${bClosed.h}`);

// pinch-zoom guard: scale 1.5 must not update anything
await pageB.evaluate(() => {
  window.__vvState.scale = 1.5;
  window.__vvState.height = 400; // would set --vvh=400px if the guard were missing
  window.__vvDispatch('resize');
});
await twoFrames(); await twoFrames();
const bPinch = await pageB.evaluate(() => ({
  vvh: document.documentElement.style.getPropertyValue('--vvh'),
  h: getComputedStyle(document.querySelector('.app')).height,
}));
check('d3 pinch-zoom (scale 1.5): no update fires', bPinch.vvh === '' && bPinch.h === `${VP.height}px`, `--vvh="${bPinch.vvh}" .app=${bPinch.h}`);

// scroll wiring: with the keyboard "open" (height 840), a pan (offsetTop)
// arriving as a SCROLL event only — no resize — must still drive an update
await pageB.evaluate(() => {
  window.__vvState.scale = 1;
  window.__vvState.height = 840;
  window.__vvDispatch('scroll'); // scroll event only — proves the scroll listener
});
let okScroll = true;
try {
  await pageB.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '840px', null, { timeout: 4000 });
} catch { okScroll = false; }
const bScroll = await pageB.evaluate(() => document.documentElement.style.getPropertyValue('--vvh'));
check('d4 scroll event alone drives update via listener', okScroll, `--vvh="${bScroll}"`);
// restore closed state via scroll too
await pageB.evaluate(() => { window.__vvState.height = 1280; window.__vvDispatch('scroll'); });
await pageB.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '', null, { timeout: 4000 }).catch(() => {});
await screenshot(pageB, 'kbd-after');

console.log(`\npageerrors: ${pageErrors.length ? pageErrors.join(' | ') : 'none'}`);
check('e0 no page errors on either page', pageErrors.length === 0, '');

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
