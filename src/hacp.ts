/** Service entrypoint. Configuration comes from HARNESS_ACP_BRIDGE_CONFIG or defaults. */
import { loadConfig } from "./logic/config.js";
import { HarnessHttpServer } from "./http/server.js";
import { errorInfo } from "./logic/errors.js";

const server = new HarnessHttpServer(loadConfig());
let stopping = false;
const stop = (): void => {
  if (stopping) return; stopping = true;
  void server.stop().then(() => { process.exitCode = 0; }).catch(error => { process.stderr.write(`${JSON.stringify(errorInfo(error))}\n`); process.exitCode = 1; });
};
process.once("SIGTERM", stop); process.once("SIGINT", stop);
server.start().then(address => { process.stderr.write(`HTTP server listening at ${address.host}:${address.port}\n`); }).catch(error => {
  process.stderr.write(`${JSON.stringify(errorInfo(error))}\n`); process.exitCode = 1;
});
