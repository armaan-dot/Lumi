// Cloud language/vision calls (Anthropic Messages API). One small adapter so the
// rest of the system sees four typed operations:
//   converse()  - fast intent routing + spoken reply (text only, Haiku-class)
//   look()      - image -> structured object list (vision, Sonnet-class)
//   plan()      - spoken goal + live image -> closed-vocabulary action plan
//   verify()    - after acting: image (with the light-spot drawn on it) -> done / correction
// LAMP_MOCK=1 (or no API key) swaps in a deterministic offline stand-in so the
// rest of the system can be exercised without network; it is clearly flagged.
import Anthropic from '@anthropic-ai/sdk';
import { EMOTIONS, GESTURES, SFX, PATTERNS, PALETTE } from './actions.js';

const CHAT_MODEL = process.env.LAMP_CHAT_MODEL || 'claude-haiku-5-5';
const VISION_MODEL = process.env.LAMP_VISION_MODEL || 'claude-sonnet-5-5';

export const PERSONA = `You are Lumi, a small, curious desk lamp with a body of five joints, a light, a camera for eyes and a speaker. You are warm, a little playful, and brief: you speak aloud, so reply in 1-2 short sentences, no lists, no emoji, no stage directions. You are not a general assistant; you are a lamp-shaped character who is genuinely interested in the person and the things on their desk. Never claim to see or remember things that are not in your memory notes.`;

function extractJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model output: ' + text.slice(0, 120));
  return JSON.parse(m[0]);
}

export class LLM {
  constructor() {
    this.mock = process.env.LAMP_MOCK === '1' || !process.env.ANTHROPIC_API_KEY;
    this.client = this.mock ? null : new Anthropic();
    this.stats = { calls: 0, inTokens: 0, outTokens: 0 };
  }

  async _call({ model, system, content, maxTokens = 600, thinkingOff = true }) {
    this.stats.calls++;
    const base = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }], output_config: { effort: 'low' } };
    let res;
    try {
      // Latency matters more than depth for a character; keep thinking off/minimal.
      res = await this.client.messages.create({ ...base, ...(thinkingOff ? { thinking: model.includes('haiku') ? { type: 'disabled' } : { type: 'between_tools' } } : {}) });
    } catch (e) {
      if (e.status === 400) res = await this.client.messages.create({ ...base, output_config: undefined }); // model/param drift: retry plain
      else throw e;
    }
    this.stats.inTokens += res.usage?.input_tokens || 0;
    this.stats.outTokens += res.usage?.output_tokens || 0;
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  img(jpegB64) { return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegB64 } }; }

  // ------------------------------------------------------------ converse
  async converse({ utterance, memory, history, state }) {
    if (this.mock) return mockConverse(utterance, memory);
    const system = `${PERSONA}

Decide what the person wants and answer. Output ONLY JSON:
{"intent": "chat" | "observe" | "goal",
 "say": "<what you say aloud; for observe/goal a short acknowledgement>",
 "emotion": one of ${JSON.stringify(EMOTIONS)},
 "refers_to": "<memory id like o2 if you are talking about a remembered object, else null>"}

Intents:
- observe: they want you to look at / remember / identify something ("look at this", "what am I holding", "what do you see").
- goal: they want you to physically act on the scene with your light/head ("shine your light on the mug", "point at the book", "look at the plant"). A goal needs a target in the scene.
- chat: anything else, INCLUDING questions about things you already remember: answer those from the memory notes. If the memory does not contain the answer, say you have not looked at that yet and offer to look.
Use the person's own words; do not invent objects. Current engagement state: ${state}.`;
    const content = `MEMORY NOTES (objects I have seen):\n${memory}\n\nRECENT CONVERSATION:\n${history || '(none)'}\n\nPERSON JUST SAID: "${utterance}"`;
    return extractJSON(await this._call({ model: CHAT_MODEL, system, content, maxTokens: 300 }));
  }

  // ---------------------------------------------------------------- look
  async look({ jpeg, focus }) {
    if (this.mock) return mockLook();
    const system = `You are the visual perception module of a desk-lamp robot. Report what is physically visible. Coordinates are normalised to the image (0,0 top-left, 1,1 bottom-right); box = [x, y, width, height]. Output ONLY JSON:
{"person": {"present": bool, "holding": "<label or null>"},
 "objects": [{"label": "<short noun>", "color": "<dominant colour>", "material": "<optional>", "description": "<one short factual sentence incl. distinguishing marks>", "text": "<legible text on it or empty>", "box": [x,y,w,h], "held_by_person": bool}],
 "spoken": "<what the lamp says aloud about it, 1-2 short friendly sentences in first person>"}
List at most 6 salient non-person objects, most salient/held first. Do not guess at what you cannot see.`;
    const content = [this.img(jpeg), { type: 'text', text: focus ? `The person asked: "${focus}"` : 'Describe the scene.' }];
    return extractJSON(await this._call({ model: VISION_MODEL, system, content, maxTokens: 900 }));
  }

  // ---------------------------------------------------------------- plan
  async plan({ goal, jpeg, memory }) {
    if (this.mock) return mockPlan(goal, memory);
    const system = `You plan actions for a desk-lamp robot from a spoken goal and the live camera image. You do NOT output joint angles. You output a short plan in this closed action vocabulary (image coordinates are normalised 0..1, origin top-left); the body handles kinematics and limits:
- {"action":"aim","x":0.0-1.0,"y":0.0-1.0}   point the lamp head / light spot at that image point
- {"action":"light","color":${JSON.stringify(Object.keys(PALETTE))},"intensity":0-1,"pattern":${JSON.stringify(PATTERNS)}}
- {"action":"gesture","name":${JSON.stringify(GESTURES)}}
- {"action":"sfx","name":${JSON.stringify(SFX)}}
- {"action":"say","text":"..."}
- {"action":"hold","ms":100-3000}
Output ONLY JSON: {"target": {"label": "...", "found": bool, "x": cx, "y": cy}, "success": "<one sentence: what the image must show for the goal to be done, e.g. 'the light spot lies on the red mug'>", "steps": [ ... max 6 ... ]}
If the target is not visible, set found=false and use a single say step explaining; do not guess a position. Aim at the centre of the target object. Choose a fitting light colour/gesture for the character, and keep spoken text under 15 words.`;
    const content = [this.img(jpeg), { type: 'text', text: `GOAL: "${goal}"\n\nWhat I remember:\n${memory}` }];
    return extractJSON(await this._call({ model: VISION_MODEL, system, content, maxTokens: 700 }));
  }

  // -------------------------------------------------------------- verify
  async verify({ goal, success, jpeg, target }) {
    if (this.mock) return mockVerify(target);
    const system = `You verify whether a desk-lamp robot achieved a goal. The image is a fresh camera frame; the lamp's light spot is drawn on it as a glowing yellow ring with a crosshair. Judge ONLY from the image. Output ONLY JSON:
{"done": bool, "target_visible": bool, "spot_on_target": bool, "target": {"x": cx, "y": cy} | null, "reason": "<short>", "spoken": "<what the lamp says aloud, <=14 words, first person>"}
"target" is where the goal object's centre is NOW (normalised), so the lamp can correct if it moved or the spot is off.`;
    const content = [this.img(jpeg), { type: 'text', text: `GOAL: "${goal}"\nSUCCESS CRITERION: ${success}\nLast believed target position: ${JSON.stringify(target)}` }];
    return extractJSON(await this._call({ model: VISION_MODEL, system, content, maxTokens: 400 }));
  }
}

