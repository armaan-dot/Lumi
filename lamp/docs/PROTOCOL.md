# Protocol (brain ⇄ page)

One WebSocket (`/ws`), UTF-8 JSON, one message per frame, `type` discriminates. Commands that
need completion carry an `id`; the page echoes it in the completion message. The brain never
assumes a shared clock. Coordinates `x,y` are **normalised image coordinates** (0,0 top-left).

## Page → brain (sensing and completions)
| type | fields | rate |
|---|---|---|
| `hello` | – | on connect |
| `percept.face` | `present, attn(0..1), cx, cy, yaw, pitch, gazeH, gazeV, fps, inferMs` | ≈10 Hz |
| `percept.speech` | `text, final, conf` | per STT result |
| `ui.text` | `text` | typed fallback for speech |
| `body.state` | `joints{base,shoulder,elbow,neck,head}(rad), aim{x,y}, light` | 10 Hz |
| `body.done` | `id, aim{x,y}, err(rad), reachable` | when a `body.aim` settles |
| `say.started` / `say.done` | `id` | TTS lifecycle |
| `frame` | `id, jpeg(base64), w` | reply to `capture` |
| `perf` | `data{renderFps, faceHz, inferMs, sttError}` | 2 Hz |

## Brain → page (actions)
| type | fields | notes |
|---|---|---|
| `body.aim` | `id,x,y,dur,gain?,track?` | aim head + light at an image point. Body does IK/limits. `track` = fire-and-forget |
| `body.posture` | `name∈{sleep,rest,alert}, dur` | base posture prior for IK |
| `body.gesture` | `name∈{nod,shake,wiggle,perk,droop,tilt,think,lean_in,point}` | additive keyframe clips |
| `light` | `color(#hex), intensity, pattern∈{solid,pulse,breathe,flash}` | |
| `say` | `id,text,voice{rate,pitch}` | |
| `sfx` | `name∈{chirp_up,chirp_down,blip,boop,found,whoosh}` | |
| `music` | `name∈{hello,think,celebrate}, action∈{play,stop}` | `think` loops until stopped |
| `listen` | `on` | opens/closes the mic (closed while speaking) |
| `capture` | `id,width,reticle{x,y}?` | reticle = draw the light spot into the frame |
| `overlay`, `ui.*` | | visualisation only |

## Model → action boundary
The LLM emits **plans in a closed vocabulary** (`aim, light, gesture, sfx, say, hold`; ≤ 8 steps), never joint
angles. `server/actions.js::validatePlan` clamps ranges, drops unknown actions, caps text and steps. The body
re-validates physically (soft joint limits, velocity/accel limits, IK reachability → `reachable:false`).
