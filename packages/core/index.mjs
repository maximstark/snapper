// @snapper/core — session format I/O shared by the host, the replay runner and the tools. MIT.
// Pure Node: no Electron, no browser automation.
export { sessionIdFor, isoLocal, markId, round1, fmtT, fmtDuration, idToDisplay, pad } from "./src/time.mjs";
export { IDLE_MS, createActivity, noteActivity, activeTotal, activeMsOf, fmtSessionDuration } from "./src/activity.mjs";
export { parseJsonl, toJsonl } from "./src/jsonl.mjs";
export { createSessionWriter, SessionWriter, writeSummary, atomicWrite, deepMerge } from "./src/writer.mjs";
export { readSession, readMark, readTape, readJson, readText, findSessions, isErrorLine, errorText, sessionGameRoot } from "./src/reader.mjs";
export { renderSessionHtml, writeReport, esc as escapeHtml } from "./src/report.mjs";
export { buildIssue, issueMarkdown } from "./src/issue.mjs";
export { renderSessionMd, stateLine, resumedLine, overheadLine } from "./src/render.mjs";
export {
  parseTape, segments, segmentForMark, maskAt, codesOf, maskOf, runsBetween, frameLinesWindow,
  tapeLinesFromFlush, segmentQuery, chooseQuery, isFrameLine, isWallLine, isReload,
} from "./src/tape.mjs";
export {
  CHECKPOINTS_DIR, checkpointName, checkpointPath, segmentOf, makeCheckpoint, writeCheckpoint, readCheckpoint,
  listCheckpoints, listCheckpointsWithMarks, synthesiseMarkCheckpoint, resolveAt, findResumeSource, samePath, rawSegments, pickSegment, resumeTapeLines, sessionIdOf,
} from "./src/checkpoint.mjs";
export { firstDiff, diffPaths, compareState, compareStateAll, chunkRuns, stepTo, addQueryParam, stepExpression } from "./src/restore.mjs";
export { perfStats, buildPerfJson, longTasksOf } from "./src/perf.mjs";
export { isPng, pngSize, decodePng, encodePng, pngStats, dataUrlToBuffer } from "./src/png.mjs";
export { serveStatic, MIME } from "./src/serve.mjs";
export { DEFAULT_CONFIG, PRESETS, slugify, readGameConfig, gitInfo, defaultSessionsDir, resolveConfig } from "./src/game.mjs";
export { composeSheet, composeSheetSource } from "./src/sheet-page.mjs";
export {
  TRIAGE_STATUSES, TRIAGE_FILE, triageProblem, nextTriage, readTriage, writeTriage, triageCounts, triageSummary, triageLine,
} from "./src/triage.mjs";
export { crc32, writeZip, zipDir, listTree, readZip, readZipEntry, extractZip, safeEntryName } from "./src/zip.mjs";
export { detectIntegration, lastSdkSeen, integrationLine, snapperCalls, moduleScripts } from "./src/integration.mjs";

export const SNAPPER_VERSION = "1.4.2";
export const FORMAT_VERSION = 1;
