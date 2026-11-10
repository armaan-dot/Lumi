// The "brain": owns character state, engagement, dialogue, memory, goal planning.
// It never touches pixels, audio samples or joints. It talks to the page (which
// hosts perception + the simulated body + audio I/O) over the JSON protocol in
// docs/PROTOCOL.md. Every message that needs completion carries an `id` that the
// page echoes back (body.done / say.done / frame), so the brain can sequence
// multi-modal behaviour without sharing a clock with the browser.
import { Engagement } from './engagement.js';
import { validatePlan, EMOTIONS } from './actions.js';

// Emotion -> expressive "style": the character bible in one table. Motion, light
// and voice are chosen *together* so every beat reads as one feeling.
const STYLE = {
  happy:     { light: { color: 'amber',  intensity: 0.95, pattern: 'pulse'   }, gesture: 'wiggle', voice: { rate: 1.08, pitch: 1.35 } },
  curious:   { light: { color: 'cool',   intensity: 0.75, pattern: 'breathe' }, gesture: 'tilt',   voice: { rate: 1.0,  pitch: 1.25 } },
  thinking:  { light: { color: 'violet', intensity: 0.6,  pattern: 'breathe' }, gesture: 'think',  voice: { rate: 0.95, pitch: 1.1  } },
  surprised: { light: { color: 'white',  intensity: 1.0,  pattern: 'flash'   }, gesture: 'perk',   voice: { rate: 1.15, pitch: 1.5  } },
  calm:      { light: { color: 'warm',   intensity: 0.7,  pattern: 'solid'   }, gesture: 'nod',    voice: { rate: 0.98, pitch: 1.15 } },
  sad:       { light: { color: 'dim',    intensity: 0.35, pattern: 'breathe' }, gesture: 'droop',  voice: { rate: 0.9,  pitch: 0.95 } },
};
// Ambient light per engagement state.
const AMBIENT = {
  ABSENT:   { posture: 'sleep', light: { color: 'dim',  intensity: 0.12, pattern: 'breathe' } },
  AWARE:    { posture: 'rest',  light: { color: 'warm', intensity: 0.35, pattern: 'breathe' } },
  ENGAGED:  { posture: 'alert', light: { color: 'warm', intensity: 0.7,  pattern: 'solid'   } },
  DRIFTING: { posture: 'rest',  light: { color: 'warm', intensity: 0.3,  pattern: 'breathe' } },
};
const GREETINGS = ['Oh! Hello there.', 'Hi! I was hoping someone would look my way.', 'Hello! You found me.'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Character {
  constructor({ send, llm, memory, log = console.log, now = () => Date.now() }) {
    this.send = send; this.llm = llm; this.mem = memory; this.log = log; this.now = now;
    this.eng = new Engagement({}, now);
    this.pending = new Map();
    this.seq = 0;
    this.busy = false;
    this.queue = Promise.resolve();
    this.face = null;            // last face percept
    this.lastTrack = { t: 0, x: 0.5, y: 0.5 };
    this.achieved = null;        // latest aim reported by body
    this.metrics = { turns: [], engage: [], perception: {} };
    this.greeted = 0;
    this.convoUntil = 0;
    this.timer = setInterval(() => this._tick(), 200);
    this._applyAmbient();
  }

  dispose() { clearInterval(this.timer); }

  // ------------------------------------------------------------ plumbing
  id(p) { return `${p}${++this.seq}`; }
  /** Send a command and (optionally) await its completion message. */
  cmd(msg, { wait = false, timeout = 15000 } = {}) {
    const id = this.id(msg.type.split('.')[0][0]);
    this.send({ ...msg, id });
    if (!wait) return Promise.resolve(null);
    return new Promise((resolve) => {
      const to = setTimeout(() => { this.pending.delete(id); resolve({ timeout: true }); }, timeout);
      this.pending.set(id, (m) => { clearTimeout(to); resolve(m); });
    });
  }
  onMessage(m) {
    switch (m.type) {
      case 'hello': this.log('page connected'); this._applyAmbient(); break;
      case 'percept.face': this._onFace(m); break;
      case 'percept.speech': this._onSpeech(m); break;
      case 'ui.text': this._enqueue(() => this._turn(m.text, 'text')); break;
      case 'body.state': this.achieved = m.aim; this.metrics.perception.bodyJoints = m.joints; break;
      case 'perf': this.metrics.perception = { ...this.metrics.perception, ...m.data }; break;
      case 'say.started': { const t = this.turnT0; if (t && !this.turnFirstVoice) { this.turnFirstVoice = this.now(); } this._resolve(m); break; }
      case 'body.done': if (m.aim) this.achieved = m.aim; this._resolve(m); break;
      case 'say.done': case 'frame': this._resolve(m); break;
      case 'ui.reset': this.mem.reset(); this.log('memory reset'); break;
      default: break;
    }
  }
  _resolve(m) { const f = this.pending.get(m.id); if (f && m.type !== 'say.started') { this.pending.delete(m.id); f(m); } }
  _enqueue(fn) { this.queue = this.queue.then(fn).catch((e) => this.log('turn error', e)); return this.queue; }

  // ------------------------------------------------------- low-level acts
  light(l) { this.send({ type: 'light', ...l }); }
  sfx(name) { this.send({ type: 'sfx', name }); }
  music(name, action = 'play') { this.send({ type: 'music', name, action }); }
  gesture(name, wait = false) { return this.cmd({ type: 'body.gesture', name }, { wait }); }
  posture(name, dur = 1.0) { return this.cmd({ type: 'body.posture', name, dur }); }
  caption(who, text) { this.send({ type: 'ui.caption', who, text }); }
  async say(text, emotion = 'calm') {
    const st = STYLE[emotion] || STYLE.calm;
    this.caption('lumi', text);
    this.mem.remember('lumi', text);
    return this.cmd({ type: 'say', text, voice: st.voice }, { wait: true, timeout: 20000 });
  }
  /** Aim lamp head/light at an image point; resolves with the body's achieved aim + reachability. */
  async aimImage(x, y, dur = 0.9) {
    return this.cmd({ type: 'body.aim', x, y, dur }, { wait: true, timeout: 8000 });
  }
  async capture(reticle) {
    const r = await this.cmd({ type: 'capture', reticle: reticle || null, width: 640 }, { wait: true, timeout: 8000 });
    if (!r || r.timeout || !r.jpeg) throw new Error('camera frame unavailable');
    return r.jpeg;
  }
  _applyAmbient() {
    const a = AMBIENT[this.eng.state];
    if (!a) return;
    this.light(a.light);
    this.posture(a.posture, 1.4);
  }
  _lookAtPerson(dur = 0.6) {
    if (this.face?.present) this.aimImage(this.face.cx, this.face.cy, dur);
  }

  // ----------------------------------------------------------- perception
  _onFace(m) {
    this.face = m;
    const t = this.now();
    this.metrics.perception = { ...this.metrics.perception, fps: m.fps, inferMs: m.inferMs, attn: m.attn };
    const events = this.eng.update(m);
    for (const e of events) this._enqueue(() => this._onEngagement(e));
    // Track the person with the head when not mid-behaviour. Deadband + rate limit
    // so the head doesn't jitter with landmark noise.
    if (!this.busy && this.eng.state !== 'ABSENT' && m.present) {
      const lt = this.lastTrack;
      if (t - lt.t > 250 && Math.hypot(m.cx - lt.x, m.cy - lt.y) > 0.04) {
        this.lastTrack = { t, x: m.cx, y: m.cy };
        // DRIFTING = polite, reduced tracking: only turn part-way towards them.
        const gain = this.eng.state === 'DRIFTING' ? 0.4 : 1;
        this.send({ type: 'body.aim', id: this.id('t'), x: m.cx, y: m.cy, gain, dur: 0.5, track: true });
      }
    }
  }
  _tick() {
    const evs = this.eng.tick();
    for (const e of evs) this._enqueue(() => this._onEngagement(e));
    this.send({ type: 'ui.state', state: this.eng.state, attn: +this.eng.attn.toFixed(2), busy: this.busy, llm: this.llm.mock ? 'MOCK' : 'cloud' });
  }

  // ------------------------------------------------------ engagement beats
  async _onEngagement(e) {
    this.log('engagement:', e.type, e.fresh ?? '');
    this.metrics.engage.push({ t: this.now(), ...e });
    this.eng.inConversation = this.now() < this.convoUntil;
    this.send({ type: 'ui.event', text: `engagement: ${e.type}` });
    if (this.busy) { return; }
    switch (e.type) {
      case 'aware': // someone appeared: wake up softly, notice them, no sound/voice yet
        this._applyAmbient();
        this._lookAtPerson(1.2);
        break;
      case 'engaged':
        if (e.fresh) await this._greet(); else { this.sfx('blip'); this.gesture('perk'); this.light({ color: 'warm', intensity: 0.8, pattern: 'flash' }); await sleep(300); this._applyAmbient(); this._lookAtPerson(); }
        this.send({ type: 'listen', on: true });
        break;
      case 'drifting': // attention moved: don't chase; dim, tilt questioningly
        this.light(AMBIENT.DRIFTING.light);
        this.gesture('tilt');
        break;
      case 'disengaged':
        this.send({ type: 'listen', on: false });
        this.sfx('chirp_down');
        this.gesture('droop');
        await sleep(400);
        this._applyAmbient();
        break;
      case 'lost':
        this._applyAmbient();
        break;
    }
  }

  async _greet() {
    // Character response moment: motion + light + SFX + music + voice, choreographed.
    this.busy = true;
    try {
      this._lookAtPerson(0.5);
      this.light({ color: 'white', intensity: 1, pattern: 'flash' });
      this.sfx('chirp_up');
      this.gesture('perk');
      await sleep(450);
      this.music('hello', 'play');
      this.light({ color: 'amber', intensity: 0.9, pattern: 'pulse' });
      this.gesture('wiggle');
      await sleep(700);
      const line = this.greeted++ === 0 ? GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
        : Object.keys(this.mem.objects).length ? 'Welcome back. I still remember what was on your desk.' : 'Hello again!';
      await this.say(line, 'happy');
      this.convoUntil = this.now() + 30000;
      this._applyAmbient();
    } finally { this.busy = false; }
  }

  // --------------------------------------------------------------- speech
  _onSpeech(m) {
    this.send({ type: 'ui.caption', who: m.final ? 'you' : 'you…', text: m.text, interim: !m.final });
    if (!m.final || !m.text?.trim()) return;
    if (!this.eng.engaged) { this.log('speech ignored (not engaged):', m.text); this.send({ type: 'ui.event', text: 'heard speech but not engaged - ignored' }); return; }
    this.metrics.speechFinalAt = this.now();
    this._enqueue(() => this._turn(m.text.trim(), 'speech'));
  }

  async _turn(text, source) {
    if (this.busy) return;
    this.busy = true;
    this.turnT0 = source === 'speech' ? (this.metrics.speechFinalAt || this.now()) : this.now();
    this.turnFirstVoice = null;
    const rec = { text, t0: this.turnT0, source };
    try {
      this.send({ type: 'listen', on: false });
      if (source === 'text') this.caption('you', text);
      this.mem.remember('user', text);
      this.convoUntil = this.now() + 30000;
      // Reflex: instant "I heard you" feedback before any cloud latency.
      this.sfx('blip');
      this.light({ color: 'violet', intensity: 0.7, pattern: 'breathe' });
      this.gesture('think');
      const history = this.mem.turns.slice(0, -1).map((t) => `${t.role}: ${t.text}`).join('\n');
      const tR = this.now();
      let r;
      try {
        r = await this.llm.converse({ utterance: text, memory: this.mem.summary(), history, state: this.eng.state });
      } catch (e) { this.log('converse failed', e.message); r = { intent: 'chat', say: "Sorry, my thoughts got tangled. Could you say that again?", emotion: 'sad' }; }
      rec.llmMs = this.now() - tR;
      const emo = EMOTIONS.includes(r.emotion) ? r.emotion : 'calm';
      if (r.intent === 'observe') await this._observe(r, text, rec);
      else if (r.intent === 'goal') await this._goal(r, text, rec);
      else await this._chat(r, emo, rec);
    } catch (e) {
      this.log('turn failed', e);
      this.caption('lumi', '(something went wrong: ' + e.message + ')');
    } finally {
      rec.firstVoiceMs = this.turnFirstVoice ? this.turnFirstVoice - this.turnT0 : null;
      this.metrics.turns.push(rec);
      this.send({ type: 'ui.event', text: `turn: llm ${rec.llmMs}ms, first voice ${rec.firstVoiceMs}ms` });
      this.log('turn', JSON.stringify(rec));
      this.busy = false;
      this._applyAmbient();
      this._lookAtPerson();
      if (this.eng.engaged) this.send({ type: 'listen', on: true });
    }
  }

  async _chat(r, emo, rec) {
    const st = STYLE[emo];
    this.light(st.light);
    if (r.refers_to && this.mem.objects[r.refers_to]?.center) {
      // Recall made visible: glance at where the remembered object was, then back.
      const c = this.mem.objects[r.refers_to].center;
      this.aimImage(c.x, c.y, 0.8);
      this.gesture('point');
    } else this.gesture(st.gesture);
    await this.say(r.say, emo);
  }

  // ------------------------------------------------------- scene memory
  async _observe(r, utterance, rec) {
    this.gesture('lean_in');
    this.music('think', 'play');
    const ack = this.say(r.say || 'Let me look.', 'curious');
    let jpeg;
    try { jpeg = await this.capture(); } catch (e) { await ack; this.music('think', 'stop'); await this.say("My camera isn't giving me a picture.", 'sad'); return; }
    const t = this.now();
    let v;
    try { v = await this.llm.look({ jpeg, focus: utterance }); }
    catch (e) { this.log('look failed', e.message); await ack; this.music('think', 'stop'); await this.say("I couldn't make sense of what I saw.", 'sad'); return; }
    rec.visionMs = this.now() - t;
    await ack;
    this.music('think', 'stop');
    const merged = this.mem.observe(v.objects || []);
    this.send({ type: 'overlay', boxes: merged.map(({ record: o }) => ({ id: o.id, label: `${o.color} ${o.label}`, box: o.box })) });
    this.send({ type: 'ui.memory', objects: Object.values(this.mem.objects) });
    if (merged.length) {
      const first = merged[0].record;
      if (first.center) await this.aimImage(first.center.x, first.center.y, 0.8);   // look AT the thing
    }
    this.sfx('found');
    this.light({ color: 'amber', intensity: 1, pattern: 'flash' });
    this.gesture('nod');
    await sleep(250);
    await this.say(v.spoken || (merged.length ? `I see a ${merged[0].record.color} ${merged[0].record.label}.` : "I don't see anything interesting."), 'happy');
  }

  // ---------------------------------------------------- goal-directed action
  // look -> plan -> act -> look again -> verify/correct (max 2 corrections).
  async _goal(r, goal, rec) {
    this.music('think', 'play');
    const ack = this.say(r.say || 'On it.', 'curious');
    try {
      let jpeg = await this.capture();
      let plan;
      const t = this.now();
      try { plan = await this.llm.plan({ goal, jpeg, memory: this.mem.summary() }); }
      catch (e) { this.log('plan failed', e.message); plan = null; }
      rec.planMs = this.now() - t;
      await ack;
      this.music('think', 'stop');
      if (!plan || plan.target?.found === false) {
        const { steps } = validatePlan(plan?.steps);
        const line = steps.find((s) => s.action === 'say')?.text || "I can't see that from here.";
        this.sfx('chirp_down'); this.gesture('tilt');
        await this.say(line, 'sad');
        return;
      }
      const { steps, rejected } = validatePlan(plan.steps);
      if (rejected.length) this.log('plan rejected parts:', rejected.join('; '));
      this.send({ type: 'ui.plan', goal, target: plan.target, success: plan.success, steps, rejected });
      let target = plan.target && Number.isFinite(plan.target.x) ? { x: plan.target.x, y: plan.target.y } : null;
      await this._execute(steps);

      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(350);
        const reticle = this.achieved && Number.isFinite(this.achieved.x) ? this.achieved : null;
        jpeg = await this.capture(reticle);                       // look again, with the light spot drawn in
        const tv = this.now();
        const v = await this.llm.verify({ goal, success: plan.success, jpeg, target });
        rec.verifyMs = (rec.verifyMs || 0) + (this.now() - tv);
        this.send({ type: 'ui.event', text: `verify #${attempt + 1}: done=${v.done} - ${v.reason}` });
        if (v.done) {
          this.sfx('found'); this.music('celebrate', 'play'); this.gesture('wiggle');
          this.light({ color: 'amber', intensity: 1, pattern: 'pulse' });
          await this.say(v.spoken || 'Got it.', 'happy');
          return;
        }
        if (!v.target_visible || !v.target || attempt === 2) {
          this.sfx('chirp_down'); this.gesture('droop');
          await this.say(v.target_visible === false ? "I lost sight of it, so I can't finish that." : "I couldn't quite get the light there.", 'sad');
          return;
        }
        target = { x: v.target.x, y: v.target.y };                // closed-loop correction from fresh evidence
        const res = await this.aimImage(target.x, target.y, 0.7);
        if (res && res.reachable === false) { await this.say("That's past what my neck can turn.", 'sad'); return; }
      }
    } finally { this.music('think', 'stop'); }
  }

  async _execute(steps) {
    for (const s of steps) {
      switch (s.action) {
        case 'aim': {
          const r = await this.aimImage(s.x, s.y, 1.0);
          if (r && r.reachable === false) this.send({ type: 'ui.event', text: `aim not fully reachable (err ${(r.err * 57.3).toFixed(1)}°)` });
          break;
        }
        case 'light': this.light(s); break;
        case 'gesture': this.gesture(s.name); break;
        case 'sfx': this.sfx(s.name); break;
        case 'say': await this.say(s.text, 'curious'); break;
        case 'hold': await sleep(s.ms); break;
      }
    }
  }
}
