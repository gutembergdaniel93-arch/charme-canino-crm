// mentoring-public — endpoints públicos pra mentoria (sem JWT do Supabase)
// verify_jwt: false
// - action=info: retorna info da sessão por share_token
// - action=join: cria mentoring_participant + gera token LiveKit
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken } from "https://esm.sh/livekit-server-sdk@2.7.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LIVEKIT_API_KEY = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;
const LIVEKIT_WS_URL = Deno.env.get("LIVEKIT_WS_URL")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { action, share_token, member_name, member_email, member_phone } = await req.json();
    if (!action || !share_token) throw new Error("action and share_token required");

    const { data: session, error } = await supabase
      .from("mentoring_sessions")
      .select("id, tenant_id, title, description, scheduled_at, started_at, ended_at, livekit_room_name, status")
      .eq("share_token", share_token)
      .maybeSingle();
    if (error) throw error;
    if (!session) return new Response(JSON.stringify({ error: "session not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

    if (action === "info") {
      return new Response(JSON.stringify(session), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "join") {
      if (!member_name || !member_email) throw new Error("member_name and member_email required");
      if (session.ended_at || ["completed", "cancelled"].includes(session.status)) {
        return new Response(JSON.stringify({ error: "session is closed" }), {
          status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Cria/reusa participant
      const email = String(member_email).toLowerCase().trim().slice(0, 254);
      const safeName = String(member_name).trim().slice(0, 80);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || safeName.length < 2) {
        return new Response(JSON.stringify({ error: "invalid participant data" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: existing } = await supabase
        .from("mentoring_participants")
        .select("id, lead_id")
        .eq("session_id", session.id)
        .eq("member_email", email)
        .maybeSingle();

      let participantId = existing?.id;
      let leadId = existing?.lead_id;

      if (!participantId) {
        // Opcional: tenta linkar com lead existente por email
        const { data: lead } = await supabase.from("leads").select("id").eq("tenant_id", session.tenant_id).eq("email", email).maybeSingle();
        leadId = lead?.id || null;

        const { data: created } = await supabase
          .from("mentoring_participants")
          .insert({
            tenant_id: session.tenant_id,
            session_id: session.id,
            member_email: email,
            member_name: safeName,
            member_phone: member_phone || null,
            lead_id: leadId,
            via_public_link: true,
          })
          .select("id")
          .single();
        participantId = created!.id;
      } else {
        // Se saiu antes, reabre presença
        await supabase.from("mentoring_participants").update({
          left_at: null,
          entered_at: new Date().toISOString(),
          member_name: safeName,
          member_phone: member_phone || null,
        }).eq("id", participantId);
      }

      // Token LiveKit
      const identity = `guest-${crypto.randomUUID()}`;
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity,
        name: safeName,
        metadata: JSON.stringify({
          email,
          member_name: safeName,
          participant_id: participantId,
          lead_id: leadId,
          tenant_id: session.tenant_id,
        }),
      });
      at.addGrant({
        roomJoin: true,
        room: session.livekit_room_name,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
      const token = await at.toJwt();

      return new Response(JSON.stringify({
        token,
        url: LIVEKIT_WS_URL,
        ws_url: LIVEKIT_WS_URL,
        session_id: session.id,
        participant_id: participantId,
        room_name: session.livekit_room_name,
        member_name: safeName,
        member_email: email,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    throw new Error(`unknown action: ${action}`);
  } catch (err) {
    console.error("[mentoring-public] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
