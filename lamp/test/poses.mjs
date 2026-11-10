import puppeteer from 'puppeteer-core'; import fs from 'node:fs';
const exe = process.env.BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('test/out', { recursive: true });
const b = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1000,700'] });
const p = await b.newPage(); await p.setViewport({ width: 1000, height: 700 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await p.goto('http://127.0.0.1:8765/?autostart=1&sim=1'); await sleep(5000);
const run = (m) => p.evaluate((m) => window.__lumi.body.handle(m), m);
const info = () => p.evaluate(() => { const b = window.__lumi.body; return JSON.stringify({ q: Object.fromEntries(Object.entries(b.q).map(([k, v]) => [k, +(v * 57.3).toFixed(0)])), ach: b.achievedImage(), err: +(b.aimErr * 57.3).toFixed(1) }); });
const steps = [
  ['sleep', { type: 'body.posture', name: 'sleep' }], ['rest', { type: 'body.posture', name: 'rest' }], ['alert', { type: 'body.posture', name: 'alert' }],
  ['aim_center', { type: 'body.aim', x: 0.5, y: 0.5, id: 'a' }], ['aim_left', { type: 'body.aim', x: 0.15, y: 0.55, id: 'b' }], ['aim_right_low', { type: 'body.aim', x: 0.85, y: 0.8, id: 'c' }],
];
for (const [n, m] of steps) { await run(m); await sleep(3500); await run({ type: 'light', color: '#ffc766', intensity: 1, pattern: 'solid' }); await sleep(300); console.log(n, await info()); await p.screenshot({ path: `test/out/pose-${n}.png` }); }
await b.close();
