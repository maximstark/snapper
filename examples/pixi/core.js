// Snapper engine demos (MIT): the game and the Snapper integration, shared by the Phaser, PixiJS and Three.js demos.
// The simulation is plain code and a pure function of (boot URL, per-step input mask): a 60 Hz fixed step with no
// wall clock and a seeded RNG. The engine only draws it. Every snapper call is guarded, so the game is identical
// when Snapper is absent. This file is copied verbatim into each examples/<engine>/ folder.

export const VIEW_W = 320, VIEW_H = 180;
export const STEP_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 5;

// ---- input: 3 actions -> one mask bit each. keymap = first code of each row. ----
const LEFT = 1, RIGHT = 2, JUMP = 4;
const CODES = [["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"], ["Space", "KeyW", "ArrowUp"]];
export const KEYMAP = CODES.map(row => row[0]);

// ---- world ----
export const PLATFORMS = [
  { x: 0, y: 156, w: 320, h: 24 }, { x: 40, y: 124, w: 80, h: 8 }, { x: 170, y: 98, w: 90, h: 8 },
  { x: 20, y: 72, w: 64, h: 8 }, { x: 236, y: 134, w: 72, h: 8 },
];
export const BOX = 12, COIN = 8, NCOINS = 8;
const GRAVITY = 0.35, JUMP_V = -6.5, SPEED = 2, MAX_FALL = 8;   // -6.5 rises 57 px: platform 3 (y 72) is 52 px above platform 1 (y 124); -6 rose 48 and stranded the coins up there (Maxim's first 1.3 mark)
const roundN = v => Math.round(v * 1000) / 1000;

/**
 * Build the game around an engine. `engine` = { name, version(), render(), frameImage(), pause(), resume() }.
 * The engine reads `g.p` (player), `g.coinX/coinY/coinAlive`, `g.score`, `g.frame`, `g.wave` when it draws, and calls
 * `g.advance(dtMs)` from its loop. Registers with Snapper immediately; `engine.render()` must tolerate being called
 * before the engine has finished booting.
 */
