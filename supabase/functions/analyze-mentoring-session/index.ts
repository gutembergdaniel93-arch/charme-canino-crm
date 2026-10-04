/**
 * analyze-mentoring-session — Gemini pós-mentoria.
 * Lê transcrição + perguntas + NPS e gera resumo, temas, insights.
 * Salva em mentoring_sessions.metadata.ai_analysis.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_TRANSCRIPT_SEGMENTS = 600;

const jsonResponse = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function smartTruncateTranscript(segments: any[]): { text: string; truncated: boolean; originalCount: number } {
  const finalSegments = segments.filter((t: any) => t.is_final);
  const originalCount = finalSegments.length;

  if (finalSegments.length <= MAX_TRANSCRIPT_SEGMENTS) {
    return {
      text: finalSegments.map((t: any) => `[${t.speaker}] ${t.text}`).join("\n"),
      truncated: false,
      originalCount,
    };
  }

  // Take first 300 + last 300 to capture intro and conclusion
  const half = Math.floor(MAX_TRANSCRIPT_SEGMENTS / 2);
  const first = finalSegments.slice(0, half);
  const last = finalSegments.slice(-half);
  const skipped = originalCount - MAX_TRANSCRIPT_SEGMENTS;

  const firstText = first.map((t: any) => `[${t.speaker}] ${t.text}`).join("\n");
  const lastText = last.map((t: any) => `[${t.speaker}] ${t.text}`).join("\n");

  return {
    text: `${firstText}\n\n[... ${skipped} segmentos omitidos por extensão — sessão muito longa ...]\n\n${lastText}`,
    truncated: true,
    originalCount,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { session_id } = await req.json();
    if (!session_id) return jsonResponse({ error: "session_id obrigatório" }, 400);
    if (!GEMINI_API_KEY) return jsonResponse({ error: "GEMINI_API_KEY not configured" }, 500);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // 1. Busca session + transcrição + perguntas + NPS
    const [sessionRes, questionsRes, npsRes, participantsRes] = await Promise.all([
      supabase.from("mentoring_sessions").select("*").eq("id", session_id).maybeSingle(),
      supabase.from("mentoring_questions").select("*").eq("session_id", session_id).order("submitted_at"),
      supabase.from("mentoring_nps").select("*").eq("session_id", session_id),
      supabase.from("mentoring_participants").select("member_email, member_name, entered_at, left_at").eq("session_id", session_id),
    ]);

    const session = sessionRes.data;
    if (!session) return jsonResponse({ error: "Session não encontrada" }, 404);

    const questions = questionsRes.data || [];
    const nps = npsRes.data || [];
    const participants = participantsRes.data || [];
    const transcript = (session.transcriptions || []) as any[];

    // Helper: sync to PAIN regardless of analysis result
    const syncToPain = async (analysisMetadata?: any) => {
      try {
        const callType = (session.title || '').toLowerCase().includes('hotseat') ? 'hotseat' : 'support';
        const metadataToSync = analysisMetadata || session.metadata || {};
        await supabase.functions.invoke('proxy-external-webhook', {
          body: {
            action: 'sync-mentoring',
            payload: {
              mentoring_session_id: session_id,
              title: session.title,
              description: session.description,
              type: callType,
              status: session.status || 'completed',
              scheduled_at: session.scheduled_at,
              started_at: session.started_at,
              ended_at: session.ended_at,
              recording_url: session.recording_url,
              recording_status: session.recording_status,
              transcriptions: session.transcriptions,
              metadata: metadataToSync,
            },
          },
        });
        console.log(`[analyze] Synced to PAIN: ${session_id}`);
        return true;
      } catch (syncErr: any) {
        console.error(`[analyze] PAIN sync failed:`, syncErr?.message);
        return false;
      }
    };

    if (transcript.length === 0) {
      // Still sync to PAIN (recording, status, etc) even without transcript
      const synced = await syncToPain();
      return jsonResponse({ warning: "Sem transcrição — análise pulada, sync enviado", session_id, synced }, 200);
    }

    // 2. Monta prompt (com truncamento inteligente para sessões longas)
    const { text: transcriptText, truncated, originalCount } = smartTruncateTranscript(transcript);
    if (truncated) {
      console.log(`[analyze] Transcript truncated: ${originalCount} → ${MAX_TRANSCRIPT_SEGMENTS} segments`);
    }

    const questionsText = questions.length > 0
      ? questions.map((q: any) => `• ${q.member_name || q.member_email}: "${q.question}" [${q.status}]`).join("\n")
      : "(nenhuma pergunta formal)";

    const npsText = nps.length > 0
      ? `NPS: ${(nps.reduce((a: number, n: any) => a + (n.score || 0), 0) / nps.length).toFixed(1)} (n=${nps.length})\n` +
        nps.filter((n: any) => n.comment).map((n: any) => `• [${n.score}] ${n.comment}`).join("\n")
      : "(NPS não coletado)";

    const truncationNote = truncated
      ? `\nNOTA: A transcrição foi resumida (${originalCount} segmentos originais, mostrando primeiros e últimos ${MAX_TRANSCRIPT_SEGMENTS / 2}). Analise com base no conteúdo disponível.`
      : "";

    const prompt = `Você é um analista sênior de mentoria/treinamento. Analise essa sessão de mentoria e gere insights pro mentor melhorar.

SESSÃO: "${session.title}"
Descrição: ${session.description || "(sem descrição)"}
Duração: ${session.started_at && session.ended_at ? Math.round((new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 60000) + " min" : "?"}
Participantes: ${participants.length}${truncationNote}

============================================================
TRANSCRIÇÃO${truncated ? " (RESUMIDA)" : " COMPLETA"} (do que foi falado)
============================================================
${transcriptText}

============================================================
PERGUNTAS ENVIADAS
============================================================
${questionsText}

============================================================
FEEDBACK NPS
============================================================
${npsText}

============================================================
GERE JSON:
============================================================
{
  "summary": "Resumo em 3-4 linhas do que foi a mentoria (tema principal, como fluiu, pontos fortes).",
  "topics": [
    { "title": "Título curto do tópico", "description": "O que foi dito sobre ele em 1-2 linhas" }
  ],
  "key_insights": [
    "Insight importante que saiu da mentoria (em bullet)"
  ],
  "questions_summary": [
    { "question": "pergunta exata", "author": "nome", "answered": true/false, "notes": "se respondida, resumo da resposta; se não, sugestão" }
  ],
  "student_engagement": "alto" | "medio" | "baixo",
  "next_mentoring_ideas": [
    "Sugestão de tema/abordagem pra próxima mentoria baseada no que ficou claro"
  ],
  "highlights": [
    { "timestamp_approx": "~10min", "quote": "trecho marcante literal", "why": "por que importa" }
  ]
}

REGRAS:
- Cite TRECHOS REAIS da transcrição (entre aspas) quando relevante
- Seja específico, não genérico
- Idioma: português brasileiro
- Não invente dados — se não há, diga "não disponível"`;

    // 3. Chama Gemini
    let analysis: any = null;
    let geminiError: string | null = null;
    const geminiStart = Date.now();

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
          }),
        },
      );

      if (!resp.ok) {
        geminiError = await resp.text();
        console.error(`[analyze] Gemini HTTP ${resp.status}:`, geminiError);
      } else {
        const geminiData = await resp.json();
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        try {
          analysis = JSON.parse(rawText);
        } catch {
          geminiError = `Invalid JSON: ${rawText.substring(0, 200)}`;
          console.error(`[analyze] Gemini returned invalid JSON`);
        }
      }
    } catch (fetchErr: any) {
      geminiError = fetchErr?.message || String(fetchErr);
      console.error(`[analyze] Gemini fetch error:`, geminiError);
    }

    // 4. Save analysis if Gemini succeeded
    let mergedMetadata = session.metadata || {};
    if (analysis) {
      mergedMetadata = { ...mergedMetadata, ai_analysis: { ...analysis, generated_at: new Date().toISOString(), model: GEMINI_MODEL, gemini_ms: Date.now() - geminiStart, transcript_segments: originalCount, truncated } };
      await supabase.from("mentoring_sessions").update({ metadata: mergedMetadata }).eq("id", session_id);
    }

    // 5. ALWAYS sync to PAIN — even if Gemini failed
    const synced = await syncToPain(mergedMetadata);

    if (geminiError) {
      return jsonResponse({ success: false, error: "Gemini failed", details: geminiError, synced, session_id }, 500);
    }

    return jsonResponse({ success: true, analysis, synced, transcript_truncated: truncated, transcript_segments: originalCount });
  } catch (err: any) {
    console.error("[analyze-mentoring-session] erro:", err);
    return jsonResponse({ error: err?.message || String(err) }, 500);
  }
});
