import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { proxyEndpoints, proxyProbeProgram } from "../src/io/proxy";
import { checkContainerProxy, runControl, type LaunchSpec } from "../src/io/runtime";

const docker = fileURLToPath(new URL("./fixtures/mock-docker.mjs", import.meta.url));
function spec(env: Record<string, string>, extra: Partial<LaunchSpec> = {}): LaunchSpec {
  return { launchMode: "local", sshHost: null, sshCommand: "ssh", dockerCommand: docker,
    cwd: "/work", argv: ["codebuddy"], harnessEnv: env, dockerImage: "img", dockerContainerName: "container",
    dockerId: null, dockerMounts: [], dockerPorts: [], dockerHostNetwork: false, containerPolicy: "remove",
    reuseContainer: false, remotePidFile: null, startupTimeoutSeconds: 3, terminateGraceSeconds: 0.05,
    remoteCleanupTimeoutSeconds: 1, ...extra };
}
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function listener(): Promise<number> {
  const server = createServer(socket => socket.end()); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

describe("proxy endpoint parsing", () => {
  it("deduplicates aliases and removes credentials/path/query", () => {
    expect(proxyEndpoints({ http_proxy: "http://name:password@host.docker.internal:10809/path?secret=value",
      HTTPS_PROXY: "http://host.docker.internal:10809", no_proxy: "localhost" }))
      .toEqual([{ host: "host.docker.internal", port: 10809 }]);
    const program = proxyProbeProgram(proxyEndpoints({ all_proxy: "socks5h://name:password@proxy.example:10808" }), 1000).join(" ");
    expect(program).toContain("proxy.example"); expect(program).not.toContain("password");
  });
  it("supports standard default ports and IPv6 literals", () => {
    expect(proxyEndpoints({ http_proxy: "http://proxy.example", https_proxy: "https://proxy.example",
      all_proxy: "socks5://[::1]" })).toEqual([
        { host: "proxy.example", port: 80 }, { host: "proxy.example", port: 443 }, { host: "::1", port: 1080 },
      ]);
    expect(proxyEndpoints({ http_proxy: " ", no_proxy: "*" })).toEqual([]);
  });
  it.each(["not a URL password", "ftp://user:password@host", "http://host:0", "http://host:99999"])(
    "rejects a malformed/unsupported URL without echoing its value", value => {
      try { proxyEndpoints({ http_proxy: value }); throw new Error("accepted"); }
      catch (error) {
        expect(error).toMatchObject({ code: "invalid_proxy_configuration" });
        expect(String(error)).not.toContain("password");
      }
    },
  );
});

describe("in-container proxy preflight", () => {
  it("checks TCP connectivity and deduplicates endpoints without contacting any login service", async () => {
    const port = await listener();
    await expect(checkContainerProxy(spec({ http_proxy: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: `http://user:password@127.0.0.1:${port}` }))).resolves.toBeUndefined();
  });
  it("skips non-Docker launches and empty proxy env", async () => {
    await expect(checkContainerProxy(spec({ http_proxy: "invalid" }, { dockerContainerName: null }))).resolves.toBeUndefined();
    await expect(checkContainerProxy(spec({ no_proxy: "*" }, { dockerCommand: "/nonexistent/docker" }))).resolves.toBeUndefined();
  });
  it("fails closed for DNS errors, with recreation guidance for a retained host-alias container", async () => {
    // The .invalid suffix is reserved; this also exercises the bounded DNS/TCP timer.
    await expect(checkContainerProxy(spec({ http_proxy: "http://user:password@proxy.invalid:10809" })))
      .rejects.toMatchObject({ code: "proxy_unreachable" });
    await expect(checkContainerProxy(spec({ http_proxy: "http://host.docker.internal:1" }, { reuseContainer: true })))
      .rejects.toThrow(/Recreate the retained container with --add-host/);
  }, 10000);
  it("reports a refused connection and never exposes proxy userinfo", async () => {
    const port = await listener();
    const server = servers.pop()!;
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { await checkContainerProxy(spec({ http_proxy: `http://user:password@127.0.0.1:${port}` })); throw new Error("accepted"); }
    catch (error) {
      expect(error).toMatchObject({ code: "proxy_unreachable" });
      expect(String(error)).toContain("ECONNREFUSED"); expect(String(error)).not.toMatch(/user|password/);
    }
  });
  it("honours cancellation instead of starting the harness", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(checkContainerProxy(spec({ http_proxy: "http://127.0.0.1:1" }), controller.signal))
      .rejects.toMatchObject({ code: "request_aborted" });
  });
  const pythonAvailable = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!pythonAvailable)("provides an equivalent Python probe for non-Node images", async () => {
    const port = await listener();
    const args = proxyProbeProgram([{ host: "127.0.0.1", port }], 1000);
    const result = await runControl({ argv: ["python3", "-c", args[5]!, args[6]!, args[7]!], env: {}, cwd: null }, 3000);
    expect(result).toMatchObject({ code: 0, timedOut: false });
  });
});
