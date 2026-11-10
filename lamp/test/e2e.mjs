// Headless end-to-end smoke test: real browser (Edge/Chrome), fake camera, MOCK LLM.
// Drives the page through the demo flow using the sim-attention hook and checks the brain's behaviour.
import puppeteer from 'puppeteer-core';
const exe = process.env.BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.env.URL || 'http://127.0.0.1:8765/?autostart=1&sim=1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const logs = [];
page.on('console', (m) => logs.push(m.text())); page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await page.goto(url);
await sleep(4000);
const shot = async (n) => page.screenshot({ path: `test/out/${n}.png` });
import fs from 'node:fs'; fs.mkdirSync('test/out', { recursive: true });
const state = () => page.$eval('#chip', (e) => e.textContent);
const events = () => page.$eval('#log', (e) => e.innerText);
await shot('0-sleep');
console.log('state:', await state());
await page.keyboard.press('a'); await sleep(3500);
console.log('after attend:', await state());
await shot('1-engaged');
await sleep(4500); await shot('2-after-greeting');
await page.type('#text', 'look at this and remember it'); await page.keyboard.press('Enter'); await sleep(5000); await shot('3-observe');
await page.type('#text', 'shine your light on the mug'); await page.keyboard.press('Enter'); await sleep(9000); await shot('4-goal');
await page.keyboard.press('l'); await sleep(6000); console.log('after look away:', await state()); await shot('5-drift');
console.log('--- events ---\n' + await events());
console.log('--- console ---\n' + logs.filter((l) => /error|ERROR|fail/i.test(l)).join('\n'));
await browser.close();
