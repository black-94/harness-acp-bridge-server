/**
 * Unit coverage for the configuration declaration surface: the optional per-model
 * `thinking_levels`, the `harness_info` description built from the configuration file only,
 * and `declaredThinkingLevels`. No daemon or harness is started.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConfigError,
  configArgument,
  declaredThinkingLevels,
  findModel,
  harnessInfo,
  loadConfig,
  type BridgeConfig,
} from "../src/config";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function configFromText(text: string): BridgeConfig {
  const dir = mkdtempSync(join(tmpdir(), "hab-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.yaml");
  writeFileSync(path, text);
  return loadConfig(path);
}

const DECLARED = `schema_version: 1
default_harness: codebuddy
harnesses:
  codebuddy:
    command: codebuddy
    models:
      - id: m-declared
        name: Declared
        thinking_levels: [low, high]
      - id: m-none
        name: None
        thinking_levels: []
      - id: m-unknown
        name: Unknown
  codex:
    command: codex-acp
    models:
      - id: c1
        name: Codex One
  agy:
    command: agy_acp_server
    models:
      - id: a1
        name: Agy One
launch:
  agy_edit_mode_id: agy-edit
`;

describe("configuration path diagnostics", () => {
  it.each([{ argv: ["--config"] }, { argv: ["--config", "--other"] }, { argv: ["--config="] }, { argv: ["--config", " "] }])(
    "rejects missing --config paths: $argv", ({ argv }) => {
      expect(() => configArgument(argv)).toThrow("--config requires a non-empty YAML file path");
    },
  );
  it("accepts both explicit config forms", () => {
    expect(configArgument(["--config", "./config.yaml"])).toBe("./config.yaml");
    expect(configArgument(["--config=./config.yaml"])).toBe("./config.yaml");
  });
  it("names a missing explicit or environment-selected YAML path", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hab-config-")), "missing.yaml");
    cleanups.push(() => rmSync(join(path, ".."), { recursive: true, force: true }));
    expect(() => loadConfig(path)).toThrow(`configured YAML file does not exist: ${path}`);
    vi.stubEnv("HARNESS_ACP_BRIDGE_CONFIG", path);
    expect(() => loadConfig()).toThrow(`configured YAML file does not exist: ${path}`);
  });
  it("rejects a directory used as the YAML file with a contextual ConfigError", () => {
    const dir = mkdtempSync(join(tmpdir(), "hab-config-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(`could not read configured YAML file ${dir}: EISDIR`);
  });
});

describe("model thinking_levels declaration", () => {
  it("parses declared, empty, and undeclared thinking levels", () => {
    const config = configFromText(DECLARED);
    expect(findModel(config, "codebuddy", "m-declared")?.thinkingLevels).toEqual(["low", "high"]);
    // An explicit empty list means "declared to support none", not unknown.
    expect(findModel(config, "codebuddy", "m-none")?.thinkingLevels).toEqual([]);
    // Omitted is unknown, reported as null and never assumed supported.
    expect(findModel(config, "codebuddy", "m-unknown")?.thinkingLevels).toBeNull();
    expect(declaredThinkingLevels(config, "codebuddy", "m-unknown")).toBeNull();
    expect(declaredThinkingLevels(config, "codebuddy", "not-configured")).toBeNull();
    expect(declaredThinkingLevels(config, "codebuddy", "m-declared")).toEqual(["low", "high"]);
  });

  it("rejects a malformed thinking_levels value", () => {
    expect(() =>
      configFromText(
        `schema_version: 1
harnesses:
  codebuddy:
    command: codebuddy
    models:
      - id: m
        thinking_levels: high
`,
      ),
    ).toThrow(ConfigError);
  });
});

describe("harness_info description", () => {
  it("lists every configured harness in sorted order with routable permission modes", () => {
    const info = harnessInfo(configFromText(DECLARED));
    expect(Object.keys(info)).toEqual(["agy", "codebuddy", "codex"]);
    expect(info.codebuddy.permission_modes).toEqual(["read", "edit", "auto", "yolo"]);
    expect(info.codex.permission_modes).toEqual(["read", "edit", "auto", "yolo"]);
    // Agy read/edit require an explicit mode id; only edit is configured here.
    expect(info.agy.permission_modes).toEqual(["edit", "auto", "yolo"]);
  });

  it("reports each model's id, name, and declared thinking_levels", () => {
    const info = harnessInfo(configFromText(DECLARED));
    expect(info.codebuddy.models).toEqual([
      { id: "m-declared", name: "Declared", thinking_levels: ["low", "high"] },
      { id: "m-none", name: "None", thinking_levels: [] },
      { id: "m-unknown", name: "Unknown", thinking_levels: null },
    ]);
    // A harness with no declarations is still listed, with null levels and full modes.
    expect(info.codex.models).toEqual([{ id: "c1", name: "Codex One", thinking_levels: null }]);
  });

  it("can select one harness and rejects an unknown one", () => {
    const config = configFromText(DECLARED);
    expect(Object.keys(harnessInfo(config, "codex"))).toEqual(["codex"]);
    expect(() => harnessInfo(config, "nope")).toThrow(ConfigError);
  });

  it("reports agy yolo (defaulted) as routable and read/edit when configured", () => {
    const config = configFromText(`${DECLARED}  agy_read_mode_id: agy-read
  agy_yolo_mode_id: custom-yolo
`);
    expect(harnessInfo(config, "agy").agy.permission_modes).toEqual([
      "read",
      "edit",
      "auto",
      "yolo",
    ]);
  });
});
