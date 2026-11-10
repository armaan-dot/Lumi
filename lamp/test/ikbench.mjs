import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.goto('http://127.0.0.1:8765/?autostart=1&sim=1'); await new Promise((r) => setTimeout(r, 6000));
console.log(await p.evaluate(() => { const bd = window.__lumi.body; const N = 200; let worst = 0, tot = 0, maxErr = 0; const t0 = performance.now();
  for (let i = 0; i < N; i++) { const x = 0.05 + 0.9 * Math.random(), y = 0.1 + 0.8 * Math.random(); const t = performance.now(); bd.aimTarget = { x, y }; bd._solve(); const d = performance.now() - t; tot += d; worst = Math.max(worst, d); if (bd.aimErr > maxErr) maxErr = bd.aimErr; }
  let unreach = 0; for (let i = 0; i < 200; i++) { bd.aimTarget = { x: Math.random(), y: Math.random() }; bd._solve(); if (bd.aimErr > 0.12) unreach++; }
  return JSON.stringify({ meanMs: +(tot / N).toFixed(2), worstMs: +worst.toFixed(1), maxErrDeg: +(maxErr * 57.3).toFixed(1), unreachablePct: unreach / 2 }); }));
await b.close();
