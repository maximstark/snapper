// Snapper demo game (MIT): a 320x180 platformer-toy and the reference Snapper integration.
// It runs identically with no SDK; every snapper call is guarded.
// Faults on keydown: E console.error, X exception in the next rAF, L 300 ms stall, T assert, G event.

export const VIEW_W = 320, VIEW_H = 180;
const STEP_MS = 1000 / 60, MAX_STEPS_PER_FRAME = 5;

const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");
const sn = window.snapper;                               // may be undefined
const tick = window.snapper?.tick ?? (() => {});         // bound once, allocation-free

// ---- input: 5 actions -> one mask bit each. keymap = first code of each row. ----
const LEFT = 1, RIGHT = 2, UP = 4, DOWN = 8, JUMP = 16;
const CODES = [["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"], ["KeyW", "ArrowUp"], ["KeyS", "ArrowDown"], ["Space"]];
const KEYMAP = CODES.map(row => row[0]);
const keyHeld = {};                                      // live keyboard, by KeyboardEvent.code
let padMask = 0;                                         // live gamepad, refreshed once per rAF

function codeBit(code) {
  for (let i = 0; i < CODES.length; i++) if (CODES[i].includes(code)) return 1 << i;
  return 0;
}
function liveMask() {                                    // no allocation
  let m = padMask;
  for (let i = 0; i < CODES.length; i++) {
    const row = CODES[i];
    for (let j = 0; j < row.length; j++) if (keyHeld[row[j]]) { m |= 1 << i; break; }
  }
  return m;
}
function maskOfCodes(codes) {                            // only used by the stepper
  let m = 0;
  for (const c of codes || []) m |= codeBit(c);
  return m;
}
function pollPad() {
  padMask = 0;
  const pads = navigator.getGamepads ? navigator.getGamepads() : null;
  if (!pads) return;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p || !p.connected || p.mapping !== "standard") continue;
    const b = p.buttons, ax = p.axes;
    if ((b[14] && b[14].pressed) || ax[0] < -0.5) padMask |= LEFT;
    if ((b[15] && b[15].pressed) || ax[0] > 0.5) padMask |= RIGHT;
    if ((b[12] && b[12].pressed) || ax[1] < -0.5) padMask |= UP;
    if ((b[13] && b[13].pressed) || ax[1] > 0.5) padMask |= DOWN;
    if (b[0] && b[0].pressed) padMask |= JUMP;
    return;
  }
}

// ---- seeded RNG (mulberry32); its state is part of the game state ----
const DEFAULT_SEED = Number(new URLSearchParams(location.search).get("seed")) || 1234;
let seed = DEFAULT_SEED, rng = seed >>> 0;
function rand() {
  rng = (rng + 0x6D2B79F5) >>> 0;
  let t = rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---- world ----
const PLATFORMS = [{ x: 0, y: 156, w: 320 }, { x: 60, y: 120, w: 70 }, { x: 190, y: 90, w: 80 }];
const BOX = 12, GRAVITY = 0.35, JUMP_V = -6, SPEED = 2, MAX_FALL = 8;
const P = { x: 24, y: 40, vx: 0, vy: 0, grounded: false };
const MAXP = 128;
const px = new Float32Array(MAXP), py = new Float32Array(MAXP), pvx = new Float32Array(MAXP), pvy = new Float32Array(MAXP), plife = new Int32Array(MAXP);
let pcount = 0;
let frame = -1;                                          // index of the last simulated step; the number passed to tick

function resetWorld(s) {
  seed = s === undefined || s === null ? DEFAULT_SEED : Number(s) || 0;
  rng = seed >>> 0;
  Object.assign(P, { x: 24, y: 40, vx: 0, vy: 0, grounded: false });
  pcount = 0;
  frame = -1;
}

function spawnDust() {
  for (let i = 0; i < 8 && pcount < MAXP; i++, pcount++) {
    px[pcount] = P.x + BOX / 2; py[pcount] = P.y + BOX;
    pvx[pcount] = (rand() - 0.5) * 3; pvy[pcount] = -rand() * 2.5;
    plife[pcount] = 20 + Math.floor(rand() * 20);
  }
}

function update(mask) {                                  // one fixed step; `mask` is the only input
  frame++;
  tick(frame, mask);
  const wasGrounded = P.grounded;
  P.vx = ((mask & RIGHT) ? SPEED : 0) - ((mask & LEFT) ? SPEED : 0);
  if ((mask & JUMP) && wasGrounded) { P.vy = JUMP_V; P.grounded = false; }
  P.vy += (mask & UP) && P.vy > 0 ? GRAVITY * 0.4 : GRAVITY;   // UP glides
  if (mask & DOWN) P.vy += 0.25;
  if (P.vy > MAX_FALL) P.vy = MAX_FALL;
  P.x = Math.min(VIEW_W - BOX, Math.max(0, P.x + P.vx));
  const prevBottom = P.y + BOX;
  P.y += P.vy;
  P.grounded = false;
  for (const pl of PLATFORMS) {
    if (P.vy >= 0 && prevBottom <= pl.y + 0.001 && P.y + BOX >= pl.y && P.x + BOX > pl.x && P.x < pl.x + pl.w) {
      const impact = P.vy;
      P.y = pl.y - BOX; P.vy = 0; P.grounded = true;
      if (!wasGrounded && impact > 1.5) spawnDust();
      break;
    }
  }
  for (let i = 0; i < pcount;) {                         // update particles, swap-remove the dead
    px[i] += pvx[i]; py[i] += pvy[i]; pvy[i] += 0.12;
    if (--plife[i] <= 0) {
      const l = --pcount;
      px[i] = px[l]; py[i] = py[l]; pvx[i] = pvx[l]; pvy[i] = pvy[l]; plife[i] = plife[l];
    } else i++;
  }
}

function render() {
  ctx.fillStyle = "#1b2238"; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.fillStyle = "#3d5a80";
  for (const pl of PLATFORMS) ctx.fillRect(pl.x, pl.y, pl.w, pl.y > 150 ? VIEW_H - pl.y : 6);
  ctx.fillStyle = "#e0fbfc"; ctx.fillRect(Math.round(P.x), Math.round(P.y), BOX, BOX);
  ctx.fillStyle = "#ee6c4d"; ctx.fillRect(Math.round(P.x) + 3, Math.round(P.y) + 3, 2, 2);
  ctx.fillStyle = "#98c1d9";
  for (let i = 0; i < pcount; i++) ctx.fillRect(Math.round(px[i]), Math.round(py[i]), 2, 2);
  ctx.fillStyle = "#fff"; ctx.font = "8px monospace"; ctx.textBaseline = "top";
  ctx.fillText(`F ${Math.max(frame, 0)}  x ${P.x.toFixed(0)} y ${P.y.toFixed(0)}  p ${pcount}`, 4, 4);
}

// ---- fixed 60 Hz accumulator loop driven by rAF ----
let running = false, rafId = 0, last = 0, acc = 0, fps = 60, frameMs = 16.7, fault = null;

function runFault() {                                    // called inside an rAF callback, after the next frame was requested
  const f = fault; fault = null;
  if (f === "throw") throw new Error("demo: deliberate exception");
  if (f === "lag") { const end = performance.now() + 300; while (performance.now() < end) { /* busy-wait */ } }
}
function loop(ts) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);                   // request first so a throw below cannot stop the game
  if (fault) runFault();
  const dt = ts - last; last = ts;
  if (dt > 0) { frameMs += (dt - frameMs) * 0.1; fps = 1000 / frameMs; }
  acc = Math.min(acc + dt, STEP_MS * MAX_STEPS_PER_FRAME);
  pollPad();
  while (acc >= STEP_MS) { update(liveMask()); acc -= STEP_MS; }
  render();
}
function start() { if (running) return; running = true; last = performance.now(); acc = 0; rafId = requestAnimationFrame(loop); }
function stop() { running = false; cancelAnimationFrame(rafId); }

