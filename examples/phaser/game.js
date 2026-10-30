// Snapper Phaser demo (MIT): the shared simulation in core.js, drawn with Phaser (vendor/phaser.min.js, global Phaser).
// Phaser's own loop drives the fixed 60 Hz accumulator from the scene's update(); pause/resume are loop.sleep()/wake()
// and a paused game renders on demand through game.step(). Behaves identically with no Snapper present.
import { createGame, VIEW_W, VIEW_H, PLATFORMS, BOX, COIN, NCOINS } from "./core.js";

const canvas = document.getElementById("screen");
let game = null, scene = null;
let pausedWanted = new URLSearchParams(location.search).has("paused");
let manual = false;                                      // true while we call game.step() ourselves: scene.update must not advance the sim
let hudText = "";
let player, eye, hud;
const coins = [];

const g = createGame({
  name: "phaser", version: () => Phaser.VERSION,
  render, frameImage,
  pause: () => { pausedWanted = true; game?.loop?.sleep(); },
  resume: () => { pausedWanted = false; game?.loop?.wake(); },
});

function sync() {
  player.setPosition(Math.round(g.p.x), Math.round(g.p.y));
  eye.setPosition(Math.round(g.p.x) + 3, Math.round(g.p.y) + 3);
  for (let i = 0; i < NCOINS; i++) {
    coins[i].setVisible(g.coinAlive[i] === 1);
    coins[i].setPosition(Math.round(g.coinX[i]), Math.round(g.coinY[i]));
  }
  const t = `F ${Math.max(g.frame, 0)}  score ${g.score}  wave ${g.wave}`;
  if (t !== hudText) { hudText = t; hud.setText(t); }
}
function render() {                                      // draw the current sim state once, outside Phaser's loop
  if (!scene) return;
  sync();
  manual = true;
  try { game.step(performance.now(), 16.7); } finally { manual = false; }
}
function frameImage() {                                  // render and read in the same task (no preserveDrawingBuffer needed)
  if (!scene) return null;
  render();
  return canvas.toDataURL("image/png");
}

const mainScene = {
  key: "main",
  create() {
    scene = this;
    for (const pl of PLATFORMS) this.add.rectangle(pl.x, pl.y, pl.w, pl.h, 0x3d5a80).setOrigin(0, 0);
    for (let i = 0; i < NCOINS; i++) coins.push(this.add.circle(0, 0, COIN / 2, 0xffd166));
    player = this.add.rectangle(0, 0, BOX, BOX, 0xe0fbfc).setOrigin(0, 0);
    eye = this.add.rectangle(0, 0, 2, 2, 0xee6c4d).setOrigin(0, 0);
    hud = this.add.text(4, 4, "", { fontFamily: "monospace", fontSize: "8px", color: "#ffffff" });
    sync();
    if (pausedWanted) game.loop.sleep();                 // the frame being built now still renders
  },
  update(time, delta) {
    if (manual) return;
    g.advance(delta);
    sync();
  },
};

// An adopted canvas needs an explicit renderer type (Phaser throws on AUTO).
game = new Phaser.Game({
  type: Phaser.WEBGL, canvas, width: VIEW_W, height: VIEW_H, backgroundColor: "#1b2238",
  pixelArt: true, banner: false, audio: { noAudio: true },
  scale: { mode: Phaser.Scale.NONE },
  scene: mainScene,
});
g.fit(canvas);
