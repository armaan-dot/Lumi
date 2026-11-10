// The simulated lamp body: URDF -> three.js scene, kinematics, IK, motion
// control with joint/velocity limits, gestures, and light. The brain only sends
// intent-level commands (aim at image point, posture, gesture, light); this
// module owns everything physical:
//   - joint position limits (soft limits from the URDF safety_controller)
//   - velocity limit (70% of URDF limit) and acceleration limit
//   - IK with a posture prior, reachability report
//   - the camera/world model that turns image coordinates into 3-D aim points
import * as THREE from 'three';
import { STLLoader } from 'three/stl';
import { CAM } from '/shared/actions.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // URDF is Z-up

const JOINTS = ['base_yaw_joint', 'shoulder_pitch_joint', 'elbow_pitch_joint', 'neck_yaw_joint', 'head_pitch_joint'];
const SHORT = { base_yaw_joint: 'base', shoulder_pitch_joint: 'shoulder', elbow_pitch_joint: 'elbow', neck_yaw_joint: 'neck', head_pitch_joint: 'head' };

// World model for image -> 3-D. The laptop camera is a fixed observer looking
// along -X of the lamp base frame (the lamp faces -X at zero pose), at height CAM_Z.
// Image points are lifted onto a vertical plane SCENE_D metres in front of it:
// an explicit *depth assumption* (objects on/near the desk plane at ~arm's reach).
export const WORLD = { SCENE_D: 1.2, CAM_Z: 0.30 };
WORLD.W = 2 * WORLD.SCENE_D * Math.tan(CAM.hfov / 2);
WORLD.H = WORLD.W / CAM.aspect;
export function imageToWorld(x, y) {
  return new THREE.Vector3(-WORLD.SCENE_D, (x - 0.5) * WORLD.W, WORLD.CAM_Z - (y - 0.5) * WORLD.H);
}
export function worldToImage(p) {
  return { x: p.y / WORLD.W + 0.5, y: 0.5 - (p.z - WORLD.CAM_Z) / WORLD.H };
}

const POSTURES = { // [shoulder, elbow] priors; IK solves yaw/head to satisfy the aim
  sleep: { s: 0.80, e: -1.65, h: 0.55 },
  rest: { s: 0.40, e: -1.05, h: 0.0 },
  alert: { s: 0.20, e: -0.70, h: 0.0 },
};
// Gestures = additive joint offset keyframes [t, {joint: delta}] (seconds, radians).
const G = (...k) => k;
const GESTURES = {
  nod: G([0, {}], [0.15, { head: 0.28 }], [0.35, { head: -0.1 }], [0.55, { head: 0.26 }], [0.8, {}]),
  shake: G([0, {}], [0.15, { neck: 0.4 }], [0.4, { neck: -0.4 }], [0.65, { neck: 0.3 }], [0.9, {}]),
  wiggle: G([0, {}], [0.12, { base: 0.22, neck: -0.25, head: -0.12 }], [0.36, { base: -0.22, neck: 0.25, head: 0.12 }], [0.6, { base: 0.2, neck: -0.2, head: -0.1 }], [0.84, { base: -0.15, neck: 0.15 }], [1.1, {}]),
  perk: G([0, {}], [0.25, { shoulder: -0.3, elbow: 0.35, head: -0.15 }], [1.1, { shoulder: -0.3, elbow: 0.35, head: -0.15 }], [1.6, {}]),
  droop: G([0, {}], [0.7, { shoulder: 0.35, elbow: -0.45, head: 0.3 }], [1.9, { shoulder: 0.35, elbow: -0.45, head: 0.3 }], [2.6, {}]),
  tilt: G([0, {}], [0.3, { neck: 0.35, head: 0.12 }], [1.4, { neck: 0.35, head: 0.12 }], [1.9, {}]),
  think: G([0, {}], [0.35, { head: -0.18, neck: 0.15 }], [1.0, { head: -0.18, neck: -0.15 }], [1.7, { head: -0.18, neck: 0.1 }], [2.2, {}]),
  lean_in: G([0, {}], [0.4, { shoulder: -0.32, elbow: 0.4, head: -0.1 }], [2.2, { shoulder: -0.32, elbow: 0.4, head: -0.1 }], [2.8, {}]),
  point: G([0, {}], [0.25, { shoulder: -0.18, elbow: 0.15, head: -0.12 }], [1.0, { shoulder: -0.18, elbow: 0.15, head: -0.12 }], [1.4, {}]),
};

