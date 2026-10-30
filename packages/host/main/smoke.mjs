// Smoke runner (D-017). Steps run in order from `ready`. Keys go through CDP Input.dispatchKeyEvent so
// the game and the recorder both see real events.
//
// Vocabulary: wait, mark, key (+ms), keys (+hold), down, up, expect, end   (D-017); {"hotkey":"save"} saves a state (D-021)
// {"navigate": "?scene=stage&level=1-2"} loads the game URL with that query (CDP Page.navigate) and waits for the new ready (D-022).
// {"eval": "<js expression>", "ms": 30000} runs page code (awaits a promise); a throw, rejection or timeout is a failure; the result is not recorded (D-023).
// Additive (host tests; see the report): { "type": "text" } types characters with key events,
//                                        { "hotkey": "mark|save|overlay|pause|step|fullscreen" } fires a host hotkey action.
import { isErrorLine } from "../../core/index.mjs";
import { keyInfo, charKeyInfo, checkExpect } from "./helpers.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function runSmoke(host, script) {
  const failures = [];
  const steps = Array.isArray(script) ? script : script?.steps || [];

  async function dispatch(info, down) {
    const p = {
      type: down ? "keyDown" : "keyUp",
      code: info.code, key: info.key, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk,
      modifiers: info.shift ? 8 : 0,
    };
    if (down && info.text) { p.text = info.text; p.unmodifiedText = info.text; }
    await host.cdp("Input.dispatchKeyEvent", p);
  }
  // CDP-injected keys bypass Electron's before-input-event, so host hotkeys are routed here exactly as a real press would be.
  const down = async code => { if (!host.hostKey(code)) await dispatch(keyInfo(code), true); };
  const up = async code => { if (!host.isHostKey(code)) await dispatch(keyInfo(code), false); };

  function state() {
    const lines = host.writer.lines;
    return {
      marks: lines.filter(l => l.kind === "mark").length,
      exceptions: lines.filter(l => l.kind === "exception").length,
      errors: lines.filter(isErrorLine).length,
      triggers: new Set(lines.filter(l => l.kind === "mark").map(l => l.trigger)),
      ready: host.readyLine,
    };
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (host.closing) break;
    try {
      if (s.wait != null) await sleep(Number(s.wait));
      else if (s.mark != null) await host.requestMark("smoke", { note: String(s.mark) });
      else if (s.key != null) { await down(s.key); await sleep(Number(s.ms ?? 80)); await up(s.key); }
      else if (s.keys != null) {
        for (const k of s.keys) await down(k);
        await sleep(Number(s.hold ?? 300));
        for (const k of [...s.keys].reverse()) await up(k);
      }
      else if (s.down != null) await down(s.down);
      else if (s.up != null) await up(s.up);
      else if (s.type != null) {
        for (const ch of String(s.type)) {
          const info = charKeyInfo(ch);
          await dispatch(info, true); await sleep(15); await dispatch(info, false); await sleep(15);
        }
      }
      else if (s.hotkey != null) host.hotkey(String(s.hotkey));
      else if (s.navigate != null) await host.navigate(String(s.navigate));
      else if (s.eval != null) await host.evalAwait(String(s.eval), Number(s.ms ?? 30000));
      else if (s.expect != null) {
        await host.idle();
        const f = checkExpect(s.expect, state());
        for (const m of f) { failures.push(`step ${i} expect: ${m}`); host.warn(`smoke expect failed: ${m}`); }
      }
      else if (s.end) { await host.idle(); break; }
      else failures.push(`step ${i}: unknown step ${JSON.stringify(s)}`);
    } catch (err) {
      failures.push(`step ${i} (${JSON.stringify(s)}) threw: ${err && err.message || err}`);
    }
  }
  await host.idle();
  return { ok: failures.length === 0, failures };
}
