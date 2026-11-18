// PageSecretary AI proxy on Netlify -> Google Gemini
// Accepts the same body the old Render proxy took (Anthropic Messages style):
//   { system?, messages:[{role, content}], max_tokens?, temperature?, model? }
// Returns Anthropic-style JSON so the front end keeps working:
//   { content:[{type:"text", text}], text, model, stop_reason }

// Model tried first, then automatic fallbacks if Google says a model is gone (404).
const PRIMARY = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const FALLBACKS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];
const MODELS = [PRIMARY, ...FALLBACKS.filter(m => m !== PRIMARY)];
let MODEL = PRIMARY; // last model that worked
const ALLOWED = (process.env.ALLOWED_ORIGIN || "https://page-secretary.netlify.app")
  .split(",").map(s => s.trim());

function cors(req) {
  const origin = req.headers.get("origin") || "";
  const ok = ALLOWED.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED[0],
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const json = (req, status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(req) },
  });

function blocksToText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(b => (typeof b === "string" ? b : b?.text || "")).join("\n");
  return String(c ?? "");
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method === "GET") {
    return json(req, 200, { ok: true, provider: "gemini", model: MODEL, key_set: !!process.env.GEMINI_API_KEY });
  }
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(req, 500, { error: "GEMINI_API_KEY not set in Netlify environment variables" });

  let body;
  try { body = await req.json(); } catch { return json(req, 400, { error: "Invalid JSON" }); }

  // Accept a bare {prompt} too, just in case
  const msgs = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : [{ role: "user", content: body.prompt || "" }];

  const contents = msgs.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: blocksToText(m.content) }],
  }));

  const payload = {
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(Math.max(Number(body.max_tokens) || 1024, 4096), 8192),
      temperature: body.temperature ?? 0.7,
    },
  };
  const sys = body.system ? blocksToText(body.system) : "";
  if (sys) payload.systemInstruction = { parts: [{ text: sys }] };

  try {
    let lastErr = null;
    for (const m of MODELS) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(payload),
        }
      );
      const data = await r.json().catch(() => ({}));
      if (r.status === 404) {            // model retired/renamed: try the next one
        lastErr = { status: 404, message: data?.error?.message || "Model not found", model: m };
        continue;
      }
      if (!r.ok) {
        return json(req, r.status, { error: data?.error?.message || "Gemini error", model: m, detail: data?.error });
      }
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
      if (!text) {
        return json(req, 502, { error: "Empty response from Gemini", model: m, finishReason: cand?.finishReason, feedback: data.promptFeedback });
      }
      MODEL = m;
      return json(req, 200, {
        content: [{ type: "text", text }],
        text,
        model: m,
        stop_reason: cand?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
      });
    }
    return json(req, 502, { error: "No Gemini model available: " + (lastErr?.message || "unknown"), tried: MODELS });
  } catch (e) {
    return json(req, 502, { error: "Proxy failure: " + e.message });
  }
};

export const config = { path: "/ai" };
