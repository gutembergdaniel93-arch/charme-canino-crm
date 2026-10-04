// recover-meeting-transcription — recupera transcrição de uma call via AssemblyAI batch API
// Uso: quando o LiveKit agent falhou de transcrever ao vivo, submete o áudio da gravação
// no R2 pro AssemblyAI e reconstrói meetings.transcriptions
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ASSEMBLY_KEY = Deno.env.get("ASSEMBLYAI_API_KEY")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function pollTranscript(transcript_id: string, maxWaitMs = 15 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`https://api.assemblyai.com/v2/transcript/${transcript_id}`, {
      headers: { authorization: ASSEMBLY_KEY },
    });
    const d = await res.json();
    if (d.status === "completed") return d;
    if (d.status === "error") throw new Error(d.error || "AssemblyAI error");
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error("Timeout");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { meeting_id, transcript_id: existingTid, table = "meetings" } = await req.json();
    if (!meeting_id) throw new Error("meeting_id required");
    if (!["meetings", "mentoring_sessions"].includes(table)) throw new Error("invalid table");

    // Se transcript_id já vem, só faz o merge no banco
    let transcriptId = existingTid;

    if (!transcriptId) {
      const { data: row } = await supabase.from(table).select("recording_url").eq("id", meeting_id).single();
      if (!row?.recording_url) throw new Error("no recording_url");

      const submitRes = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { authorization: ASSEMBLY_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          audio_url: row.recording_url,
          speaker_labels: true,
          language_code: "pt",
        }),
      });
      const submit = await submitRes.json();
      transcriptId = submit.id;
    }

    const t = await pollTranscript(transcriptId);

    // Converte utterances do AssemblyAI pro formato { speaker, text, is_final, timestamp }
    const utterances = t.utterances || [];
    const lines = utterances.map((u: any) => ({
      speaker: u.speaker || "Participante",
      text: u.text,
      is_final: true,
      timestamp: u.start,
    }));

    // Se já havia falas parciais no banco, faz merge por hash (evita duplicar)
    const { data: existing } = await supabase.from(table).select("transcriptions").eq("id", meeting_id).single();
    const before = ((existing?.transcriptions as any[]) || []).filter((l) => l.is_final);
    const existingKeys = new Set(before.map((l) => `${l.timestamp}:${l.text}`));
    const merged = [...before];
    let delta = 0;
    for (const l of lines) {
      const k = `${l.timestamp}:${l.text}`;
      if (!existingKeys.has(k)) { merged.push(l); delta++; }
    }

    await supabase.from(table).update({ transcriptions: merged }).eq("id", meeting_id);

    return new Response(JSON.stringify({
      ok: true,
      transcript_id: transcriptId,
      recovered_lines: lines.length,
      delta,
      sample_first: lines.slice(0, 1),
      sample_last: lines.slice(-1),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[recover-meeting-transcription] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