const ease = (u) => u * u * (3 - 2 * u);

// ---------------------------------------------------------------- URDF
function vec(str, d = [0, 0, 0]) { return str ? str.trim().split(/\s+/).map(Number) : d; }
function originOf(el) {
  const o = el?.querySelector(':scope > origin');
  const xyz = vec(o?.getAttribute('xyz')); const rpy = vec(o?.getAttribute('rpy'));
  return { pos: new THREE.Vector3(...xyz), rot: new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX') };
}

async function buildRobot(urdfUrl, { materials = true } = {}) {
  const xml = new DOMParser().parseFromString(await (await fetch(urdfUrl)).text(), 'text/xml');
  const base = urdfUrl.slice(0, urdfUrl.lastIndexOf('/') + 1);
  const mats = {};
  xml.querySelectorAll('robot > material').forEach((m) => {
    const c = vec(m.querySelector('color').getAttribute('rgba'), [1, 1, 1, 1]);
    mats[m.getAttribute('name')] = new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), roughness: 0.45, metalness: m.getAttribute('name').includes('chrome') ? 0.8 : 0.05, transparent: c[3] < 1, opacity: c[3] });
  });
  const stl = new STLLoader();
  const links = {}; const joints = {};
  for (const l of xml.querySelectorAll('robot > link')) {
    const g = new THREE.Group(); g.name = l.getAttribute('name'); links[g.name] = g;
    if (!materials) continue;
    for (const v of l.querySelectorAll(':scope > visual')) {
      const o = originOf(v); const geom = v.querySelector('geometry');
      const matName = v.querySelector('material')?.getAttribute('name');
      let mesh;
      const cyl = geom.querySelector('cylinder'); const sph = geom.querySelector('sphere'); const msh = geom.querySelector('mesh');
      if (cyl) { const gg = new THREE.CylinderGeometry(+cyl.getAttribute('radius'), +cyl.getAttribute('radius'), +cyl.getAttribute('length'), 32); gg.rotateX(Math.PI / 2); mesh = new THREE.Mesh(gg); }
      else if (sph) mesh = new THREE.Mesh(new THREE.SphereGeometry(+sph.getAttribute('radius'), 24, 16));
      else if (msh) { mesh = new THREE.Mesh(new THREE.BufferGeometry()); stl.loadAsync(base + msh.getAttribute('filename')).then((gg) => { mesh.geometry = gg; }); }
      if (!mesh) continue;
      mesh.material = mats[matName] || new THREE.MeshStandardMaterial({ color: 0xcccccc });
      if (g.name === 'light_emitter_link') mesh.visible = false; // drawn by the light model instead
      mesh.position.copy(o.pos); mesh.rotation.copy(o.rot);
      g.add(mesh);
    }
  }
  for (const j of xml.querySelectorAll('robot > joint')) {
    const name = j.getAttribute('name'); const parent = links[j.querySelector('parent').getAttribute('link')];
    const child = links[j.querySelector('child').getAttribute('link')];
    const o = originOf(j);
    const frame = new THREE.Group(); frame.position.copy(o.pos); frame.rotation.copy(o.rot);
    const pivot = new THREE.Group();
    frame.add(pivot); pivot.add(child); parent.add(frame);
    const lim = j.querySelector('limit'); const soft = j.querySelector('safety_controller');
    joints[name] = {
      name, type: j.getAttribute('type'), pivot,
      axis: new THREE.Vector3(...vec(j.querySelector('axis')?.getAttribute('xyz'), [0, 0, 1])).normalize(),
      lo: soft ? +soft.getAttribute('soft_lower_limit') : lim ? +lim.getAttribute('lower') : 0,
      hi: soft ? +soft.getAttribute('soft_upper_limit') : lim ? +lim.getAttribute('upper') : 0,
      vmax: lim ? +lim.getAttribute('velocity') : 1, q: 0,
    };
  }
  const root = links['base_link'];
  return { root, links, joints, setQ(name, q) { const j = joints[name]; j.q = q; j.pivot.quaternion.setFromAxisAngle(j.axis, q); } };
}

