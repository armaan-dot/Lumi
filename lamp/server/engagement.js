// Engagement state machine. Pure (no I/O, injectable clock) so it can be unit-tested.
// Input: attention samples from perception. Output: discrete events.
//
//   ABSENT --face--> AWARE --attn high (dwell)--> ENGAGED --attn low (dwell)--> DRIFTING
//      ^               |                             ^                            |
//      |               +--face lost--> ABSENT        +--attn high (short dwell)---+
//      +------------------------ grace timeout / face lost -----------------------+
//
// Hysteresis (ENTER > EXIT), dwell times and a grace window are what make this
// feel intentional rather than twitchy. Values are tuned for ~10 Hz samples.
export const DEFAULTS = {
  enter: 0.6,          // attn needed to count as "looking at me"
  exit: 0.35,          // attn below this counts as "looking away"
  dwellEngage: 500,    // ms attn must stay high before ENGAGED
  dwellReengage: 300,  // ms (shorter) when returning from DRIFTING
  dwellDrift: 700,     // ms attn must stay low before DRIFTING
  dwellAware: 300,     // ms a face must be present before AWARE
  graceMs: 4000,       // DRIFTING -> disengaged
  graceConvMs: 8000,   // longer grace while a conversation is active
  lostMs: 1500,        // no face for this long => ABSENT
  staleMs: 800,        // percept older than this is treated as "no face"
  alpha: 0.45,         // EMA smoothing of attn
  greetCooldownMs: 20000,
};

export class Engagement {
  constructor(opts = {}, now = () => Date.now()) {
    this.o = { ...DEFAULTS, ...opts };
    this.now = now;
    this.state = 'ABSENT';
    this.attn = 0;
    this.present = false;
    this.lastSample = 0;
    this.since = now();
    this.highSince = null;
    this.lowSince = null;
    this.faceSince = null;
    this.faceLostSince = null;
    this.lastDisengaged = -1e12;
    this.inConversation = false;
  }

  _go(state, events, type, extra = {}) {
    this.state = state;
    this.since = this.now();
    events.push({ type, ...extra });
  }

  /** Feed a perception sample; returns an array of events. */
  update(sample) {
    const t = this.now();
    this.lastSample = t;
    const present = !!sample.present;
    const raw = present ? sample.attn : 0;
    this.attn = this.attn + this.o.alpha * (raw - this.attn);
    this.present = present;
    return this.tick(t);
  }

  /** Time-based transitions; also call periodically so stale input is handled. */
  tick(t = this.now()) {
    const events = [];
    const o = this.o;
    const stale = t - this.lastSample > o.staleMs;
    const present = this.present && !stale;
    const attn = stale ? 0 : this.attn;

    this.faceSince = present ? (this.faceSince ?? t) : null;
    this.faceLostSince = present ? null : (this.faceLostSince ?? t);
    this.highSince = attn >= o.enter && present ? (this.highSince ?? t) : null;
    this.lowSince = (attn < o.exit || !present) ? (this.lowSince ?? t) : null;

    switch (this.state) {
      case 'ABSENT':
        if (present && t - this.faceSince >= o.dwellAware) this._go('AWARE', events, 'aware');
        break;
      case 'AWARE':
        if (!present && t - this.faceLostSince >= o.lostMs) this._go('ABSENT', events, 'lost');
        else if (this.highSince && t - this.highSince >= o.dwellEngage) {
          const fresh = t - this.lastDisengaged > o.greetCooldownMs;
          this._go('ENGAGED', events, 'engaged', { fresh });
        }
        break;
      case 'ENGAGED':
        if (this.lowSince && t - this.lowSince >= o.dwellDrift) this._go('DRIFTING', events, 'drifting');
        break;
      case 'DRIFTING': {
        const grace = this.inConversation ? o.graceConvMs : o.graceMs;
        if (this.highSince && t - this.highSince >= o.dwellReengage) this._go('ENGAGED', events, 'engaged', { fresh: false });
        else if (t - this.since >= grace) {
          this.lastDisengaged = t;
          this._go(present ? 'AWARE' : 'ABSENT', events, 'disengaged', { personStillThere: present });
          this.highSince = null; // must re-earn engagement
        }
        break;
      }
    }
    return events;
  }

  get engaged() { return this.state === 'ENGAGED' || this.state === 'DRIFTING'; }
}
