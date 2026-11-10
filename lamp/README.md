# Lumi — a live character around the 5-DOF lamp

One continuous interaction on a laptop: Lumi notices you looking at it, greets you
(motion + light + SFX + music + voice), talks with you, **remembers objects it saw
through the camera**, answers questions about them later, and carries out a spoken goal
about the live scene ("shine your light on the mug") with a look → act → look-again loop.

Technical note (architecture, protocol, measurements, limitations): [docs/NOTE.md](docs/NOTE.md).
Protocol reference: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Run on Ubuntu 24.04 (target)

```bash
sudo apt update && sudo apt install -y curl chromium-browser pulseaudio-utils espeak-ng   # espeak-ng = fallback TTS voice
# Node 20+ (Ubuntu 24.04 ships 18; use NodeSource or nvm):
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

git clone <this repo> && cd lamp
npm ci                                  # three, mediapipe (WASM), ws, @anthropic-ai/sdk — all served locally, no CDN
export ANTHROPIC_API_KEY=sk-ant-...     # without it the brain runs in clearly-labelled MOCK mode
npm start                               # brain + static server on http://127.0.0.1:8765
chromium --app=http://127.0.0.1:8765    # or Chrome; click "Wake Lumi" (grants camera + mic)
```

`systemd --user` unit: [scripts/lumi.service](scripts/lumi.service). The face model
(`web/models/face_landmarker.task`, 3.7 MB) and MediaPipe WASM are vendored in the repo, so after
install the *only* network use is the Anthropic API and Chrome's speech recognition.

### Browser notes
* **Speech-to-text** uses the Web Speech API. In Chrome it streams mic audio to Google; in Ubuntu's Chromium snap it
  is frequently unavailable. If STT is missing the HUD says so and the **text box** is a full substitute (same code path
  after the transcript). Offline STT (whisper.cpp / Vosk) is the intended replacement — see "Known limitations".
* **Voice** uses the system `speechSynthesis` voice (Chrome ships Google voices; Linux Chromium falls back to espeak-ng).

## Demo script (≈ 2 minutes)

1. Sit in front of the camera but look elsewhere → chip stays `AWARE` (it noticed you, lamp turns its head toward you, quietly).
2. Look at the lamp for ~½ s → `ENGAGED`: chirp, perk-up, light flash, music sting, greeting.
3. Look away for ~1 s → `DRIFTING` (dims, tilts head); stay away → `disengaged` (sigh sound, droop). Look back quickly → short "perk" without a second greeting.
4. Hold up an object: **"Lumi, look at this and remember it."** Thinking-music + lean-in; it names the object, boxes it in the scene, and stores it in the Memory panel.
5. Put the object down and chat; later: **"What colour was the thing I showed you?"** It answers from memory and glances at where the object was.
6. Put the object somewhere in view and say: **"Shine your light on the mug."** (use whatever object you showed.) Plan appears in the Plan panel; the light spot drawn in the sim lands on it; Lumi re-checks the camera (with the spot drawn in), corrects if needed, then celebrates.

No camera/mic handy? Open `http://127.0.0.1:8765/?sim=1` and use **A** (attend) / **L** (look away) / **N** (nobody) / **X** (real camera) and the text box.

## Layout

```
server/   brain (Node): engagement.js  character.js  llm.js  memory.js  actions.js  index.js
web/      body + senses (browser): body.js (URDF sim, IK, limits)  perception.js  audio.js  main.js
robot/    supplied URDF + STL (unmodified)
test/     run.js (unit)  e2e.mjs (headless browser, mock LLM)  poses.mjs  ikbench.mjs
scripts/  measure.sh  lumi.service
```

## Tests
`npm test` — engagement state machine, plan validation, geometry, memory (no browser needed).
`node test/e2e.mjs` — drives the real page in headless Edge/Chrome with a fake camera and the mock LLM (`LAMP_MOCK=1 npm start` first).

## Config
| env | default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | cloud mode; unset ⇒ MOCK |
| `LAMP_CHAT_MODEL` | `claude-haiku-5-5` | intent routing + spoken reply |
| `LAMP_VISION_MODEL` | `claude-sonnet-5-5` | look / plan / verify |
| `PORT`, `HOST` | 8765, 127.0.0.1 | |
