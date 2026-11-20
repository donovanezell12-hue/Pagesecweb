// PageSecretary AI proxy (Netlify Function) — free-tier friendly, multi-provider.
// Same request/response shape the app already uses (Anthropic-style):
//   in : { system?, messages:[{role,content}], max_tokens?, temperature? }
//   out: { content:[{type:"text",text}], text, model, provider, stop_reason }
// Providers are used in this order, only if their key exists in Netlify env vars:
//   1) GROQ_API_KEY   (free tier, no card)      2) GEMINI_API_KEY (optional)
// If one provider/model is down, rate-limited or rejects the key, the next one is tried.

const ALLOWED = (process.env.ALLOWED_ORIGIN || "https://page-secretary.netlify.app").split(",").map(s => s.trim());
const clean = v => (v || "").trim().replace(/^['"]|['"]$/g, "");
const GROQ_MODELS = [process.env.GROQ_MODEL, "openai/gpt-oss-120b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"].filter(Boolean);
const GEMINI_MODELS = [process.env.GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean);

function cors(req) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : ALLOWED[0], "Access-Control-Allow-Headers": "Content-Type",
           "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
const json = (req, status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req) } });
const fail = (req, status, message, extra = {}) => { console.error("[ai]", status, message, JSON.stringify(extra)); return json(req, status, { error: { message, ...extra } }); }; 
const toText = c => typeof c === "string" ? c : Array.isArray(c) ? c.map(b => (typeof b === "string" ? b : b?.text || "")).join("\n") : String(c ?? "");

const providers = () => {
  const list = [];
  const g = clean(process.env.GROQ_API_KEY), m = clean(process.env.GEMINI_API_KEY);
  if (g) list.push({ name: "groq", models: GROQ_MODELS, async call(model, o) {
    const body = { model, temperature: o.temperature, max_tokens: o.maxTokens,
      messages: [...(o.system ? [{ role: "system", content: o.system }] : []), ...o.msgs] };
    if (model.includes("gpt-oss")) body.reasoning_effort = "low";
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + g }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, text: d?.choices?.[0]?.message?.content || "", message: d?.error?.message, finish: d?.choices?.[0]?.finish_reason };
  }});
  if (m) list.push({ name: "gemini", models: GEMINI_MODELS, async call(model, o) {
    const body = { contents: o.msgs.map(x => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] })),
      generationConfig: { maxOutputTokens: o.maxTokens, temperature: o.temperature } };
    if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": m }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    const c = d?.candidates?.[0];
    return { status: r.status, text: (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join(""), message: d?.error?.message, finish: c?.finishReason };
  }});
  return list;
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  const provs = providers();

  if (req.method === "GET") {
    const info = { ok: true, providers: provs.map(p => p.name), key_set: provs.length > 0 };
    if (new URL(req.url).searchParams.get("test")) {
      info.tests = [];
      for (const p of provs) {
        try { const r = await p.call(p.models[0], { system: "", msgs: [{ role: "user", content: "Say OK" }], maxTokens: 200, temperature: 0 });
              info.tests.push({ provider: p.name, model: p.models[0], status: r.status, result: r.text ? "works: " + r.text.slice(0, 30) : (r.message || "no text") }); }
        catch (e) { info.tests.push({ provider: p.name, result: "fetch failed: " + e.message }); }
      }
    }
    return json(req, 200, info);
  }
  if (req.method !== "POST") return fail(req, 405, "POST only");
  if (!provs.length) return fail(req, 500, "No AI key set. Add GROQ_API_KEY in Netlify → Environment variables, then redeploy.");

  let body; try { body = await req.json(); } catch { return fail(req, 400, "Invalid JSON"); }
  const msgs = (Array.isArray(body.messages) && body.messages.length ? body.messages : [{ role: "user", content: body.prompt || "" }])
    .map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: toText(m.content) }));
  const o = { system: body.system ? toText(body.system) : "", msgs, temperature: body.temperature ?? 0.7,
              maxTokens: Math.min(Math.max(Number(body.max_tokens) || 1024, 2048), 6000) };

  let last = null;
  try {
    for (const p of provs) for (const model of p.models) {
      const r = await p.call(model, o);
      if (r.status === 200 && r.text) {
        return json(req, 200, { content: [{ type: "text", text: r.text }], text: r.text, model, provider: p.name,
                                stop_reason: /length|MAX_TOKENS/i.test(r.finish || "") ? "max_tokens" : "end_turn" });
      }
      last = { provider: p.name, model, status: r.status, message: r.message || (r.status === 200 ? "empty reply" : "error") };
      console.error("[ai] try failed", JSON.stringify(last));
      if (r.status === 401 || r.status === 403) break;
    }
    return fail(req, last?.status === 429 ? 429 : 502, `No AI model worked. Last problem (${last?.provider}/${last?.model} ${last?.status}): ${last?.message}`, { last });
  } catch (e) { return fail(req, 502, "Proxy failure: " + e.message); }
};

export const config = { path: "/ai" };