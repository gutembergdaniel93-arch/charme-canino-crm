import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken } from "https://esm.sh/livekit-server-sdk@2.7.2";

const allowedOrigin = Deno.env.get("CRM_PUBLIC_ORIGIN") || "*";
const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = Deno.env.get("LIVEKIT_API_KEY");
    const apiSecret = Deno.env.get("LIVEKIT_API_SECRET");
    const wsUrl = Deno.env.get("LIVEKIT_WS_URL");
    if (!supabaseUrl || !anonKey || !serviceKey || !apiKey || !apiSecret || !wsUrl) {
      return json({ error: "LiveKit server is not configured" }, 503);
    }

    const body = await req.json();
    const roomName = String(body.room_name || body.roomName || "").trim();
    const participantName = String(body.participant_name || body.participantName || "").trim().slice(0, 80);
    const requestedRole = String(body.role || "guest");
    const role = ["host", "guest", "observer", "mentor", "student"].includes(requestedRole) ? requestedRole : "guest";
    if (!/^[a-zA-Z0-9_-]{8,160}$/.test(roomName) || participantName.length < 2) {
      return json({ error: "invalid room or participant" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const [{ data: meeting }, { data: mentoring }] = await Promise.all([
      admin.from("meetings").select("id, tenant_id, status, ended_at").eq("livekit_room_name", roomName).maybeSingle(),
      admin.from("mentoring_sessions").select("id, tenant_id, status, ended_at").eq("livekit_room_name", roomName).maybeSingle(),
    ]);
    const resource = meeting || mentoring;
    if (!resource || resource.ended_at || ["completed", "cancelled"].includes(resource.status)) {
      return json({ error: "room not available" }, 404);
    }

    const privileged = role === "host" || role === "mentor" || role === "observer";
    let userId: string | null = null;
    if (privileged) {
      const authorization = req.headers.get("Authorization") || "";
      if (!authorization.startsWith("Bearer ")) return json({ error: "authentication required" }, 401);
      const authClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false },
      });
      const { data: { user }, error } = await authClient.auth.getUser();
      if (error || !user) return json({ error: "invalid session" }, 401);
      const userTenant = user.app_metadata?.tenant_id || "00000000-0000-0000-0000-000000000001";
      if (String(resource.tenant_id) !== String(userTenant)) return json({ error: "forbidden" }, 403);
      userId = user.id;
    }

    const suppliedIdentity = String(body.participant_identity || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    const identity = suppliedIdentity || `${role}-${crypto.randomUUID()}`;
    const metadata = {
      ...(typeof body.metadata === "object" && body.metadata ? body.metadata : {}),
      tenant_id: resource.tenant_id,
      meeting_id: meeting?.id || undefined,
      mentoring_session_id: mentoring?.id || undefined,
      user_id: userId || undefined,
      role,
    };
    const token = new AccessToken(apiKey, apiSecret, { identity, name: participantName, metadata: JSON.stringify(metadata) });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: role !== "observer",
      canSubscribe: true,
      canPublishData: role !== "observer",
      roomAdmin: role === "host" || role === "mentor",
      hidden: role === "observer",
    });

    return json({ token: await token.toJwt(), identity, url: wsUrl, ws_url: wsUrl });
  } catch (error) {
    console.error("[livekit-token]", error);
    return json({ error: "unable to create room token" }, 500);
  }
});
