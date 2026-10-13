/**
 * Persistent administrator-owned launch templates; validated but never executed during
 * registration.
 *
 * Templates are **information only**: `create_session` no longer references a template, merges its
 * defaults, or records a selected template's identity. A caller (typically an LLM) reads a template,
 * maps `model`/`thinking` to session options, follows natural-language instructions itself,
 * drops template-only fields and fields that do not apply, and passes allowed fields directly to
 * `create_session`. Registration/search/delete exist to store and serve that information.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getAdapter } from "../adapter/adapters.js";
import { writeJsonAtomicSync } from "../io/persistence.js";
import { hasProxyEnv, normalizeArgs, normalizeCommand, normalizeCreateParams, normalizeEnv } from "./create-params.js";
import { BridgeError } from "./errors.js";

const text = z.string().refine(value => !value.includes("\0"), "must not contain NUL");
const mount = z.object({ source: text, target: text, read_only: z.boolean().default(false) }).strict();
/** Common local/private bypasses; consumers must support CIDR entries to honor the ranges. */
export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local,.internal";
const MANAGED_PROXY_KEYS = ["http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "all_proxy", "ALL_PROXY"];
export const templateSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  description: text.nullable().default(null),
  harness: z.enum(["codebuddy", "codex", "agy"]),
  model: text.refine(value => value.trim().length > 0, "must not be blank").nullable().default(null),
  thinking: text.refine(value => value.trim().length > 0, "must not be blank").nullable().default(null),
  // Natural-language guidance for the calling LLM, never server-executed hooks or session params.
  before_start: text.nullable().default(null),
  after_start: text.nullable().default(null),
  special_instructions: text.nullable().default(null),
  runtime: z.enum(["direct", "docker"]).default("direct"),
  target: z.enum(["local", "remote"]).default("local"),
  remote_host: text.transform(value => value.trim()).pipe(z.string().min(1)).nullable().default(null),
  permission_mode: z.enum(["read", "edit", "auto", "yolo"]).default("auto"),
  // Empty/null means look up the built-in executable in the execution target's PATH.
  command: text.nullable().default(null),
  args: z.array(text).default([]),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), text).default({}),
  cwd: text.refine(value => value.startsWith("/"), "must be an absolute path").nullable().default(null),
  docker_image: text.nullable().default(null),
  container_policy: z.enum(["remove", "keep"]).optional(),
  login_dirs: z.array(mount).default([]),
  mounts: z.array(mount).default([]),
  ports: z.array(z.object({
    host_port: z.number().int(), container_port: z.number().int(),
    protocol: z.enum(["tcp", "udp"]).default("tcp"), host_ip: text.nullable().default(null),
  }).strict()).default([]),
  // Template-only choice; the caller maps host to session host_network=true.
  network_mode: z.enum(["none", "host", "proxy"]).default("none"),
  proxy_port: z.number().int().min(1).max(65535).nullable().default(null),
}).strict();
export type LaunchTemplate = z.infer<typeof templateSchema>;
export const HARNESS_COMMANDS: Readonly<Record<string, string>> = {
  codebuddy: "codebuddy", codex: "codex-acp", agy: "agy_acp_server",
};

/** Only explicit, known ACP implementation names are accepted; no substring guesses. */
const AGENT_NAMES: Readonly<Record<string, readonly string[]>> = {
  codebuddy: ["codebuddy", "codebuddy-code"],
  codex: ["codex", "codex-acp"],
  agy: ["agy", "agy-acp-server", "agy_acp_server", "antigravity"],
};
export function assertHarnessIdentity(harness: string, response: Record<string, unknown>): void {
  const result = response.result as Record<string, unknown> | undefined;
  const agent = result?.agentInfo as Record<string, unknown> | undefined;
  const name = typeof agent?.name === "string" ? agent.name.trim().toLowerCase() : null;
  if (!name || !AGENT_NAMES[harness]?.includes(name)) {
    throw new BridgeError("invalid_harness_command", `command does not identify as the selected harness ${harness}`, {
      expected_harness: harness, agent_name: name,
    });
  }
}

/**
 * Template fields projected into the launch-parameter validator, used **only** by
 * `validateTemplate` to prove a template is launchable. It is no longer consumed by
 * `create_session` (which takes explicit parameters), so a template's Docker fields are merged here
 * purely to exercise the same Docker rules the session path uses.
 */
