import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { startRuntimeServer } from "../scripts/serve-runtime.mjs";

test("runtime preview serves agent modules and safely proxies the local model gateway", async () => {
  const priorPort = process.env.GATEWAY_PORT;
  let runtimeServer;
  const gateway = http.createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, mode: "echo" }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, decision: { type: "message", text: JSON.parse(body).userText } }));
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  process.env.GATEWAY_PORT = String(gateway.address().port);
  try {
    runtimeServer = await startRuntimeServer(0);
    const origin = `http://127.0.0.1:${runtimeServer.address().port}`;
    const health = await fetch(`${origin}/api/healthz`);
    assert.deepEqual(await health.json(), { ok: true, mode: "echo" });
    const decision = await fetch(`${origin}/api/decide`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userText: "status?" }),
    });
    assert.deepEqual(await decision.json(), { ok: true, decision: { type: "message", text: "status?" } });
    const agentModule = await fetch(`${origin}/packages/agent/dist/index.js`);
    assert.equal(agentModule.status, 200);
    assert.match(await agentModule.text(), /orchestrate\.js/);
    const providerModule = await fetch(`${origin}/packages/agent/dist/orchestrate.js`);
    assert.match(await providerModule.text(), /HttpGatewayProvider/);
  } finally {
    if (runtimeServer) await new Promise(resolve => runtimeServer.close(resolve));
    await new Promise(resolve => gateway.close(resolve));
    if (priorPort === undefined) delete process.env.GATEWAY_PORT;
    else process.env.GATEWAY_PORT = priorPort;
  }
});
