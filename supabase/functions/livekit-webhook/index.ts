// livekit-webhook — recebe eventos do LiveKit (room_started, participant_joined, egress_ended, room_finished)
// - Inicia gravação quando primeiro participante entra
// - Atualiza recording_url quando egress termina
// - Auto-restart egress em salas longas (EGRESS_LIMIT_REACHED)
// verify_jwt: false (LiveKit assina com HMAC próprio)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EgressClient, EncodedFileOutput, EncodedFileType, RoomServiceClient, S3Upload, WebhookReceiver } from "https://esm.sh/livekit-server-sdk@2.7.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, livekit-signature",
};

const LIVEKIT_URL = Deno.env.get("LIVEKIT_URL")!; // https://xxx.livekit.cloud
const LIVEKIT_API_KEY = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;

const R2_ACCESS_KEY = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_BUCKET = Deno.env.get("R2_BUCKET") || "meeting-recordings";
const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT")!; // https://<account>.r2.cloudflarestorage.com
const R2_REGION = "auto";
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL")!; // https://pub-xxxxx.r2.dev

const receiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const egressClient = new EgressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function startEgress(roomName: string): Promise<string> {
  const filename = `${roomName}-${Date.now()}.mp4`;
  const fileOutput = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: filename,
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: R2_ACCESS_KEY,
        secret: R2_SECRET_KEY,
        bucket: R2_BUCKET,
        endpoint: R2_ENDPOINT,
        region: R2_REGION,
        forcePathStyle: true,
      }),
    },
  });
  await egressClient.startRoomCompositeEgress(
    roomName,
    { file: fileOutput },
    { layout: "grid" },
  );
  return `${R2_PUBLIC_URL}/${filename}`;
}

async function appendSegmentToMeeting(roomName: string, publicUrl: string, table: "meetings" | "mentoring_sessions") {
  const { data } = await supabase.from(table).select("id, metadata").eq("livekit_room_name", roomName).maybeSingle();
  if (!data) return;
  const existing = (data.metadata?.recording_segments as string[]) || [];
  await supabase.from(table).update({
    metadata: { ...(data.metadata || {}), recording_segments: [...existing, publicUrl] },
  }).eq("id", data.id);
}

async function detectTable(roomName: string): Promise<"meetings" | "mentoring_sessions" | null> {
  const { data: m1 } = await supabase.from("meetings").select("id").eq("livekit_room_name", roomName).maybeSingle();
  if (m1) return "meetings";
  const { data: m2 } = await supabase.from("mentoring_sessions").select("id").eq("livekit_room_name", roomName).maybeSingle();
  if (m2) return "mentoring_sessions";
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.text();
    const authHeader = req.headers.get("authorization") || "";
    const event = await receiver.receive(body, authHeader);
    console.log(`[livekit-webhook] event=${event.event} room=${event.room?.name}`);

    const roomName = event.room?.name;
    if (!roomName) return new Response("no room", { headers: corsHeaders });

    const table = await detectTable(roomName);
    if (!table) {
      console.warn(`[livekit-webhook] room ${roomName} not found in DB`);
      return new Response("ok", { headers: corsHeaders });
    }

    if (event.event === "room_started" || event.event === "participant_joined") {
      // Inicia egress se ainda não iniciou
      const { data: row } = await supabase.from(table)
        .select("id, recording_status, started_at").eq("livekit_room_name", roomName).single();

      if (row && row.recording_status === "pending") {
        try {
          const publicUrl = await startEgress(roomName);
          await supabase.from(table).update({
            recording_status: "recording",
            recording_url: publicUrl,
            started_at: row.started_at || new Date().toISOString(),
            metadata: { recording_segments: [publicUrl] },
            status: "live",
          }).eq("id", row.id);
        } catch (err) {
          console.error("[livekit-webhook] startEgress failed:", err);
        }
      }
    }

    if (event.event === "egress_ended") {
      const err = event.egressInfo?.error;
      // Auto-restart: LiveKit tem limite de duração por egress (~4h)
      if (err && (err.includes("Session limit reached") || err.includes("Egress limit"))) {
        try {
          const participants = await roomService.listParticipants(roomName);
          if (participants.length > 0) {
            console.log(`[livekit-webhook] EGRESS_LIMIT — restarting for ${roomName}`);
            const newUrl = await startEgress(roomName);
            await appendSegmentToMeeting(roomName, newUrl, table);
          }
        } catch (err) {
          console.error("[livekit-webhook] restart failed:", err);
        }
      } else if (event.egressInfo?.status?.toString().includes("COMPLETE")) {
        // Marca completed
        await supabase.from(table).update({ recording_status: "completed" }).eq("livekit_room_name", roomName);
      }
    }

    if (event.event === "room_finished") {
      await supabase.from(table).update({
        ended_at: new Date().toISOString(),
        status: "completed",
      }).eq("livekit_room_name", roomName);
    }

    return new Response("ok", { headers: corsHeaders });
  } catch (err) {
    console.error("[livekit-webhook] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
