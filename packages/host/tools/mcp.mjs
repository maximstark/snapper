// snapper mcp — the MCP server (packages/mcp, MIT) on this process's stdin/stdout (BRIEF-v1.3 §5.2).
// The MIT package knows nothing about Electron: this host command tells it how to run the Snapper CLI from here.
//   dev (node bin/snapper.mjs mcp)            node  <app>/packages/host/bin/snapper.mjs …
//   packaged (snapper.cmd mcp, RUN_AS_NODE)   Snapper.exe <app>/packages/host/bin/snapper.mjs …  with ELECTRON_RUN_AS_NODE=1
// stdout is the protocol: nothing else may be written there.
import { join } from "node:path";
import { APP_ROOT } from "../main/electron-bin.mjs";
import { startMcp } from "../../mcp/server.mjs";

/** The spawn spec of the Snapper CLI for the process this runs in. Pure over its inputs (unit-tested). */
export function cliSpec({ execPath = process.execPath, electron = process.versions.electron, appRoot = APP_ROOT } = {}) {
  return {
    cli: [execPath, join(appRoot, "packages", "host", "bin", "snapper.mjs")],
    env: electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}

export async function run() {
  return await startMcp(cliSpec());
}
