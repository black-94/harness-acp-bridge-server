import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CLIENT_VERSION } from "../src/acp/protocol";

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

  it("uses the package version in ACP handshakes", () => {
    expect(CLIENT_VERSION).toBe(manifest.version);
  });

  it("publishes the library entrypoint, the hacpd/hacpr commands, and no MCP dependency", () => {
    expect(manifest.bin).toEqual({ hacpd: "./dist/main.js", hacpr: "./dist/io/reader.js" });
    expect(manifest.exports).toEqual({ ".": "./dist/index.js" });
    expect(manifest.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();
  });

  it("ships every command target in the published tarball", () => {
    const targets = Object.values(manifest.bin as Record<string, string>);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const relative = target.replace(/^\.\//, "");
      expect(manifest.files.some((entry: string) => relative === entry || relative.startsWith(`${entry}/`))).toBe(true);
    }
  });
});
