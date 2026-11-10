// Page = sensors + actuators + a thin protocol shim. No character decisions are
// made here (the one exception is the voice->light "lip-sync" reflex, which is
// local on purpose: it must track word boundaries within ~10 ms).
import { Body } from '/body.js';
import { Perception } from '/perception.js';
import { AudioIO } from '/audio.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let ws, body, perception, audio;
const outbox = [];
const send = (m) => { const s = JSON.stringify(m); if (ws?.readyState === 1) ws.send(s); else if (outbox.length < 50) outbox.push(s); };

function log(text) { const l = $('log'); const d = document.createElement('div'); d.textContent = new Date().toTimeString().slice(0, 8) + ' ' + text; l.appendChild(d); while (l.children.length > 80) l.firstChild.remove(); l.scrollTop = l.scrollHeight; }
function caption(who, text, interim) {
  const box = $('captions');
  let last = box.lastElementChild;
  if (last && last.classList.contains('interim') && last.classList.contains(who.replace('…', ''))) last.remove();
  const d = document.createElement('div'); d.className = `cap ${who.replace('…', '')}${interim ? ' interim' : ''}`; d.textContent = text; box.appendChild(d);
  while (box.children.length > 8) box.firstChild.remove(); box.scrollTop = box.scrollHeight;
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { send({ type: 'hello' }); outbox.splice(0).forEach((s) => ws.send(s)); log('connected to brain'); };
  ws.onclose = () => { log('brain disconnected - retrying'); setTimeout(connect, 1500); };
  ws.onmessage = (e) => onBrain(JSON.parse(e.data));
}

function onBrain(m) {
  switch (m.type) {
    case 'body.aim': case 'body.posture': case 'body.gesture': case 'light': case 'body.release': body?.handle(m); break;
    case 'say': caption('lumi', m.text); audio?.say(m.id, m.text, m.voice); break;
    case 'sfx': audio?.sfx(m.name); break;
    case 'music': audio?.music(m.name, m.action); break;
    case 'listen': audio?.listen(m.on); $('mode').textContent = m.on ? '🎤 listening' : '🎤 off'; break;
    case 'capture': {
      const jpeg = perception ? perception.capture(m.width || 640, m.reticle) : null;
      send({ type: 'frame', id: m.id, jpeg, w: m.width });
      break;
    }
    case 'overlay': body?.drawOverlay(m.boxes); break;
    case 'ui.caption': if (m.who === 'lumi') break; caption(m.who, m.text, m.interim); break;
    case 'ui.state': {
      const c = $('chip'); c.textContent = m.state; c.className = 'chip s-' + m.state;
      $('attn').style.width = Math.round(m.attn * 100) + '%'; $('llm').textContent = 'LLM: ' + m.llm; break;
    }
    case 'ui.event': log(m.text); break;
    case 'ui.plan': $('plan').textContent = `goal: ${m.goal}\ntarget: ${JSON.stringify(m.target)}\nsuccess: ${m.success}\n` + m.steps.map((s) => '• ' + JSON.stringify(s)).join('\n') + (m.rejected?.length ? '\nrejected: ' + m.rejected.join('; ') : ''); body?.drawOverlay([{ label: 'target: ' + (m.target?.label || '?'), box: m.target ? [m.target.x - 0.06, m.target.y - 0.08, 0.12, 0.16] : null }]); break;
    case 'ui.memory': {
      const ul = $('memory'); ul.innerHTML = '';
      if (!m.objects.length) ul.innerHTML = '<li class="dim">nothing remembered yet</li>';
      for (const o of m.objects) { const li = document.createElement('li'); li.innerHTML = `<b></b> <span class="dim"></span><br><span></span>`; li.children[0].textContent = `${o.color} ${o.label}`; li.children[2].textContent = o.description; li.children[1].textContent = `${o.id} · seen ${o.sightings}×${o.present ? '' : ' · out of view'}`; ul.appendChild(li); }
      break;
    }
  }
}

async function wake() {
  $('go').disabled = true; $('startmsg').textContent = 'loading robot, face model…';
  const video = $('cam');
  audio = new AudioIO(send); audio.start();
  try { body = await Body.create($('view'), video); } catch (e) { $('startmsg').textContent = 'body failed: ' + e.message; console.error(e); return; }
  body.onEvent = send;
  audio.onBoundary = () => body.pulseLight(0.3);
  connect();
  perception = new Perception(video, send);
  if (params.get('sim')) perception.sim = { present: true, attn: 0, cx: 0.5, cy: 0.45 };
  try { await perception.start(); } catch (e) { log('camera/face model unavailable → sim mode (' + e.message + ')'); perception.sim = { present: false, attn: 0, cx: 0.5, cy: 0.45 }; perception.running = true; perception._loop(); }
  if (!audio.sttAvailable) log('SpeechRecognition unavailable in this browser - use the text box');
  $('start').style.display = 'none';
  setInterval(() => { send({ type: 'body.state', ...body.state() }); }, 100);
  setInterval(() => {
    $('perf').textContent = `render ${body.fps.toFixed(0)} fps · face ${perception.fps.toFixed(0)} Hz · infer ${perception.inferMs.toFixed(1)} ms${perception.sim ? ' · SIM' : ''}`;
    const q = body.q; $('joints').textContent = Object.entries(q).map(([k, v]) => `${k.padEnd(8)}${(v * 57.3).toFixed(0).padStart(5)}°`).join('\n');
    send({ type: 'perf', data: { renderFps: +body.fps.toFixed(1), faceHz: +perception.fps.toFixed(1), inferMs: +perception.inferMs.toFixed(1) } });
  }, 500);
}
$('go').onclick = wake;
$('form').onsubmit = (e) => { e.preventDefault(); const v = $('text').value.trim(); if (v) { send({ type: 'ui.text', text: v }); $('text').value = ''; } };
$('reset').onclick = () => { send({ type: 'ui.reset' }); $('memory').innerHTML = '<li class="dim">nothing remembered yet</li>'; };
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || !perception) return;
  const k = e.key.toLowerCase();
  if (k === 'a') { perception.sim = { present: true, attn: 0.95, cx: 0.5, cy: 0.42 }; log('sim: person attending'); }
  if (k === 'l') { perception.sim = { present: true, attn: 0.05, cx: 0.6, cy: 0.42 }; log('sim: person looking away'); }
  if (k === 'x') { perception.sim = null; log('sim off'); }
  if (k === 'n') { perception.sim = { present: false, attn: 0, cx: 0.5, cy: 0.5 }; log('sim: nobody'); }
});
window.__lumi = { get body() { return body; }, send, onBrain };
if (params.get('autostart')) setTimeout(wake, 200);
