/**
 * Entrypoint detection for the self-hosted command modules (`hacpr`, the supervisor).
 *
 * A module that doubles as a command guards its side effects behind this check, so importing it
 * as a library — or from a test runner — never starts anything.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when `moduleUrl`'s file is the process entrypoint.
 *
 * The caller passes its own `import.meta.url`: this module cannot know which file is asking.
 *
 * Both sides are resolved through `realpathSync` on purpose. `npm`'s global `.bin` shims are
 * symlinks to the real module, so `process.argv[1]` is the link path while `import.meta.url` is
 * the target; a plain string comparison would silently disable the command after `npm i -g`.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
