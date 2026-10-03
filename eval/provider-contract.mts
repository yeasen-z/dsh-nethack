import assert from "node:assert/strict";
import test from "node:test";
import { HttpGatewayProvider, type AgentContext } from "@nhchat/agent";

const context = {
  observation: { session_id: "session", turn: 7 } as AgentContext["observation"],
  userText: "wait",
  recentMessages: ["game: ready"],
  effectiveConstraints: { action_requires_user_confirmation: true },
  mode: "suggest",
  session: { secret: "must not be sent" },
} as unknown as AgentContext;

test("gateway provider sends only the serializable player context and accepts a decision envelope", async () => {
  const originalFetch = globalThis.fetch;
  let receivedUrl = "";
  let receivedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    receivedUrl = String(input);
    receivedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, decision: { type: "action", action: { action: "wait" } } }), { status: 200 });
  };
  try {
    const result = await new HttpGatewayProvider().decide(context);
    assert.equal(receivedUrl, "/api/decide");
    assert.equal(receivedBody?.userText, "wait");
    assert.equal("session" in (receivedBody ?? {}), false);
    assert.equal(result.ok, true);
    assert.deepEqual(result.decision, { type: "action", action: { action: "wait" } });
  } finally { globalThis.fetch = originalFetch; }
});

test("gateway provider converts HTTP and malformed-envelope responses into safe failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "no model configured" }), { status: 502 });
    assert.deepEqual(await new HttpGatewayProvider().decide(context), { ok: false, error: "no model configured" });
    globalThis.fetch = async () => new Response(JSON.stringify({ nonsense: true }), { status: 200 });
    assert.deepEqual(await new HttpGatewayProvider().decide(context), { ok: false, error: "gateway returned an invalid decision envelope" });
  } finally { globalThis.fetch = originalFetch; }
});
