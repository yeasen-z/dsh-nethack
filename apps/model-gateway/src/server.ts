/**
 * apps/model-gateway — optional provider proxy skeleton.
 *
 * Purpose (handoff section 4): keep shared credentials OUT of the browser
 * bundle. The gateway forwards structured decision requests to one upstream
 * provider and returns AgentDecision JSON; a backend LLM response is only a
 * PROPOSAL until the middleware validates it locally.
 *
 * Status: skeleton. No API key is read or required unless MODE=openai-compatible.
 * Run: npm run gateway   (MODE=echo by default — safe for local dev)
 */
import http from "node:http";
import type { AgentDecision, ProviderResult } from "@nhchat/agent";

const PORT = Number(process.env.PORT ?? 8787);
const MODE = process.env.GATEWAY_MODE ?? "echo"; // "echo" | "openai-compatible"

// Credentials are SERVER-managed via env; never bundled to the browser.
const UPSTREAM_URL = process.env.LLM_UPSTREAM_URL ?? "";
const UPSTREAM_KEY = process.env.LLM_API_KEY ?? "";
const MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";

const SYSTEM_PROMPT = `You are the NetHack-Chat agent. You receive a player-visible observation snapshot, capabilities, the user request, recent messages, and effective task constraints. Reply with EXACTLY ONE JSON object of the form:
  {"type":"message","text":string}
| {"type":"clarify","question":string}
| {"type":"action","action":GameAction,"explanation"?:string}
| {"type":"skill","skill":SkillSpec,"explanation"?:string}
Only use actions listed in available_actions. Never invent engine functions, raw keys, or unsupported fields. Do not reveal hidden reasoning.`;

async function decideEcho(body: unknown): Promise<ProviderResult> {
  const b = body as { userText?: string };
  return {
    ok: true,
    usage: { latency_ms: 0 },
    decision: {
      type: "message",
      text: `[gateway echo] received "${b?.userText ?? ""}". Set GATEWAY_MODE=openai-compatible + LLM_* env vars to connect a real provider.`,
    } satisfies AgentDecision,
  };
}

async function decideOpenAI(body: unknown, signal: AbortSignal): Promise<ProviderResult> {
  if (!UPSTREAM_URL || !UPSTREAM_KEY) {
    return { ok: false, error: "LLM_UPSTREAM_URL / LLM_API_KEY not configured on server" };
  }
  const started = Date.now();
  try {
    const resp = await fetch(UPSTREAM_URL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${UPSTREAM_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(body) },
        ],
      }),
    });
    if (!resp.ok) return { ok: false, error: `upstream ${resp.status}` };
    const json = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    let decision: AgentDecision;
    try {
      decision = JSON.parse(raw) as AgentDecision;
    } catch {
      // Malformed output => explanation, no runtime input (validated again client-side anyway).
      return { ok: false, error: "provider returned non-JSON output" };
    }
    return { ok: true, decision, usage: { ...json.usage, latency_ms: Date.now() - started } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const server = http.createServer(async (req, res) => {
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true, mode: MODE });
  if (req.method === "POST" && req.url === "/decide") {
    let buf = "";
    for await (const chunk of req) buf += chunk;
    let body: unknown;
    try {
      body = JSON.parse(buf);
    } catch {
      return send(400, { ok: false, error: "invalid JSON body" });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const result =
      MODE === "openai-compatible" ? await decideOpenAI(body, controller.signal) : await decideEcho(body);
    clearTimeout(timeout);
    return send(result.ok ? 200 : 502, result);
  }
  send(404, { ok: false, error: "not found" });
});

server.listen(PORT, () => {
  console.log(`model-gateway listening on :${PORT} (mode=${MODE})`);
  console.log("NOTE: responses are PROPOSALS only; the middleware re-validates everything locally.");
});
