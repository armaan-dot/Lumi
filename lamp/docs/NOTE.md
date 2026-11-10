# Technical note — Lumi, a live character around the 5-DOF lamp

## 1. What was built / left out
**Built:** engagement (local face+gaze → hysteresis state machine), choreographed acknowledgement (motion + light + SFX + music + voice),
spoken dialogue, scene memory (cloud vision → structured object records → later recall, with a visible glance at the remembered spot),
and goal-directed action (spoken goal + live frame → closed-vocabulary plan → act → re-look with the light spot drawn into the frame → verify/correct).
**Left out (deliberately):** offline STT/TTS, barge-in, a physics engine, multi-person handling, depth estimation, persistent identity of people.
**Not measured yet** (no API key / physical camera in the build environment): real-face engagement reliability, cloud turn latency, laptop CPU/RAM — see §5; `scripts/measure.sh` collects them on the target.

## 2. Architecture and data flow
```
 ┌───────────────────────── Browser page (Chromium, one process tree) ─────────────────────────┐
 │ Perception            Body (sim)                        Audio                               │
 │ webcam→MediaPipe      three.js + URDF/STL               WebAudio synth (SFX, music, duck)   │
 │ FaceLandmarker(WASM)  IK + joint/vel/accel limits       speechSynthesis (voice)             │
 │ attn, face xy @10Hz   gestures, light, beam/spot        Web Speech STT (mic closed in TTS)  │
 └──────┬──────────────────▲──────────────────────────────────▲──────────────────────────────┬─┘
        │ percept.* (JSON)  │ body.aim/posture/gesture, light   │ say/sfx/music/listen          │ frame(JPEG)
        ▼ WebSocket         │                                   │                               │ only on request
 ┌──────────────────── Brain (Node, localhost) ───────────────────────────────────────────────┴─┐
 │ Engagement FSM → Character (behaviour, emotion→style table, turn queue) ↔ Memory (JSON)       │
 │        llm.js ──HTTPS──► Anthropic API: converse (Haiku) · look/plan/verify (Sonnet)           │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```
**Ownership.** Page = sensors + actuators + physical limits. Brain = every decision about *what the character does*. The cloud = open-ended
understanding only (what is in the frame, what the person wants). No decision that needs <100 ms goes to the cloud: "I heard you" blip/light/think-gesture fire
immediately on speech-final; the voice→light lip-sync pulse is a local reflex on TTS word boundaries.

**Protocol** (`docs/PROTOCOL.md`): one WebSocket, JSON, `id`-correlated completions (`body.done`, `say.done`, `frame`), so sequencing multi-modal beats
needs no shared clock. Intent-level commands only ("aim at image point", "gesture: nod"); never joint angles.

## 3. Key choices and trade-offs
| Choice | Why | Cost |
|---|---|---|
| Browser as body+senses, Node brain | Camera/mic/speaker/WebGL/WASM/TTS/STT for free, one install, same page doubles as the visualiser | Two processes, localhost WS; STT quality depends on browser |
| Own URDF loader + kinematic twin + damped numeric IK (no physics engine) | The URDF has no controllers; the challenge is character not dynamics; IK is ~5 ms and gives reachability + a posture prior | No torque/inertia/collision model (see §6) |
| Engagement local (MediaPipe, CPU) | Privacy (no video leaves), latency, works offline, ~20 Hz cap bounds CPU | Head-pose+eye-blendshape gaze is coarse (≈ ±15–20°) |
| `attn = G(head yaw,pitch)·G(eye gaze)`; ENTER 0.6 > EXIT 0.35; dwell 500 ms in / 700 ms out; 4 s grace (8 s mid-conversation); 20 s greet cooldown | Hysteresis + dwell prevent flapping; grace lets a person glance at a keyboard without being dropped; no double greetings | Constants tuned by reasoning, not yet by data |
| Cloud for vision/language (Claude): Haiku-class for routing+reply, Sonnet-class for vision | Open-vocabulary object understanding + grounding boxes without training; split keeps the chat turn fast | Network latency; frames leave the machine (see below) |
| **Data sent to cloud:** utterance text + short history + text memory notes (chat); a ≤640 px JPEG only when the person asks it to look or gives a goal (never continuous). Audio goes to the browser vendor's STT in Chrome. | Minimal, on-demand, user-initiated | Offline mode would need local STT/VLM |
| Memory = JSON records (label, colour, description, box, times, in-view flag), injected as *text* into the prompt | Inspectable, cheap, persistent across restarts, answers don't re-send images | No embeddings/forgetting; label+colour identity is crude |
| Fixed-camera world model: image point → ray → point on a plane 1.2 m away | The laptop camera does not move with the head, so aiming in *absolute* image coordinates avoids the "re-centre incrementally" feedback runaway | Explicit depth assumption (objects near the plane); parallax between lamp and camera is handled only because IK targets the 3-D point |
| Verification with the light spot **drawn into the frame** | The real camera cannot see a simulated light; compositing the sim's achieved spot makes the VLM check a true perception→action→perception loop | The "spot" is synthetic; on hardware it would be the real beam |

