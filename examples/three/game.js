// Snapper Three.js demo (MIT): the shared 2D simulation in core.js, drawn as a small 3D scene with Three.js
// (vendor/three.module.js, ESM). Own rAF loop with a fixed 60 Hz accumulator. Behaves identically with no Snapper present.
import * as THREE from "./vendor/three.module.js";
import { createGame, VIEW_W, VIEW_H, PLATFORMS, BOX, COIN, NCOINS } from "./core.js";

const canvas = document.getElementById("screen");
const hudEl = document.getElementById("hud");
let running = false, rafId = 0, last = 0;
let hudText = "";

const g = createGame({
  name: "three", version: () => "r" + THREE.REVISION,
  render, frameImage,
  pause: () => stop(),
  resume: () => start(),
});

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(VIEW_W, VIEW_H, false);
renderer.setClearColor(0x1b2238, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, VIEW_W / VIEW_H, 1, 1000);
scene.add(new THREE.AmbientLight(0x8899bb, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-120, 260, 300);
scene.add(sun);

// world y points down in the simulation; the scene's y points up
const wy = y => VIEW_H - y;
const platformMat = new THREE.MeshLambertMaterial({ color: 0x3d5a80 });
for (const pl of PLATFORMS) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(pl.w, pl.h, 28), platformMat);
  m.position.set(pl.x + pl.w / 2, wy(pl.y + pl.h / 2), 0);
  scene.add(m);
}
const coinGeo = new THREE.OctahedronGeometry(COIN / 2 + 1), coinMat = new THREE.MeshLambertMaterial({ color: 0xffd166 });
const coins = [];
for (let i = 0; i < NCOINS; i++) { const m = new THREE.Mesh(coinGeo, coinMat); coins.push(m); scene.add(m); }
const player = new THREE.Mesh(new THREE.BoxGeometry(BOX, BOX, BOX), new THREE.MeshLambertMaterial({ color: 0xe0fbfc }));
scene.add(player);

function sync() {
  player.position.set(g.p.x + BOX / 2, wy(g.p.y + BOX / 2), 0);
  const spin = Math.max(g.frame, 0) * 0.06;              // a pure function of the sim frame
  for (let i = 0; i < NCOINS; i++) {
    coins[i].visible = g.coinAlive[i] === 1;
    coins[i].position.set(g.coinX[i], wy(g.coinY[i]), 0);
    coins[i].rotation.y = spin + i;
  }
  const cx = VIEW_W / 2 + (g.p.x - VIEW_W / 2) * 0.25;   // the camera follows the player a little
  camera.position.set(cx, VIEW_H / 2 + 14, 255);
  camera.lookAt(cx, VIEW_H / 2 - 4, 0);
  const t = `F ${Math.max(g.frame, 0)}  score ${g.score}  wave ${g.wave}`;
  if (t !== hudText) { hudText = t; hudEl.textContent = t; }
}
function render() {
  sync();
  renderer.render(scene, camera);
}
function frameImage() {                                  // render and read in the same task (no preserveDrawingBuffer needed)
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

g.fit(canvas);
render();
if (!g.paused) start();
