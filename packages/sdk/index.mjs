// ESM wrapper: loading snapper.js assigns globalThis.snapper (kept if the host already injected one).
import "./snapper.js";

export const snapper = globalThis.snapper;
export default snapper;