## 4. Model → action
Vision/plan outputs are JSON in a closed vocabulary (`aim | light | gesture | sfx | say | hold`, ≤ 8 steps). `validatePlan` clamps and drops
anything unknown (unit-tested, including `set_joint` and unknown gestures). Body-side checks: soft limits (URDF safety_controller), velocity cap 70 % of
URDF limit, accel cap, IK `reachable` flag fed back to the brain ("that's past what my neck can turn"). Closed loop: capture → plan → execute →
capture(+spot) → verify → ≤ 2 corrections from the model's *fresh* target estimate → honest failure line if it cannot be done.

## 5. Measurements (what exists today)
| Item | Result | Setup |
|---|---|---|
| Engagement logic | 8 unit scenarios pass (dwell, glance, hysteresis, grace, re-engage w/o greeting, leave, stalled camera) | synthetic 10 Hz sequences |
| IK accuracy / speed | 200 random image targets: max residual **0.2°**, mean solve **4.8 ms** (first call ≈ 0.2 s JIT), 0 % unreachable inside the frame | headless Edge, dev laptop (Windows) |
| Render | ≈ 20 fps with *software* WebGL (SwiftShader, no GPU) — the worst case for the target | same |
| Brain process | ≈ 48 MB RSS idle (Node + ws) | same |
| End-to-end flow | greeting → observe → goal → drift/disengage executed in a real browser with a fake camera and the **mock** LLM (`test/e2e.mjs`) | same |
| **Not yet measured** | face engagement precision/recall on real people; speech-final → first-voice latency with the cloud; CPU/RSS on the 4-core/8 GB Ubuntu laptop | run `scripts/measure.sh` during the demo; `/metrics` already records per-turn `llmMs`, `visionMs`, `planMs`, `verifyMs`, `firstVoiceMs`, and engagement events |

Latency design target (from the budget, to be confirmed): reflex feedback < 150 ms; first voice ≈ 1–1.5 s (Haiku, no thinking, short prompt);
vision turn 2–4 s hidden behind thinking-music + lean-in; goal ≈ 6–10 s (two vision calls + motion).

## 6. Known limitations / physical reasoning
* Simulation only: no gravity/torque/backlash/collision. On hardware, the 0.95–1.5 rad/s URDF limits and effort limits (3–12 N·m) would need trajectory
  smoothing already present here, plus gravity compensation on shoulder/elbow, and a hand-eye calibration (here the camera is fixed and assumed co-located).
* Depth is assumed (plane at 1.2 m); a real lamp would use a table-plane or depth estimate to place the spot.
* Light is a model (emissive + spot + beam), not photometric; head carries no real roll joint so "tilt" is yaw+pitch.
* STT/TTS depend on the browser (cloud STT in Chrome; Chromium-snap on Ubuntu may lack it → text box); no barge-in (mic is closed while Lumi speaks to avoid self-hearing).
* Memory identity is label+colour; two identical mugs merge. Objects not seen in the latest full look are flagged "not in view", not deleted.
* Single person, single browser tab; face with glasses/low light degrades gaze blendshapes (head pose still works).
* Vision outputs are model-estimated boxes; wrong boxes lead to wrong aim — mitigated by the verify step, not eliminated.
