import { describe, expect, it } from "vitest";
import { AcpClient } from "../src/acp";
import { getAdapter } from "../src/adapters";

function clientFor(legacy = false, ignoreEffort = false): AcpClient {
  const script = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let model = 'm1', effort = 'low';
const options = () => [
 { id:'model', type:'select', currentValue:model, options:[{value:'m1',name:'Model One'},{value:'m2',name:'Model Two'}] },
 { id:'reasoning_effort', type:'select', currentValue:effort, options:(model === 'm2' ? ['low'] : ['low','high']).map(value=>({value})) }
];
rl.on('line', line => {
 const msg = JSON.parse(line), p = msg.params;
 const reply = result => send({jsonrpc:'2.0',id:msg.id,result});
 const fail = (code,message) => send({jsonrpc:'2.0',id:msg.id,error:{code,message}});
 if(msg.method==='initialize') reply({protocolVersion:1});
 else if(msg.method==='session/new') reply({sessionId:'s1',models:{currentModelId:'m1[low]',availableModels:[{modelId:'m1[low]',name:'Model One (low)'},{modelId:'m1[high]',name:'Model One (high)'},{modelId:'m2[low]',name:'Model Two (low)'}]},...(${legacy} ? {} : {configOptions:options()})});
 else if(msg.method==='session/set_config_option') {
  if(${legacy} && p.configId==='model') { fail(-32601,'unsupported'); return; }
  if(p.configId==='model') {
   if(!['m1','m2'].includes(p.value)) { fail(-32602,'invalid model'); return; }
   model=p.value;
   if(model==='m2') effort='low';
  } else if(p.configId==='reasoning_effort') effort=${ignoreEffort} ? 'low' : p.value;
  reply(${legacy} ? {} : {configOptions:options()});
 } else if(msg.method==='session/set_model') {
  if(!${legacy}) { fail(-32603,'modern harness must not use legacy selector'); return; }
  const match=p.modelId.match(/^(.+)\\[(.+)\\]$/);
  if(!match) {fail(-32602,'expected model[effort]');return;}
  model=match[1];effort=match[2];reply({});
 } else if(msg.method==='test/state') reply({model,effort});
 else fail(-32601,'unknown method');
});`;
  return new AcpClient({ command: process.execPath, args: ["-e", script], modelAdapter: getAdapter("codex") });
}

describe("ACP harness-owned model selection", () => {
  it("uses canonical model IDs, refreshes options and retains state on a rejected switch", async () => {
    const client = clientFor();
    try {
      await client.start();
      await client.openSession();
      expect(client.listModels()).toEqual([{ id: "m1", name: "Model One" }, { id: "m2", name: "Model Two" }]);
      await client.setModel("m2");
      expect(client.modelId).toBe("m2");
      expect(client.modelName).toBe("Model Two");
      expect(client.configOptions()?.find(o => o.id === "reasoning_effort")?.options).toEqual([{ value: "low" }]);
      await expect(getAdapter("codex").setThinkingLevel({ sessionId: () => "s1", initializeResponse: () => ({}), request: (m,p) => client.request(m,p) }, "s1", "m2", "high", client.configOptions())).rejects.toThrow(/not supported/);
      await client.setModel("m1");
      await client.request("session/set_config_option", { sessionId: "s1", configId: "reasoning_effort", value: "high" });
      expect(client.configOptions()?.find(o => o.id === "reasoning_effort")?.currentValue).toBe("high");
      const before = client.configOptions();
      await expect(client.setModel("bad-model")).rejects.toMatchObject({ code: -32602 });
      expect(client.modelId).toBe("m1");
      expect(client.configOptions()).toEqual(before);
    } finally { await client.close(); }
  });

  it("retains the actual low readback when a harness ignores a requested high effort", async () => {
    const client = clientFor(false, true);
    try {
      await client.start(); await client.openSession(); await client.setModel("m1");
      await expect(getAdapter("codex").setThinkingLevel({
        sessionId: () => client.sessionId,
        initializeResponse: () => client.initializeResponse,
        request: (method, params) => client.request(method, params),
      }, "s1", "m1", "high", client.configOptions())).rejects.toThrow(/harness reported reasoning_effort/);
      expect(client.configOptions()?.find(o => o.id === "reasoning_effort")?.currentValue).toBe("low");
      expect((await client.request("test/state", {})).result).toEqual({ model: "m1", effort: "low" });
    } finally { await client.close(); }
  });

  it("internally converts bare IDs for legacy Codex without hardcoding or losing effort", async () => {
    const client = clientFor(true);
    try {
      await client.start(); await client.openSession();
      expect(client.listModels()).toEqual([{ id: "m1", name: "Model One" }, { id: "m2", name: "Model Two" }]);
      await client.setModel("m2");
      expect(client.modelId).toBe("m2");
      expect((await client.request("test/state", {})).result).toEqual({ model: "m2", effort: "low" });
      await client.setModel("m1"); // The cached public ID no longer contains [low].
      expect(client.modelId).toBe("m1");
      expect((await client.request("test/state", {})).result).toEqual({ model: "m1", effort: "low" });
      await client.request("session/set_config_option", { sessionId: "s1", configId: "reasoning_effort", value: "high" });
      await client.setModel("m2");
      expect(client.modelId).toBe("m2");
      expect((await client.request("test/state", {})).result).toEqual({ model: "m2", effort: "high" });
      await client.setModel("m1[low]"); // Explicit legacy IDs remain backward compatible.
      expect(client.modelId).toBe("m1[low]");
      expect((await client.request("test/state", {})).result).toEqual({ model: "m1", effort: "low" });
    } finally { await client.close(); }
  });
});
