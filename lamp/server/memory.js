// Scene + dialogue memory. Deliberately small and inspectable: a JSON file of
// object records. Objects are matched across observations by label+colour so a
// re-observation updates (not duplicates) the record.
import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

export class Memory {
  constructor(file) {
    this.file = file;
    this.objects = {};
    this.turns = []; // recent dialogue [{role, text}]
    this.seq = 0;
    this._load();
  }
  _load() {
    if (!this.file) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.objects = d.objects || {};
      this.seq = d.seq || 0;
    } catch { /* first run */ }
  }
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ objects: this.objects, seq: this.seq }, null, 2));
    } catch (e) { console.warn('memory save failed', e.message); }
  }
  reset() { this.objects = {}; this.turns = []; this.seq = 0; this.save(); }

  /** Merge a vision observation. Returns [{record, isNew}] */
  observe(objs, t = Date.now()) {
    const out = [];
    const seen = new Set();
    for (const o of objs) {
      if (!o || !o.label) continue;
      const key = norm(o.label) + '|' + norm(o.color);
      seen.add(key);
      let rec = Object.values(this.objects).find((r) => r.key === key);
      const isNew = !rec;
      if (!rec) {
        rec = { id: 'o' + ++this.seq, key, firstSeen: t, sightings: 0 };
        this.objects[rec.id] = rec;
      }
      const box = Array.isArray(o.box) && o.box.length === 4 ? o.box.map(Number) : null;
      Object.assign(rec, {
        label: o.label, color: o.color || '', material: o.material || '',
        description: o.description || '', text: o.text || '',
        heldByPerson: !!o.held_by_person, lastSeen: t, present: true,
      });
      if (box) { rec.box = box; rec.center = { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 }; }
      rec.sightings++;
      out.push({ record: rec, isNew });
    }
    // Objects missing from a full-scene look are kept but flagged not-in-view.
    for (const r of Object.values(this.objects)) if (!seen.has(r.key)) r.present = false;
    this.save();
    return out;
  }

  where(c) {
    if (!c) return 'unknown position';
    const h = c.x < 0.34 ? 'left' : c.x > 0.66 ? 'right' : 'centre';
    const v = c.y < 0.34 ? 'upper' : c.y > 0.66 ? 'lower' : 'middle';
    return `${v}-${h} of my camera view (x=${c.x.toFixed(2)}, y=${c.y.toFixed(2)})`;
  }
  ago(t, now = Date.now()) {
    const s = Math.round((now - t) / 1000);
    return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
  }
  /** Compact text for LLM prompts. */
  summary(now = Date.now()) {
    const rs = Object.values(this.objects);
    if (!rs.length) return '(nothing remembered yet)';
    return rs.map((r) => `- [${r.id}] ${r.color} ${r.label}${r.material ? ' (' + r.material + ')' : ''}: ${r.description}` +
      `${r.text ? `; text on it: "${r.text}"` : ''}; last seen ${this.where(r.center)}, ${this.ago(r.lastSeen, now)}` +
      `${r.heldByPerson ? ', held by the person' : ''}; ${r.present ? 'in view at my last look' : 'NOT in view at my last look'}; ` +
      `first seen ${this.ago(r.firstSeen, now)}, seen ${r.sightings}x`).join('\n');
  }
  remember(role, text) { this.turns.push({ role, text }); if (this.turns.length > 12) this.turns.shift(); }
}
