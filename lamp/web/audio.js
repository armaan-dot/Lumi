// Audio side of the character: synthesised SFX + music (WebAudio, no asset
// files), TTS (speechSynthesis) and STT (Web Speech API). Everything audible
// shares one master bus so music can be *ducked* under speech - the voice always
// wins - and the mic is closed while the lamp talks (no echo / self-hearing).
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI -> Hz

export class AudioIO {
  constructor(emit) {
    this.emit = emit;           // (msg) => send to brain
    this.ctx = null; this.wantListen = false; this.speaking = false;
    this.musicStop = null; this.rec = null; this.onBoundary = () => {};
  }

  start() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.9; this.master.connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain(); this.musicBus.gain.value = 0.5; this.musicBus.connect(this.master);
    this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = 0.7; this.sfxBus.connect(this.master);
    this._initSTT();
    speechSynthesis.getVoices();
  }

  // ------------------------------------------------------------------ synth
  _tone({ f, f2, t = 0, dur = 0.2, type = 'sine', vol = 0.3, bus = this.sfxBus, attack = 0.005, lp }) {
    const c = this.ctx; const t0 = c.currentTime + t;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = o;
    if (lp) { const fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; o.connect(fl); node = fl; }
    node.connect(g); g.connect(bus); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  sfx(name) {
    if (!this.ctx) return;
    switch (name) {
      case 'chirp_up': this._tone({ f: 600, f2: 1500, dur: 0.16, type: 'triangle', vol: 0.35 }); this._tone({ f: 900, f2: 1900, t: 0.12, dur: 0.14, type: 'triangle', vol: 0.3 }); break;
      case 'chirp_down': this._tone({ f: 1000, f2: 380, dur: 0.28, type: 'triangle', vol: 0.3 }); break;
      case 'blip': this._tone({ f: 880, dur: 0.07, type: 'square', vol: 0.12, lp: 2500 }); break;
      case 'boop': this._tone({ f: 330, f2: 300, dur: 0.14, vol: 0.4 }); break;
      case 'found': [NOTE(88), NOTE(93)].forEach((f, i) => { this._tone({ f, t: i * 0.11, dur: 0.5, vol: 0.22 }); this._tone({ f: f * 2.76, t: i * 0.11, dur: 0.25, vol: 0.06 }); }); break;
      case 'whoosh': { const c = this.ctx; const b = c.createBuffer(1, c.sampleRate * 0.4, c.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const s = c.createBufferSource(); s.buffer = b; const fl = c.createBiquadFilter(); fl.type = 'bandpass'; fl.Q.value = 2; fl.frequency.setValueAtTime(400, c.currentTime); fl.frequency.exponentialRampToValueAtTime(3000, c.currentTime + 0.35); const g = c.createGain(); g.gain.setValueAtTime(0.25, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.4); s.connect(fl); fl.connect(g); g.connect(this.sfxBus); s.start(); break; }
    }
  }

  // ------------------------------------------------------------------ music
  music(name, action = 'play') {
    if (!this.ctx) return;
    if (action === 'stop') { this._stopMusic(); return; }
    if (name === 'think') { this._stopMusic(); this._thinkLoop(); return; }
    if (name === 'hello') { // rising pluck arpeggio, C major add9
      [72, 76, 79, 84, 86].forEach((n, i) => this._tone({ f: NOTE(n), t: i * 0.11, dur: 0.7, type: 'triangle', vol: 0.2, bus: this.musicBus, lp: 3500 }));
      [60, 67, 76].forEach((n) => this._tone({ f: NOTE(n), t: 0.5, dur: 1.2, type: 'sine', vol: 0.12, bus: this.musicBus }));
    }
    if (name === 'celebrate') {
      [67, 72, 76, 79, 84, 88].forEach((n, i) => this._tone({ f: NOTE(n), t: i * 0.08, dur: 0.5, type: 'triangle', vol: 0.18, bus: this.musicBus, lp: 4000 }));
      [72, 76, 79, 84].forEach((n) => this._tone({ f: NOTE(n), t: 0.55, dur: 1.4, type: 'sine', vol: 0.1, bus: this.musicBus }));
    }
  }
  _stopMusic() { if (this.musicStop) { this.musicStop(); this.musicStop = null; } }
  _thinkLoop() { // soft Am9 arpeggio, loops until stopped
    let alive = true; const seq = [57, 64, 67, 71, 76, 71, 67, 64]; let i = 0;
    const tick = () => { if (!alive) return; this._tone({ f: NOTE(seq[i % seq.length]), dur: 0.55, type: 'triangle', vol: 0.11, bus: this.musicBus, lp: 1800 }); if (i % 8 === 0) this._tone({ f: NOTE(45), dur: 2.4, vol: 0.09, bus: this.musicBus }); i++; setTimeout(tick, 260); };
    tick(); this.musicStop = () => { alive = false; };
  }
  _duck(on) { const g = this.musicBus.gain; const t = this.ctx.currentTime; g.cancelScheduledValues(t); g.setTargetAtTime(on ? 0.15 : 0.5, t, 0.08); }

  // -------------------------------------------------------------------- TTS
  _pickVoice() {
    const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    const pref = ['Google US English', 'Samantha', 'Microsoft Aria', 'Microsoft Zira', 'Jenny', 'Karen', 'Female'];
    for (const p of pref) { const v = vs.find((x) => x.name.includes(p)); if (v) return v; }
    return vs[0] || null;
  }
  say(id, text, voice = {}) {
    return new Promise((resolve) => {
      let started = false, done = false;
      const finish = () => { if (done) return; done = true; this.speaking = false; this._duck(false); this.emit({ type: 'say.done', id }); setTimeout(() => this._resumeListen(), 350); resolve(); };
      const begin = () => { if (started) return; started = true; this.speaking = true; this._duck(true); this._pauseListen(); this.emit({ type: 'say.started', id }); };
      const u = new SpeechSynthesisUtterance(text);
      const v = this._pickVoice(); if (v) u.voice = v;
      u.rate = voice.rate ?? 1; u.pitch = voice.pitch ?? 1.2; u.volume = 1;
      u.onstart = begin; u.onend = finish; u.onerror = () => { begin(); finish(); };
      u.onboundary = () => this.onBoundary();
      this._u = u; // keep a strong ref (Chrome GC bug)
      speechSynthesis.cancel(); speechSynthesis.speak(u);
      // Fallback for platforms with no working synth voice: simulate timing so the loop never stalls.
      setTimeout(() => { if (!started) { begin(); setTimeout(finish, Math.min(8000, text.length * 65)); } }, 2500);
    });
  }

  // -------------------------------------------------------------------- STT
  _initSTT() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.sttAvailable = false; return; }
    this.sttAvailable = true;
    const r = new SR(); r.continuous = true; r.interimResults = true; r.lang = 'en-US';
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        this.emit({ type: 'percept.speech', text: res[0].transcript.trim(), final: res.isFinal, conf: res[0].confidence });
      }
    };
    r.onend = () => { this.recActive = false; if (this.wantListen && !this.speaking) setTimeout(() => this._startRec(), 200); };
    r.onerror = (e) => { this.emit({ type: 'perf', data: { sttError: e.error } }); };
    this.rec = r;
  }
  _startRec() { if (!this.rec || this.recActive) return; try { this.rec.start(); this.recActive = true; } catch { /* already started */ } }
  listen(on) { this.wantListen = on; if (on && !this.speaking) this._startRec(); if (!on && this.rec && this.recActive) { try { this.rec.stop(); } catch {} } }
  _pauseListen() { if (this.rec && this.recActive) { try { this.rec.abort(); } catch {} this.recActive = false; } }
  _resumeListen() { if (this.wantListen && !this.speaking) this._startRec(); }
}
