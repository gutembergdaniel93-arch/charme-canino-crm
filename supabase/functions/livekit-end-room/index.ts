// livekit-end-room — encerra sala LiveKit + para egress + marca meeting/mentoring como completed
// Chamada pelo frontend quando o host clica "encerrar reunião"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EgressClient, RoomServiceClient } from "https://esm.sh/livekit-server-sdk@2.7.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LIVEKIT_URL = Deno.env.get("LIVEKIT_URL")!;
const LIVEKIT_API_KEY = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;

const egressClient = new EgressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { room_name } = await req.json();
    if (!room_name) throw new Error("room_name required");

    // O JWT na borda não basta: confirma autorização sobre este recurso via RLS.
    const authorization = req.headers.get("Authorization") || "";
    const scopedClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } },
    );
    const [{ data: allowedMeeting }, { data: allowedMentoring }] = await Promise.all([
      scopedClient.from("meetings").select("id").eq("livekit_room_name", room_name).maybeSingle(),
      scopedClient.from("mentoring_sessions").select("id").eq("livekit_room_name", room_name).maybeSingle(),
    ]);
    if (!allowedMeeting && !allowedMentoring) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Para egresses ativos na sala
    try {
      const egresses = await egressClient.listEgress({ roomName: room_name, active: true });
      for (const e of egresses) {
        try { await egressClient.stopEgress(e.egressId); } catch (err) { console.warn("stop egress fail:", err); }
      }
    } catch (err) { console.warn("[end-room] list egresses fail:", err); }

    // Delete sala (LiveKit desconecta todos)
    try { await roomService.deleteRoom(room_name); } catch (err) { console.warn("[end-room] deleteRoom fail:", err); }

    // Atualiza banco
    const now = new Date().toISOString();
    await supabase.from("meetings").update({ ended_at: now, status: "completed" }).eq("livekit_room_name", room_name);
    await supabase.from("mentoring_sessions").update({ ended_at: now, status: "completed" }).eq("livekit_room_name", room_name);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[livekit-end-room] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
