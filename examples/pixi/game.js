// Snapper PixiJS demo (MIT): the shared simulation in core.js, drawn with PixiJS (vendor/pixi.min.js, global PIXI).
// Own rAF loop with a fixed 60 Hz accumulator. Behaves identically with no Snapper present.
import { createGame, VIEW_W, VIEW_H, PLATFORMS, BOX, COIN, NCOINS } from "./core.js";

const canvas = document.getElementById("screen");
let app = null, booted = false;
let running = false, rafId = 0, last = 0;
let pausedWanted = new URLSearchParams(location.search).has("paused");
let hud = null, hudText = "";
let player, eye;
const coins = [];

const g = createGame({
  name: "pixi", version: () => PIXI.VERSION,
  render, frameImage,
  pause: () => { pausedWanted = true; stop(); },
  resume: () => { pausedWanted = false; if (booted) start(); },
});

function sync() {
  player.position.set(Math.round(g.p.x), Math.round(g.p.y));
  for (let i = 0; i < NCOINS; i++) {
    coins[i].visible = g.coinAlive[i] === 1;
    coins[i].position.set(Math.round(g.coinX[i]), Math.round(g.coinY[i]));
  }
  const t = `F ${Math.max(g.frame, 0)}  score ${g.score}  wave ${g.wave}`;
  if (t !== hudText) { hudText = t; hud.text = t; }
}
function render() {
  if (!booted) return;
  sync();
  app.render();
}
function frameImage() {                                  // render and read in the same task (no preserveDrawingBuffer needed)
  if (!booted) return null;
  render();
  return canvas.toDataURL("image/png");
}

function loop(ts) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  const dt = ts - last; last = ts;
  g.advance(dt);
  render();
}
function start() { if (running) return; running = true; last = performance.now(); g.resetClock(); rafId = requestAnimationFrame(loop); }
function stop() { running = false; cancelAnimationFrame(rafId); }

async function boot() {
  app = new PIXI.Application();
  await app.init({
    canvas, width: VIEW_W, height: VIEW_H, background: 0x1b2238,
    antialias: false, autoStart: false, sharedTicker: false, resolution: 1, autoDensity: false, preference: "webgl",
  });
  app.ticker.stop();
  const plat = new PIXI.Graphics();
  for (const pl of PLATFORMS) plat.rect(pl.x, pl.y, pl.w, pl.h).fill(0x3d5a80);
  app.stage.addChild(plat);
  for (let i = 0; i < NCOINS; i++) {
    const c = new PIXI.Graphics().circle(0, 0, COIN / 2).fill(0xffd166);
    coins.push(c); app.stage.addChild(c);
  }
  player = new PIXI.Container();
  player.addChild(new PIXI.Graphics().rect(0, 0, BOX, BOX).fill(0xe0fbfc));
  eye = new PIXI.Graphics().rect(3, 3, 2, 2).fill(0xee6c4d);
  player.addChild(eye);
  app.stage.addChild(player);
  hud = new PIXI.Text({ text: "", style: { fontFamily: "monospace", fontSize: 8, fill: 0xffffff } });
  hud.position.set(4, 4);
  app.stage.addChild(hud);
  booted = true;
  render();
  if (!pausedWanted) start();
}

g.fit(canvas);
boot().catch(err => { console.error("pixi demo: boot failed", err); });
