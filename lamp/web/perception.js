// Perception: webcam -> MediaPipe FaceLandmarker (WASM, CPU, runs locally in the
// browser) -> an "attention" score. Video frames never leave the machine for
// engagement detection; a JPEG is only sent to the cloud on explicit request
// (observe / goal), see capture().
import { FaceLandmarker, FilesetResolver } from '/vendor/mediapipe/vision_bundle.mjs';

const gauss = (x, s) => Math.exp(-((x / s) ** 2));
const deg = (r) => (r * 180) / Math.PI;

export class Perception {
  constructor(video, emit) {
    this.video = video; this.emit = emit; this.sim = null;
    this.fps = 0; this.inferMs = 0; this.lastSend = 0; this.running = false;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30 }, audio: false });
    this.video.srcObject = stream; await this.video.play();
    const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'VIDEO', numFaces: 2, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    });
    this.running = true; this._loop();
  }

  /** Attention = head roughly facing the camera AND eyes roughly on it. Symmetric in sign. */
  static score(res) {
    if (!res.faceLandmarks?.length) return { present: false, attn: 0 };
    // pick the largest face (closest person)
    let best = 0, area = -1;
    res.faceLandmarks.forEach((lm, i) => {
      const xs = lm.map((p) => p.x), ys = lm.map((p) => p.y);
      const a = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
      if (a > area) { area = a; best = i; }
    });
    const lm = res.faceLandmarks[best];
    const m = res.facialTransformationMatrixes?.[best]?.data; // column-major 4x4
    let yaw = 0, pitch = 0;
    if (m) { yaw = deg(Math.atan2(m[8], m[10])); pitch = deg(Math.asin(Math.max(-1, Math.min(1, -m[9])))); }
    const bs = {}; (res.faceBlendshapes?.[best]?.categories || []).forEach((c) => { bs[c.categoryName] = c.score; });
    const h = (((bs.eyeLookOutLeft || 0) - (bs.eyeLookInLeft || 0)) + ((bs.eyeLookInRight || 0) - (bs.eyeLookOutRight || 0))) / 2;
    const v = (((bs.eyeLookUpLeft || 0) + (bs.eyeLookUpRight || 0)) - ((bs.eyeLookDownLeft || 0) + (bs.eyeLookDownRight || 0))) / 2;
    const head = gauss(yaw, 24) * gauss(pitch - 8, 24); // people look at the screen slightly below the camera
    const eyes = gauss(h, 0.5) * gauss(v, 0.6);
    const nose = lm[1];
    return { present: true, attn: head * eyes, yaw, pitch, gazeH: h, gazeV: v, cx: nose.x, cy: nose.y, area, faces: res.faceLandmarks.length };
  }

  _loop() {
    const tick = () => {
      if (!this.running) return;
      const now = performance.now();
      let s;
      if (this.sim) s = { present: this.sim.present, attn: this.sim.attn, cx: this.sim.cx, cy: this.sim.cy, yaw: 0, pitch: 0 };
      else if (this.video.readyState >= 2 && this.video.currentTime !== this._lastT) {
        this._lastT = this.video.currentTime;
        const t0 = performance.now();
        s = Perception.score(this.landmarker.detectForVideo(this.video, now));
        this.inferMs = this.inferMs * 0.9 + (performance.now() - t0) * 0.1;
      }
      if (s) {
        this.fps = this.fps * 0.9 + (1000 / Math.max(1, now - (this._prev || now - 66))) * 0.1; this._prev = now;
        if (now - this.lastSend > 90) { // ~10 Hz to the brain is plenty for engagement
          this.lastSend = now;
          this.emit({ type: 'percept.face', t: Date.now(), fps: +this.fps.toFixed(1), inferMs: +this.inferMs.toFixed(1), ...s });
        }
      }
      setTimeout(tick, 1000 / 20); // cap ~20 Hz: bounds CPU on a 4-core, no-GPU laptop
    };
    tick();
  }

  /** Grab a JPEG (optionally with the lamp's light spot drawn in) - the ONLY image data that leaves the browser. */
  capture(width = 640, reticle = null) {
    const v = this.video; const w = width; const h = Math.round(width * (v.videoHeight || 480) / (v.videoWidth || 640));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (v.videoWidth) g.drawImage(v, 0, 0, w, h); else { g.fillStyle = '#334'; g.fillRect(0, 0, w, h); }
    if (reticle) {
      const x = reticle.x * w, y = reticle.y * h;
      g.strokeStyle = 'rgba(255,220,60,0.95)'; g.fillStyle = 'rgba(255,220,60,0.28)'; g.lineWidth = 4;
      g.beginPath(); g.arc(x, y, w * 0.05, 0, 7); g.fill(); g.stroke();
      g.lineWidth = 2; g.beginPath(); g.moveTo(x - w * 0.07, y); g.lineTo(x + w * 0.07, y); g.moveTo(x, y - w * 0.07); g.lineTo(x, y + w * 0.07); g.stroke();
    }
    return c.toDataURL('image/jpeg', 0.7).split(',')[1];
  }
}
