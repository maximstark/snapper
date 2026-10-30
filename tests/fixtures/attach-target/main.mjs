// A second, plain Electron that stands in for "the game's own shell / a Chrome the user started" in the attach tests (Z3).
// It serves nothing and loads no Snapper code: it opens a visible window on a URL with remote debugging on.
//   env ATTACH_TARGET_URL (ATTACH_TARGET_URL2: optional second window), ATTACH_TARGET_PORT (debug port), ATTACH_TARGET_USERDATA (a throwaway profile folder)
// (the URL is in the environment, not argv: Electron treats a URL argument as something to open itself.)
import { app, BrowserWindow } from "electron";

app.setPath("userData", process.env.ATTACH_TARGET_USERDATA);
app.commandLine.appendSwitch("remote-debugging-port", process.env.ATTACH_TARGET_PORT);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ x: 60, y: 60, width: 1280, height: 720, show: true, useContentSize: true, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadURL(process.env.ATTACH_TARGET_URL).catch(() => {});
  if (process.env.ATTACH_TARGET_URL2) {         // a second page (the ambiguous-endpoint test)
    const w2 = new BrowserWindow({ x: 120, y: 120, width: 640, height: 360, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
    await w2.loadURL(process.env.ATTACH_TARGET_URL2).catch(() => {});
  }
  process.stdout.write("ready\n");
});
app.on("window-all-closed", () => app.quit());