export function createGame(engine) {
  const sn = window.snapper;                             // may be undefined
  const tick = window.snapper?.tick ?? (() => {});       // bound once, allocation-free
  const params = new URLSearchParams(location.search);
  const DEFAULT_SEED = Number(params.get("seed")) || 1234;

  // live input
  const keyHeld = {};
  let padMask = 0;
  const codeBit = code => { for (let i = 0; i < CODES.length; i++) if (CODES[i].includes(code)) return 1 << i; return 0; };
  const maskOfCodes = codes => { let m = 0; for (const c of codes || []) m |= codeBit(c); return m; };
  function liveMask() {                                  // no allocation
    let m = padMask;
    for (let i = 0; i < CODES.length; i++) {
      const row = CODES[i];
      for (let j = 0; j < row.length; j++) if (keyHeld[row[j]]) { m |= 1 << i; break; }
    }
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
      if (b[0] && b[0].pressed) padMask |= JUMP;
      return;
    }
  }

  // seeded RNG (mulberry32); its state is part of the game state
  let seed = DEFAULT_SEED, rng = seed >>> 0;
  function rand() {
    rng = (rng + 0x6D2B79F5) >>> 0;
    let t = rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const g = {
    p: { x: 24, y: 40, vx: 0, vy: 0, grounded: false },
    coinX: new Float32Array(NCOINS), coinY: new Float32Array(NCOINS), coinAlive: new Uint8Array(NCOINS),
    score: 0, wave: 1, frame: -1, left: NCOINS,
    paused: params.has("paused"),
    fps: 60, frameMs: 16.7,
  };
  let acc = 0;

  function spawnWave() {
    for (let i = 0; i < NCOINS; i++) {
      const pl = PLATFORMS[Math.floor(rand() * PLATFORMS.length)];
      g.coinX[i] = pl.x + 8 + rand() * (pl.w - 16);
      g.coinY[i] = pl.y - 14;
      g.coinAlive[i] = 1;
    }
    g.left = NCOINS;
  }
  function resetWorld(s) {
    seed = s === undefined || s === null ? DEFAULT_SEED : Number(s) || 0;
    rng = seed >>> 0;
    Object.assign(g.p, { x: 24, y: 40, vx: 0, vy: 0, grounded: false });
    g.score = 0; g.wave = 1; g.frame = -1;
    spawnWave();
  }
  resetWorld();

  function update(mask) {                                // one fixed step; `mask` is the only input
    const P = g.p;
    g.frame++;
    tick(g.frame, mask);
    const wasGrounded = P.grounded;
    P.vx = ((mask & RIGHT) ? SPEED : 0) - ((mask & LEFT) ? SPEED : 0);
    if ((mask & JUMP) && wasGrounded) { P.vy = JUMP_V; P.grounded = false; }
    P.vy += GRAVITY;
    if (P.vy > MAX_FALL) P.vy = MAX_FALL;
    P.x = Math.min(VIEW_W - BOX, Math.max(0, P.x + P.vx));
    const prevBottom = P.y + BOX;
    P.y += P.vy;
    P.grounded = false;
    for (let i = 0; i < PLATFORMS.length; i++) {
      const pl = PLATFORMS[i];
      if (P.vy >= 0 && prevBottom <= pl.y + 0.001 && P.y + BOX >= pl.y && P.x + BOX > pl.x && P.x < pl.x + pl.w) {
        P.y = pl.y - BOX; P.vy = 0; P.grounded = true;
        break;
      }
    }
    for (let i = 0; i < NCOINS; i++) {
      if (!g.coinAlive[i]) continue;
      const cx = g.coinX[i], cy = g.coinY[i], h = COIN / 2;
      if (P.x < cx + h && P.x + BOX > cx - h && P.y < cy + h && P.y + BOX > cy - h) {
        g.coinAlive[i] = 0; g.left--; g.score += 10;
      }
    }
    if (g.left === 0) { g.wave++; spawnWave(); }
  }

  /** Called by the engine's loop with the elapsed ms: runs the fixed steps owed, returns how many ran. */
  g.advance = dt => {
    if (dt > 0) { g.frameMs += (dt - g.frameMs) * 0.1; g.fps = 1000 / g.frameMs; }
    acc = Math.min(acc + dt, STEP_MS * MAX_STEPS_PER_FRAME);
    pollPad();
    let n = 0;
    while (acc >= STEP_MS) { update(liveMask()); acc -= STEP_MS; n++; }
    return n;
  };
  g.resetClock = () => { acc = 0; };

  // stepper: hold exactly `codes` for n steps (live keys ignored), then render once
  function step(n, codes) {
    const mask = maskOfCodes(codes);
    for (let i = 0; i < n; i++) update(mask);
    engine.render();
  }

  if (sn) {
    sn.registerState(() => {
      const collected = [];
      for (let i = 0; i < NCOINS; i++) if (!g.coinAlive[i]) collected.push(i);
      return {
        engine: engine.name, engineVersion: engine.version(),
        scene: "play", frame: g.frame, seed, rng,
        player: { x: roundN(g.p.x), y: roundN(g.p.y), vx: g.p.vx, vy: roundN(g.p.vy), grounded: g.p.grounded },
        score: g.score, wave: g.wave, coinsLeft: g.left, collected,
        perf: { fps: Math.round(g.fps * 10) / 10, frameMs: Math.round(g.frameMs * 10) / 10 },   // volatile numbers only here
      };
    });
    if (engine.frameImage) sn.registerFrame(() => engine.frameImage());
    sn.registerStepper({
      pause: () => engine.pause(), resume: () => { g.resetClock(); engine.resume(); },
      step, frame: () => g.frame, keymap: KEYMAP, pauseParam: "paused",
      seed: () => seed, reset: s => { resetWorld(s); engine.render(); },
    });
    sn.registerCommands({ reset: { label: "Reset", run: () => { resetWorld(); engine.render(); } } });
  }

  addEventListener("keydown", e => {
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    keyHeld[e.code] = true;
  });
  addEventListener("keyup", e => { keyHeld[e.code] = false; });
  addEventListener("blur", () => { for (const k in keyHeld) keyHeld[k] = false; });

  // read-only debug value: lets a harness see the game advance even with no Snapper present
  Object.defineProperty(window, "__demoFrame", { get: () => g.frame, configurable: true });

  g.fit = canvas => {                                    // integer scaling, centred
    const fit = () => {
      const s = Math.max(1, Math.floor(Math.min(innerWidth / VIEW_W, innerHeight / VIEW_H)));
      canvas.style.width = VIEW_W * s + "px"; canvas.style.height = VIEW_H * s + "px";
      canvas.style.left = Math.floor((innerWidth - VIEW_W * s) / 2) + "px";
      canvas.style.top = Math.floor((innerHeight - VIEW_H * s) / 2) + "px";
    };
    addEventListener("resize", fit);
    fit();
  };
  return g;
}