// ---------------------------------------------------------------- Body
export class Body {
  static async create(canvas, videoEl) {
    const b = new Body(canvas, videoEl);
    await b._init();
    return b;
  }
  constructor(canvas, videoEl) { this.canvas = canvas; this.video = videoEl; this.onEvent = () => {}; }

  async _init() {
    const url = '/robot/dummy_lamp_5dof.urdf';
    this.robot = await buildRobot(url);
    this.twin = await buildRobot(url, { materials: false }); // kinematic twin for IK, never rendered
    const R = this.robot;
    R.root.updateMatrixWorld(true);

    // scene
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'low-power' });
    r.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161c);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 20);
    this.camera.position.set(1.15, -0.95, 0.85);
    this.target = new THREE.Vector3(-0.35, 0.05, 0.3);
    this.camera.lookAt(this.target);
    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x30303a, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.0); key.position.set(1.5, -1, 2); this.scene.add(key);
    const desk = new THREE.Mesh(new THREE.CircleGeometry(2.2, 64), new THREE.MeshStandardMaterial({ color: 0x242831, roughness: 0.9 }));
    desk.position.z = -0.002; this.scene.add(desk);
    this.scene.add(R.root);

    // camera-feed "window" at the scene plane: video texture + overlay canvas
    this.overlay = document.createElement('canvas'); this.overlay.width = 640; this.overlay.height = 480;
    this.overlayTex = new THREE.CanvasTexture(this.overlay);
    const tex = this.video ? new THREE.VideoTexture(this.video) : null;
    if (tex) tex.colorSpace = THREE.SRGBColorSpace;
    const mk = (map, opacity) => new THREE.Mesh(new THREE.PlaneGeometry(WORLD.W, WORLD.H), new THREE.MeshBasicMaterial({ map, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
    this.feed = mk(tex, 0.92);
    if (!tex) this.feed.material.color.set(0x20242c);
    this.feed.material.color.multiplyScalar(0.9);
    // plane basis: local X -> world +Y (image right), local Y -> world +Z (up), local Z (normal) -> +X (toward viewer behind the lamp)
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
    const place = (m, dx = 0) => { m.position.set(-WORLD.SCENE_D + dx, 0, WORLD.CAM_Z); m.quaternion.setFromRotationMatrix(basis); };
    place(this.feed); this.scene.add(this.feed);
    this.overlayPlane = mk(this.overlayTex, 1); place(this.overlayPlane, 0.003); this.scene.add(this.overlayPlane);

    // light model: emitter glow, spotlight, beam cone, spot on the feed plane
    this.emitter = R.links['light_emitter_link'];
    this.spot = new THREE.SpotLight(0xffe0a0, 0, 4, 0.5, 0.6, 1.5);
    this.emitter.add(this.spot); const tgt = new THREE.Object3D(); tgt.position.set(1, 0, 0); this.emitter.add(tgt); this.spot.target = tgt;
    this.glow = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true }));
    this.emitter.add(this.glow);
    const coneGeo = new THREE.ConeGeometry(0.12, 1, 24, 1, true); coneGeo.translate(0, -0.5, 0); coneGeo.rotateX(-Math.PI / 2); // apex at origin, opens toward +Z
    this.cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.scene.add(this.cone);
    this.spotDot = new THREE.Mesh(new THREE.CircleGeometry(0.11, 32), new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.spotDot.quaternion.setFromRotationMatrix(basis); this.scene.add(this.spotDot);

    // control state
    this.q = {}; this.v = {}; this.base = {}; this.goal = {};
    for (const n of JOINTS) { this.q[SHORT[n]] = 0; this.v[SHORT[n]] = 0; }
    this.post = { name: 'sleep', ...POSTURES.sleep };
    this.aimTarget = null;   // {x,y} image coords or null
    this.gain = 1;
    this.gestures = [];      // active {kf, t0, scale}
    this.lightState = { color: new THREE.Color(0x6b5a3c), target: new THREE.Color(0x6b5a3c), intensity: 0.1, pattern: 'breathe', t0: 0, flashUntil: 0 };
    this.pulse = 0;
    this.pendingDone = [];
    this.t = 0;
    // start from the sleep posture instantly
    this._solve();
    for (const k in this.goal) this.q[k] = this.goal[k];
    this._apply(this.robot, this.q);

    this._orbit();
    addEventListener('resize', () => this._resize()); this._resize();
    this.last = performance.now();
    this.fps = 0;
    this.renderer.setAnimationLoop((now) => this._frame(now));
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  _orbit() { // minimal orbit controls (drag = rotate, wheel = zoom); Z-up
    const c = this.canvas; let drag = null;
    const sph = () => { const d = this.camera.position.clone().sub(this.target); return { r: d.length(), th: Math.atan2(d.y, d.x), ph: Math.acos(d.z / d.length()) }; };
    const set = (s) => { this.camera.position.set(this.target.x + s.r * Math.sin(s.ph) * Math.cos(s.th), this.target.y + s.r * Math.sin(s.ph) * Math.sin(s.th), this.target.z + s.r * Math.cos(s.ph)); this.camera.lookAt(this.target); };
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, s: sph() }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('pointermove', (e) => { if (!drag) return; const s = { ...drag.s }; s.th -= (e.clientX - drag.x) * 0.006; s.ph = Math.min(1.5, Math.max(0.2, s.ph - (e.clientY - drag.y) * 0.006)); set(s); });
    c.addEventListener('wheel', (e) => { e.preventDefault(); const s = sph(); s.r = Math.min(5, Math.max(0.5, s.r * (1 + e.deltaY * 0.001))); set(s); }, { passive: false });
  }

  // ------------------------------------------------------------ kinematics
  _apply(robot, q) { for (const n of JOINTS) robot.setQ(n, q[SHORT[n]]); robot.root.updateMatrixWorld(true); }
  _lim(k) { const j = this.robot.joints[JOINTS.find((n) => SHORT[n] === k)]; return j; }
  _headRay(q) { // twin FK: emitter origin + forward (+X of head) in base frame
    this._apply(this.twin, q);
    const e = this.twin.links['light_emitter_link'];
    const p = new THREE.Vector3().setFromMatrixPosition(e.matrixWorld);
    const f = new THREE.Vector3(1, 0, 0).transformDirection(e.matrixWorld);
    return { p, f };
  }
  /** IK: find joint config whose head axis points from the emitter at world point P. */
  _ik(P, prior, seed) {
    const keys = Object.keys(this.q);
    const q = { ...seed };
    const clampQ = (k, v) => { const j = this._lim(k); return Math.min(j.hi, Math.max(j.lo, v)); };
    const cost = (qq) => {
      const { p, f } = this._headRay(qq);
      const d = P.clone().sub(p).normalize();
      const err = Math.acos(Math.min(1, Math.max(-1, f.dot(d))));
      return { c: err * err * 40 + 0.5 * (qq.shoulder - prior.s) ** 2 + 0.5 * (qq.elbow - prior.e) ** 2 + 0.15 * (qq.head - prior.h) ** 2 + 0.2 * (qq.base - qq.neck) ** 2, err };
    };
    let cur = cost(q); let step = 0.25;
    for (let it = 0; it < 90 && step > 1e-4; it++) {
      const g = {};
      for (const k of keys) { const q2 = { ...q, [k]: clampQ(k, q[k] + 1e-3) }; g[k] = (cost(q2).c - cur.c) / 1e-3; }
      const gn = Math.hypot(...Object.values(g)) || 1;
      let improved = false;
      for (let tries = 0; tries < 6; tries++) {
        const q2 = {}; for (const k of keys) q2[k] = clampQ(k, q[k] - (g[k] / gn) * step);
        const c2 = cost(q2);
        if (c2.c < cur.c) { Object.assign(q, q2); cur = c2; improved = true; break; }
        step *= 0.5;
      }
      if (!improved) break;
      step = Math.min(0.3, step * 1.5);
    }
    return { q, err: cur.err };
  }
  _solve() {
    const prior = this.post;
    if (this.aimTarget) {
      const k = this.gain;
      const x = 0.5 + (this.aimTarget.x - 0.5) * k; const y = 0.5 + (this.aimTarget.y - 0.5) * k;
      this.aimPoint = imageToWorld(x, y);
      const seed = { ...this.goal && Object.keys(this.goal).length ? this.goal : this.q };
      const r = this._ik(this.aimPoint, prior, seed);
      this.goal = r.q; this.aimErr = r.err;
    } else {
      this.aimPoint = null;
      this.goal = { base: 0, shoulder: prior.s, elbow: prior.e, neck: 0, head: prior.h }; this.aimErr = 0;
    }
  }

  // --------------------------------------------------------------- commands
  handle(m) {
    switch (m.type) {
      case 'body.aim':
        this.aimTarget = { x: m.x, y: m.y }; this.gain = m.gain ?? 1; this._solve();
        if (m.track) { this.onEvent({ type: 'body.done', id: m.id, aim: this.achievedImage(), err: this.aimErr, reachable: this.aimErr < 0.12 }); break; }
        this.pendingDone.push({ id: m.id, kind: 'aim', min: (m.dur || 0.8) * 1000, t0: performance.now() });
        break;
      case 'body.posture':
        this.post = { name: m.name, ...(POSTURES[m.name] || POSTURES.rest) };
        if (m.name === 'sleep') this.aimTarget = null;
        this._solve();
        break;
      case 'body.gesture':
        if (GESTURES[m.name]) this.gestures.push({ kf: GESTURES[m.name], t0: this.t });
        break;
      case 'body.release': this.aimTarget = null; this._solve(); break;
      case 'light': this.setLight(m); break;
    }
  }
  setLight({ color, intensity = 0.8, pattern = 'solid' }) {
    const L = this.lightState;
    L.target.set(color || '#ffd9a0'); L.base = intensity; L.pattern = pattern; L.t0 = this.t;
    if (pattern === 'flash') { L.flashUntil = this.t + 0.5; L.pattern = 'solid'; L.base = Math.max(0.45, intensity * 0.7); L.peak = intensity; }
  }
  pulseLight(a = 0.35) { this.pulse = Math.min(1, this.pulse + a); } // reflex: voice -> light

  achievedImage() { // where the head's axis actually hits the scene plane (image coords)
    const { p, f } = this._headRay(this.q);
    if (Math.abs(f.x) < 1e-3) return null;
    const s = (-WORLD.SCENE_D - p.x) / f.x;
    if (s < 0) return null;
    return worldToImage(p.clone().add(f.multiplyScalar(s)));
  }

  // ------------------------------------------------------------ simulation
  _gestureOffsets() {
    const off = { base: 0, shoulder: 0, elbow: 0, neck: 0, head: 0 };
    this.gestures = this.gestures.filter((g) => this.t - g.t0 < g.kf[g.kf.length - 1][0]);
    for (const g of this.gestures) {
      const t = this.t - g.t0; const kf = g.kf;
      let i = 0; while (i < kf.length - 2 && t > kf[i + 1][0]) i++;
      const [t0, a] = kf[i]; const [t1, b] = kf[i + 1];
      const u = ease(Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1))));
      for (const k in off) off[k] += (a[k] || 0) * (1 - u) + (b[k] || 0) * u;
    }
    return off;
  }
  _step(dt) {
    this.t += dt;
    const off = this._gestureOffsets();
    const breath = { shoulder: 0.012 * Math.sin(this.t * 1.6), head: 0.02 * Math.sin(this.t * 1.1 + 1), neck: 0.03 * Math.sin(this.t * 0.5) };
    const sleepy = this.post.name === 'sleep' ? 0.4 : 1;
    for (const k of Object.keys(this.q)) {
      const j = this._lim(k);
      let tgt = (this.goal[k] ?? 0) + off[k] + (breath[k] || 0) * sleepy;
      tgt = Math.min(j.hi, Math.max(j.lo, tgt));
      const vmax = j.vmax * 0.7; const amax = vmax * 5;
      const vdes = Math.max(-vmax, Math.min(vmax, 7 * (tgt - this.q[k])));
      const dv = Math.max(-amax * dt, Math.min(amax * dt, vdes - this.v[k]));
      this.v[k] += dv; this.q[k] += this.v[k] * dt;
      if (this.q[k] > j.hi || this.q[k] < j.lo) { this.q[k] = Math.min(j.hi, Math.max(j.lo, this.q[k])); this.v[k] = 0; }
    }
    this._apply(this.robot, this.q);
    // aim completion: settled (small velocity+error) after the minimum duration
    const settled = Object.keys(this.q).every((k) => Math.abs(this.v[k]) < 0.02 && Math.abs((this.goal[k] ?? 0) - this.q[k]) < 0.04);
    this.pendingDone = this.pendingDone.filter((p) => {
      const waited = performance.now() - p.t0;
      if (waited > p.min && settled || waited > 6000) {
        this.onEvent({ type: 'body.done', id: p.id, aim: this.achievedImage(), err: this.aimErr, reachable: this.aimErr < 0.12 });
        return false;
      }
      return true;
    });
    this._updateLight(dt);
  }
  _updateLight(dt) {
    const L = this.lightState; const t = this.t - L.t0;
    L.color.lerp(L.target, Math.min(1, dt * 8));
    let i = L.base ?? 0.5;
    if (L.pattern === 'pulse') i *= 0.55 + 0.45 * Math.sin(t * 2 * Math.PI / 0.9);
    else if (L.pattern === 'breathe') i *= 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.6 - 1.5));
    if (this.t < L.flashUntil) i = Math.max(i, (L.peak ?? 1) * (0.4 + 0.6 * (L.flashUntil - this.t) / 0.5));
    this.pulse *= Math.exp(-dt * 6);
    i = Math.min(1, i + this.pulse * 0.4);
    L.out = i;
    this.glow.material.color.copy(L.color).multiplyScalar(0.4 + 0.6 * i); this.glow.material.opacity = 0.25 + 0.75 * i; this.glow.scale.setScalar(0.8 + i * 0.9);
    this.spot.color.copy(L.color); this.spot.intensity = i * 6;
    // beam from the emitter to the achieved spot on the feed plane
    const e = new THREE.Vector3().setFromMatrixPosition(this.emitter.matrixWorld);
    const f = new THREE.Vector3(1, 0, 0).transformDirection(this.emitter.matrixWorld);
    const s = f.x < -1e-3 ? (-WORLD.SCENE_D - e.x) / f.x : 0;
    if (s > 0) {
      const hit = e.clone().addScaledVector(f, s);
      this.cone.position.copy(e); this.cone.lookAt(hit); this.cone.scale.set(1, 1, s);
      this.cone.material.color.copy(L.color); this.cone.material.opacity = 0.05 + 0.2 * i;
      this.spotDot.position.set(hit.x + 0.006, hit.y, hit.z); this.spotDot.material.color.copy(L.color); this.spotDot.material.opacity = 0.15 + 0.7 * i;
      this.spotDot.visible = this.cone.visible = true;
    } else this.spotDot.visible = this.cone.visible = false;
  }
  _frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this._step(dt);
    this.renderer.render(this.scene, this.camera);
  }

  /** Debug/telemetry: joint state for the HUD and protocol. */
  state() { return { joints: Object.fromEntries(Object.entries(this.q).map(([k, v]) => [k, +v.toFixed(3)])), aim: this.achievedImage(), light: +(this.lightState.out ?? 0).toFixed(2) }; }

  /** Draw boxes/target on the overlay plane (scene memory + plan visualisation). */
  drawOverlay(boxes = [], mark = null) {
    const c = this.overlay.getContext('2d'); c.clearRect(0, 0, 640, 480);
    c.lineWidth = 3; c.font = '600 20px system-ui'; c.textBaseline = 'top';
    for (const b of boxes) {
      if (!b.box) continue; const [x, y, w, h] = b.box;
      c.strokeStyle = '#ffd24a'; c.strokeRect(x * 640, y * 480, w * 640, h * 480);
      c.fillStyle = 'rgba(0,0,0,.55)'; const tw = c.measureText(b.label).width + 10; c.fillRect(x * 640, y * 480 - 26, tw, 26);
      c.fillStyle = '#ffd24a'; c.fillText(b.label, x * 640 + 5, y * 480 - 24);
    }
    this.overlayTex.needsUpdate = true;
    clearTimeout(this._ovT); this._ovT = setTimeout(() => { c.clearRect(0, 0, 640, 480); this.overlayTex.needsUpdate = true; }, 12000);
  }
}
