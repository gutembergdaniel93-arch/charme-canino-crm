// mirror-ig-media v1 — baixa URL do IG (que expira), salva no bucket instagram-media (público),
// retorna URL pública estável. Atualiza coluna `stored_*` indicada na tabela.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const BUCKET = "instagram-media";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function mirrorOne(supabase: any, req: any) {
  try {
    if (!req.url || !req.path) return { ok: false, error: "url e path obrigatórios" };
    const r = await fetch(req.url, { headers: { "User-Agent": UA, "Accept": "image/*,video/*,*/*" } });
    if (!r.ok) return { ok: false, error: `fetch ${r.status}` };
    const buf = new Uint8Array(await r.arrayBuffer());
    const contentType = r.headers.get("content-type") || "image/jpeg";
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(req.path, buf, { contentType, upsert: true });
    if (upErr) return { ok: false, error: `upload: ${upErr.message}` };
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(req.path);
    if (!data?.publicUrl) return { ok: false, error: "no_public_url" };
    if (req.table && req.row_id && req.column) {
      await supabase.from(req.table).update({ [req.column]: data.publicUrl }).eq("id", req.row_id);
    }
    return { ok: true, public_url: data.publicUrl };
  } catch (e: any) { return { ok: false, error: e.message || String(e) }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json();
    const items = Array.isArray(body) ? body : (body?.items || [body]);
    const results = await Promise.all(items.map((it: any) => mirrorOne(supabase, it)));
    return new Response(JSON.stringify({ ok: true, count: results.length, results }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
