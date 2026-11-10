// The model -> body boundary.
//
// The language/vision model NEVER emits joint angles or raw hardware commands.
// It emits a short plan in a closed vocabulary of *intent-level* actions in
// image-space ("aim at (x,y)"), which this module validates and clamps. The
// body (web/body.js) then owns IK, joint limits, velocity/accel limits.
export const GESTURES = ['nod', 'shake', 'wiggle', 'perk', 'droop', 'tilt', 'think', 'lean_in', 'point'];
export const SFX = ['chirp_up', 'chirp_down', 'blip', 'found', 'boop', 'whoosh'];
export const PATTERNS = ['solid', 'pulse', 'breathe', 'flash'];
export const PALETTE = {
  warm: '#ffd9a0', amber: '#ffb347', white: '#fff6e0', cool: '#bfe3ff', cyan: '#7fe8ff',
  violet: '#b79cff', green: '#8dffb0', red: '#ff6a5a', pink: '#ff9ccf', dim: '#6b5a3c',
};
export const EMOTIONS = ['happy', 'curious', 'thinking', 'surprised', 'calm', 'sad'];
export const MAX_STEPS = 8;

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v)));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function colorOf(c) {
  if (!c) return PALETTE.warm;
  if (PALETTE[c]) return PALETTE[c];
  return /^#[0-9a-f]{6}$/i.test(c) ? c : PALETTE.warm;
}

/** Validate + sanitise an untrusted plan. Returns {steps, rejected:[reason]}. */
export function validatePlan(raw) {
  const steps = [];
  const rejected = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const s of list.slice(0, MAX_STEPS)) {
    if (!s || typeof s.action !== 'string') { rejected.push('missing action'); continue; }
    switch (s.action) {
      case 'aim':
        if (!isNum(s.x) || !isNum(s.y)) { rejected.push('aim needs numeric x,y'); break; }
        steps.push({ action: 'aim', x: clamp01(s.x), y: clamp01(s.y) });
        break;
      case 'light':
        steps.push({
          action: 'light', color: colorOf(s.color),
          intensity: isNum(s.intensity) ? clamp01(s.intensity) : 0.8,
          pattern: PATTERNS.includes(s.pattern) ? s.pattern : 'solid',
        });
        break;
      case 'gesture':
        if (!GESTURES.includes(s.name)) { rejected.push('unknown gesture ' + s.name); break; }
        steps.push({ action: 'gesture', name: s.name });
        break;
      case 'say':
        if (typeof s.text !== 'string' || !s.text.trim()) { rejected.push('empty say'); break; }
        steps.push({ action: 'say', text: s.text.trim().slice(0, 220) });
        break;
      case 'sfx':
        if (!SFX.includes(s.name)) { rejected.push('unknown sfx ' + s.name); break; }
        steps.push({ action: 'sfx', name: s.name });
        break;
      case 'hold':
        steps.push({ action: 'hold', ms: Math.min(3000, Math.max(100, isNum(s.ms) ? s.ms : 500)) });
        break;
      default:
        rejected.push('unknown action ' + s.action);
    }
  }
  if (list.length > MAX_STEPS) rejected.push(`plan truncated to ${MAX_STEPS} steps`);
  return { steps, rejected };
}

// ---- image-space <-> aim-frame geometry (shared by brain and body) ----
// Aim frame: yaw>0 = lamp's left, pitch>0 = up, 0,0 = camera optical axis.
// The laptop camera is treated as FIXED and co-located with the lamp (fixed
// extrinsics, no hand-eye calibration needed), so image coordinates map to
// absolute aim angles - which also avoids the classic feedback runaway of
// "incrementally re-centre the target" when the camera does not move with the head.
export const CAM = { hfov: (66 * Math.PI) / 180, aspect: 4 / 3 };
CAM.vfov = 2 * Math.atan(Math.tan(CAM.hfov / 2) / CAM.aspect);

export function imageToAim(x, y, cam = CAM) {
  return {
    yaw: -Math.atan((x - 0.5) * 2 * Math.tan(cam.hfov / 2)),
    pitch: -Math.atan((y - 0.5) * 2 * Math.tan(cam.vfov / 2)),
  };
}
export function aimToImage(yaw, pitch, cam = CAM) {
  return {
    x: 0.5 - Math.tan(yaw) / (2 * Math.tan(cam.hfov / 2)),
    y: 0.5 - Math.tan(pitch) / (2 * Math.tan(cam.vfov / 2)),
  };
}
