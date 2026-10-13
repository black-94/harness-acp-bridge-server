/** Credential-free Docker proxy endpoints and an in-container DNS/TCP preflight. */
import { PROXY_ENV_KEYS } from "../logic/create-params.js";
import { BridgeError } from "../logic/errors.js";

export interface ProxyEndpoint { host: string; port: number }
const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443, "socks:": 1080, "socks4:": 1080, "socks5:": 1080, "socks5h:": 1080 };

/** Never retain URL userinfo, paths or queries in probe arguments or error messages. */
export function proxyEndpoints(env: Record<string, string>): ProxyEndpoint[] {
  const endpoints = new Map<string, ProxyEndpoint>();
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    let url: URL;
    try { url = new URL(value); }
    catch { throw new BridgeError("invalid_proxy_configuration", `${key} must be an absolute proxy URL`); }
    const defaultPort = DEFAULT_PORTS[url.protocol];
    if (!defaultPort || !url.hostname) {
      throw new BridgeError("invalid_proxy_configuration", `${key} must use an HTTP, HTTPS or SOCKS proxy URL`);
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const port = url.port ? Number(url.port) : defaultPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BridgeError("invalid_proxy_configuration", `${key} has an invalid proxy port`);
    }
    endpoints.set(JSON.stringify([host, port]), { host, port });
  }
  return [...endpoints.values()];
}

// The check deliberately opens only a TCP socket to the proxy. It sends no credentials, HTTP
// requests or authentication traffic, and does not imply that any external login endpoint works.
const NODE_PROBE = `
const net = require('node:net');
const endpoints = JSON.parse(process.argv[1]);
const timeout = Number(process.argv[2]);
Promise.all(endpoints.map(endpoint => new Promise((resolve, reject) => {
  const socket = net.createConnection({host: endpoint.host, port: endpoint.port});
  const timer = setTimeout(() => { socket.destroy(); reject({...endpoint, code: 'ETIMEDOUT'}); }, timeout);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
  socket.once('error', error => { clearTimeout(timer); socket.destroy(); reject({...endpoint, code: error.code || 'CONNECTION_FAILED'}); });
}))).then(() => process.exit(0), failure => { console.log(JSON.stringify(failure)); process.exit(1); });
`;
const PYTHON_PROBE = `
import concurrent.futures, json, os, socket, sys
endpoints = json.loads(sys.argv[1])
timeout = int(sys.argv[2]) / 1000

def check(endpoint):
    try:
        with socket.create_connection((endpoint['host'], endpoint['port']), timeout=timeout):
            return None
    except socket.gaierror:
        code = 'DNS_LOOKUP_FAILED'
    except TimeoutError:
        code = 'ETIMEDOUT'
    except OSError as error:
        code = 'ECONNREFUSED' if isinstance(error, ConnectionRefusedError) else 'CONNECTION_FAILED'
    return dict(endpoint, code=code)

pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(endpoints))
for future in concurrent.futures.as_completed([pool.submit(check, endpoint) for endpoint in endpoints]):
    failure = future.result()
    if failure:
        print(json.dumps(failure), flush=True)
        os._exit(1)
pool.shutdown()
`;
const PROBE_SHELL = 'if command -v node >/dev/null 2>&1; then exec node -e "$1" "$3" "$4"; ' +
  'elif command -v python3 >/dev/null 2>&1; then exec python3 -c "$2" "$3" "$4"; ' +
  'else exit 127; fi';

/** Image runtimes may be Node (CodeBuddy/Codex) or Python (Agy). No curl dependency. */
export function proxyProbeProgram(endpoints: ProxyEndpoint[], timeoutMs: number): string[] {
  return ["/bin/sh", "-c", PROBE_SHELL, "proxy-preflight", NODE_PROBE, PYTHON_PROBE,
    JSON.stringify(endpoints), String(timeoutMs)];
}
