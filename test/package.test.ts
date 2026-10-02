import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CLIENT_VERSION } from "../src/acp";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

describe("npm release metadata", () => {
  it("keeps the scoped package identity and lockfile in sync", () => {
    expect(manifest.name).toBe("@black942026/harness-acp-bridge-server");
    expect(manifest.private).not.toBe(true);
    expect(manifest.publishConfig.access).toBe("public");
    expect(lock.name).toBe(manifest.name);
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""].name).toBe(manifest.name);
    expect(lock.packages[""].version).toBe(manifest.version);
  });

  it("uses the package version in MCP and ACP handshakes", () => {
    expect(CLIENT_VERSION).toBe(manifest.version);
  });

  it("keeps both executable entrypoints shebang-enabled", () => {
    expect(manifest.bin).toEqual({
      "harness-acp-bridge": "dist/cli.js",
      "harness-acp-bridge-daemon": "dist/daemon/main.js",
    });
    for (const entry of Object.values(manifest.bin) as string[]) {
      const source = entry.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
      expect(readFileSync(new URL(`../${source}`, import.meta.url), "utf8"))
        .toMatch(/^#!\/usr\/bin\/env node\n/);
    }
  });
});
