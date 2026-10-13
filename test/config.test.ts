/** Built-in harnesses and default settings work without a YAML file or harness declarations. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, resolveHarness, loadConfig, type BridgeConfig } from "../src/logic/config";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "hab-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function configFromText(text: string): BridgeConfig {
  const path = join(directory(), "config.yaml");
  writeFileSync(path, text);
  return loadConfig(path);
}

describe("configuration path diagnostics", () => {
  it("names a missing explicit or environment-selected YAML path", () => {
    const path = join(directory(), "missing.yaml");
    expect(() => loadConfig(path)).toThrow(`configured YAML file does not exist: ${path}`);
    vi.stubEnv("HARNESS_ACP_BRIDGE_CONFIG", path);
    expect(() => loadConfig()).toThrow(`configured YAML file does not exist: ${path}`);
  });
  it("rejects a directory used as the YAML file with a contextual ConfigError", () => {
    const dir = directory();
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(`could not read configured YAML file ${dir}: EISDIR`);
  });
});

describe("declaration-free harness configuration", () => {
  it("uses defaults when no YAML exists and selects Codex by default", () => {
    vi.stubEnv("XDG_CONFIG_HOME", directory());
    vi.stubEnv("HARNESS_ACP_BRIDGE_CONFIG", "");
    const config = loadConfig();
    expect(config.configPath).toBeNull();
    expect(config.defaultHarness).toBe("codex");
    expect(resolveHarness(config)).toBe("codex");
    expect(config.server).toMatchObject({ host: "127.0.0.1", port: 8787 });
    expect(config.sessions.maxConcurrency).toBe(2);
    expect(config).not.toHaveProperty("harnesses");
    for (const name of ["codebuddy", "codex", "agy"]) expect(resolveHarness(config, name)).toBe(name);
  });
  it("treats empty YAML and a null default_harness as built-in defaults", () => {
    expect(resolveHarness(configFromText(""))).toBe("codex");
    expect(resolveHarness(configFromText("default_harness: null\n"))).toBe("codex");
  });
  it.each(["codebuddy", "codex", "agy"])("supports default_harness=%s without declarations", name => {
    const config = configFromText(`default_harness: ${name}\n`);
    expect(config.defaultHarness).toBe(name);
    expect(resolveHarness(config)).toBe(name);
    expect(resolveHarness(config, "codebuddy")).toBe("codebuddy");
  });
  it.each(["unknown", "constructor", "__proto__", "toString"])("rejects non-adapter harness %s", name => {
    expect(() => configFromText(`default_harness: ${name}\n`)).toThrow(ConfigError);
    expect(() => resolveHarness(configFromText(""), name)).toThrow(ConfigError);
  });
  it.each(["harnesses: {}", "harnesses:\n  codebuddy: {}", `harnesses:
  codebuddy:
    models:
      - id: old-model
        thinking_levels: [low, high]
`])("rejects obsolete harness declarations: %s", text => {
    expect(() => configFromText(text)).toThrow(/Unrecognized key/);
  });
  it("keeps agy permission mode routing configurable independently of harness declarations", () => {
    const config = configFromText(`launch:
  agy_read_mode_id: agy-read
  agy_edit_mode_id: agy-edit
  agy_yolo_mode_id: custom-yolo
`);
    expect(config.launch.agyModeIds).toEqual({ read: "agy-read", edit: "agy-edit", auto: null, yolo: "custom-yolo" });
  });
});