// ---- stepper: hold exactly `codes` for n steps (live keys ignored), then render once ----
function step(n, codes) {
  const mask = maskOfCodes(codes);
  for (let i = 0; i < n; i++) update(mask);
  render();
}

// ---- snapper registrations ----
const roundN = v => Math.round(v * 1000) / 1000;
function teleport(arg) {
  const [x, y] = String(arg ?? "").split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('teleport needs "x,y"');
  Object.assign(P, { x, y, vx: 0, vy: 0, grounded: false });
  render();
  return { x, y };
}
if (sn) {
  sn.registerState(() => ({
    scene: "play", frame, seed, rng,
    player: { x: roundN(P.x), y: roundN(P.y), vx: P.vx, vy: roundN(P.vy), grounded: P.grounded },
    particles: pcount,
    perf: { fps: Math.round(fps * 10) / 10, frameMs: Math.round(frameMs * 10) / 10 },   // volatile numbers only here
  }));
  sn.registerFrame(() => canvas);                        // the internal 320x180 buffer, not the scaled window
  sn.registerStepper({
    pause: stop, resume: start, step, frame: () => frame, keymap: KEYMAP, pauseParam: "paused",
    seed: () => seed, reset: s => { resetWorld(s); render(); },
  });
  sn.registerCommands({
    reset: { label: "Reset", run: () => { resetWorld(); render(); } },
    teleport: { label: "Teleport", arg: "text", run: teleport },
  });
}

// ---- keyboard, scaling, deliberate faults ----
addEventListener("keydown", e => {
  if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
  keyHeld[e.code] = true;
  if (e.repeat) return;
  if (e.code === "KeyE") console.error("demo: deliberate console.error");
  else if (e.code === "KeyX") { fault = "throw"; if (!running) requestAnimationFrame(runFault); }
  else if (e.code === "KeyL") { fault = "lag"; if (!running) requestAnimationFrame(runFault); }
  else if (e.code === "KeyT") window.snapper?.assert(false, "demo: deliberate assert");
  else if (e.code === "KeyG") window.snapper?.event("demo-event", { frame, x: roundN(P.x), y: roundN(P.y) });
});
addEventListener("keyup", e => { keyHeld[e.code] = false; });
addEventListener("blur", () => { for (const k in keyHeld) keyHeld[k] = false; });

function fit() {                                         // integer scaling, centred
  const s = Math.max(1, Math.floor(Math.min(innerWidth / VIEW_W, innerHeight / VIEW_H)));
  canvas.style.width = VIEW_W * s + "px"; canvas.style.height = VIEW_H * s + "px";
  canvas.style.left = Math.floor((innerWidth - VIEW_W * s) / 2) + "px";
  canvas.style.top = Math.floor((innerHeight - VIEW_H * s) / 2) + "px";
}
addEventListener("resize", fit);
fit();

render();
if (!new URLSearchParams(location.search).has("paused")) start();