export function templateDefaults(template: LaunchTemplate): Record<string, unknown> {
  return {
    harness: template.harness, runtime: template.runtime,
    target: template.target, remote_host: template.remote_host, permission_mode: template.permission_mode,
    env: template.env,
    ...(template.model !== null ? { model_id: template.model } : {}),
    ...(template.thinking !== null ? { thinking_level: template.thinking } : {}),
    ...(template.cwd !== null ? { cwd: template.cwd } : {}),
    ...(template.runtime === "docker" ? {
      docker_image: template.docker_image, container_policy: template.container_policy ?? "remove",
      mounts: [...template.login_dirs, ...template.mounts], ports: template.ports, host_network: template.network_mode === "host",
    } : {}),
  };
}
export function validateTemplate(raw: unknown): LaunchTemplate {
  const parsed = templateSchema.safeParse(raw);
  if (!parsed.success) throw new BridgeError("invalid_template", "invalid launch template", parsed.error.issues);
  const template = parsed.data;
  // Reuse the exact launch-parameter validation that `create_session` uses, so a command/args/env
  // accepted here is accepted there too (and vice versa) — no forked validators.
  try {
    template.command = normalizeCommand(template.command);
    template.args = normalizeArgs(template.args);
    template.env = normalizeEnv(template.env);
  } catch (error) {
    throw new BridgeError("invalid_template", error instanceof Error ? error.message : String(error));
  }
  if (template.runtime === "direct" && (template.docker_image !== null || template.container_policy !== undefined ||
      template.login_dirs.length || template.mounts.length || template.ports.length || template.network_mode !== "none")) {
    throw new BridgeError("invalid_template", "Docker fields require runtime=docker");
  }
  if (template.network_mode === "proxy") {
    if (template.proxy_port === null) throw new BridgeError("invalid_template", "network_mode=proxy requires proxy_port");
    const proxyUrl = `http://host.docker.internal:${template.proxy_port}`;
    // Mode/port own all proxy settings, including stale aliases that could override lowercase keys.
    const otherEnv = Object.fromEntries(Object.entries(template.env).filter(([key]) => !MANAGED_PROXY_KEYS.includes(key)));
    template.env = { ...otherEnv, http_proxy: proxyUrl, https_proxy: proxyUrl, no_proxy: DEFAULT_NO_PROXY };
  } else {
    if (template.proxy_port !== null) throw new BridgeError("invalid_template", "proxy_port requires network_mode=proxy");
    if (template.runtime === "docker" && hasProxyEnv(template.env)) {
      throw new BridgeError("invalid_template", "proxy environment variables require network_mode=proxy");
    }
  }
  try {
    const options = normalizeCreateParams({ cwd: "/work", model_id: "template-validation", ...templateDefaults(template) });
    const adapter = getAdapter(template.harness);
    const config = {
      harness: template.harness, cwd: options.cwd, modelId: options.modelId,
      command: template.command ?? HARNESS_COMMANDS[template.harness]!, args: template.args, env: template.env,
      launchMode: options.target === "remote" ? "ssh" as const : "local" as const,
      runtime: template.runtime,
      // Agy's non-auto modes require YAML mode IDs and are checked when a session is created.
      permissionMode: template.harness === "agy" ? "auto" as const : options.permissionMode,
      acpModeId: null, sshHost: options.remoteHost, dockerImage: options.dockerImage, reuseContainer: false,
    };
    adapter.validate(config);
    adapter.buildArgv(config);
  } catch (error) {
    throw new BridgeError("invalid_template", error instanceof Error ? error.message : String(error));
  }
  return template;
}

export class TemplateRegistry {
  private readonly templates = new Map<string, LaunchTemplate>();
  private readonly path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "templates.json");
    if (!existsSync(this.path)) return;
    try {
      if (lstatSync(this.path).isSymbolicLink() || !lstatSync(this.path).isFile()) throw new Error("registry must be a regular file");
      const stored: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(stored)) throw new Error("registry must be an array");
      for (const raw of stored) {
        const template = validateTemplate(raw);
        if (this.templates.has(template.name)) throw new Error("duplicate template name");
        this.templates.set(template.name, template);
      }
    } catch (error) { throw new BridgeError("storage_error", `could not load template registry: ${String(error)}`); }
  }
  private save(next: Map<string, LaunchTemplate>): void {
    try { writeJsonAtomicSync(this.path, [...next.values()]); }
    catch (error) { throw new BridgeError("storage_error", `could not persist templates: ${String(error)}`); }
    this.templates.clear();
    for (const [name, template] of next) this.templates.set(name, template);
  }
  register(raw: unknown): LaunchTemplate {
    const template = validateTemplate(raw);
    if (this.templates.has(template.name)) throw new BridgeError("template_exists", "template name already registered");
    this.save(new Map([...this.templates, [template.name, template]]));
    return structuredClone(template);
  }
  get(name: string): LaunchTemplate {
    const template = this.templates.get(name);
    if (!template) throw new BridgeError("template_not_found", "unknown template name");
    return structuredClone(template);
  }
  delete(name: string): void {
    this.get(name);
    const next = new Map(this.templates); next.delete(name); this.save(next);
  }
  search(query?: string | null, harness?: string | null, name?: string | null): LaunchTemplate[] {
    const needle = query?.toLowerCase();
    return [...this.templates.values()]
      .filter(template => (!name || template.name === name) && (!harness || template.harness === harness) &&
        (!needle || `${template.name} ${template.harness} ${template.description ?? ""}`.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name)).map(template => structuredClone(template));
  }
}