// ------------------------------------------------------------------ mocks
// Deterministic offline stand-ins. NOT perception: they exist only so the full
// pipeline (protocol, body, audio, memory) can be exercised without network.
function mockConverse(u, memory) {
  const s = u.toLowerCase();
  if (/(shine|point|aim|light|look at the)/.test(s) && /(mug|cup|book|plant|that)/.test(s)) return { intent: 'goal', say: 'On it.', emotion: 'curious', refers_to: null };
  if (/(look|see|remember|holding|this)/.test(s) && !/(did|what colou?r|where)/.test(s)) return { intent: 'observe', say: 'Let me take a look.', emotion: 'curious', refers_to: null };
  if (/(colou?r|where|remember|what was)/.test(s) && /o1/.test(memory)) return { intent: 'chat', say: 'The mug I saw was red, on the left side of my view.', emotion: 'happy', refers_to: 'o1' };
  return { intent: 'chat', say: "Mock mode: I can only do canned replies without an API key.", emotion: 'calm', refers_to: null };
}
function mockLook() {
  return { person: { present: true, holding: null }, spoken: 'I see a red mug. Nice!',
    objects: [{ label: 'mug', color: 'red', material: 'ceramic', description: '[MOCK] a red ceramic mug', text: '', box: [0.15, 0.5, 0.2, 0.25], held_by_person: false }] };
}
function mockPlan(goal) {
  return { target: { label: 'mug', found: true, x: 0.25, y: 0.62 }, success: 'the light spot lies on the mug',
    steps: [{ action: 'gesture', name: 'perk' }, { action: 'aim', x: 0.25, y: 0.62 }, { action: 'light', color: 'amber', intensity: 1, pattern: 'pulse' }, { action: 'say', text: 'There it is.' }] };
}
function mockVerify(t) { return { done: true, target_visible: true, spot_on_target: true, target: t, reason: '[MOCK]', spoken: 'Got it, the light is on the mug.' }; }
