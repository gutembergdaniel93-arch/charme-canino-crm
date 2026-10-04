// proxy-external-webhook — encaminha payload pra um sistema externo (LMS, PAIN, etc)
// Uso principal: chamado pela analyze-mentoring-session pra mandar gravação + transcrição
// + análise IA pra plataforma onde os alunos veem depois.
//
// Se você não tem sistema externo, comente a chamada em analyze-mentoring-session.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const EXTERNAL_URL = Deno.env.get("EXTERNAL_WEBHOOK_URL");
    const EXTERNAL_TOKEN = Deno.env.get("EXTERNAL_WEBHOOK_TOKEN");

    if (!EXTERNAL_URL) {
      console.log("[proxy-external-webhook] EXTERNAL_WEBHOOK_URL não setado — pulando sync");
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action, payload } = await req.json();

    const res = await fetch(EXTERNAL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(EXTERNAL_TOKEN ? { Authorization: `Bearer ${EXTERNAL_TOKEN}` } : {}),
      },
      body: JSON.stringify({ action, payload }),
    });

    const text = await res.text();
    console.log(`[proxy-external-webhook] action=${action} status=${res.status}`);

    return new Response(text || JSON.stringify({ ok: res.ok }), {
      status: res.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[proxy-external-webhook] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
