/**
 * useLiveKitTranscriptionV2 — Consome transcrição NATIVA do LiveKit.
 *
 * Arquitetura:
 * - Agent Python (livekit-agent/main.py) roda no Modal.com
 * - Agent entra em cada sala, captura audio dos participants, transcreve via Deepgram
 * - Agent publica transcrições via LiveKit → chegam no frontend como evento nativo
 * - Este hook apenas escuta `RoomEvent.TranscriptionReceived` e mantém state
 *
 * Formato de saída é IDÊNTICO ao Soniox hoje:
 *   { speaker: 'Você' | 'Lead', text, is_final, timestamp }
 *
 * Assim a edge function analyze-sales-call e o Sales Coach continuam funcionando sem mudança.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Room, RoomEvent, TranscriptionSegment } from 'livekit-client';
import { supabase } from '@/lib/supabase';

const SAVE_INTERVAL_MS = 10000;

export interface TranscriptionEntry {
  speaker: string;       // 'Você' | 'Lead'
  text: string;
  is_final: boolean;
  timestamp: number;
  segment_id?: string;   // pra atualizar interim → final
}

export function useLiveKitTranscriptionV2(
  room: Room | null,
  meetingId: string | null,
  enabled: boolean = true,
  options?: { tableName?: string },
) {
  const tableName = options?.tableName || 'meetings';
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const transcriptionsRef = useRef<TranscriptionEntry[]>([]);
  const [isActive, setIsActive] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Mantém ref sempre atualizado
  useEffect(() => {
    transcriptionsRef.current = transcriptions;
  }, [transcriptions]);

  // Restaurar transcrição salva ao montar (sobrevive F5/reload durante call)
  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from(tableName as any)
        .select('transcriptions')
        .eq('id', meetingId)
        .maybeSingle();
      if (cancelled || !data?.transcriptions) return;
      const saved = Array.isArray(data.transcriptions) ? (data.transcriptions as any[]) : [];
      if (saved.length > 0) {
        setTranscriptions(saved as TranscriptionEntry[]);
        console.log(`[LK-TranscriptionV2] Restauradas ${saved.length} falas do banco (F5 recovery)`);
      }
    })();
    return () => { cancelled = true; };
  }, [meetingId, tableName]);

  // Listener de transcrições nativas do LiveKit
  useEffect(() => {
    if (!room) {
      console.log('[LK-TranscriptionV2] room ainda não conectou');
      setIsActive(false);
      return;
    }
    if (!enabled) {
      console.log('[LK-TranscriptionV2] desabilitado (enabled=false, provider=soniox?)');
      setIsActive(false);
      return;
    }

    console.log('[LK-TranscriptionV2] conectado, aguardando agent entrar na sala...', {
      roomName: room.name,
      localIdentity: room.localParticipant.identity,
      remoteParticipants: room.remoteParticipants.size,
    });

    // Warning se 30s passarem sem receber nenhuma transcrição (agent não entrou ou Deepgram falhou)
    const noTranscriptionWarning = setTimeout(() => {
      console.warn('[LK-TranscriptionV2] ⚠️ 30s sem nenhuma transcrição. Causas possíveis:');
      console.warn('  1. Agent Python (CA_EeBPETpvgkxa) não entrou na sala — ver `lk agent logs`');
      console.warn('  2. Deepgram API key inválida — ver secrets do agent');
      console.warn('  3. Nenhum audio publicado ainda — teste falando algo');
    }, 30000);

    const handleTranscription = (
      segments: TranscriptionSegment[],
      participant?: any,
    ) => {
      clearTimeout(noTranscriptionWarning);
      if (!segments || segments.length === 0) {
        console.log('[LK-TranscriptionV2] evento sem segments');
        return;
      }

      const localIdentity = room.localParticipant.identity;
      const participantIdentity = participant?.identity;
      const speaker = participantIdentity === localIdentity ? 'Você' : 'Lead';

      console.log(`[LK-TranscriptionV2] ${speaker} (${participantIdentity}):`,
        segments.map(s => `${s.final ? '✓' : '...'} "${s.text}"`).join(' | '));

      setTranscriptions((prev) => {
        const next = [...prev];

        for (const segment of segments) {
          // Procura se já existe entry com este segment_id (atualizar interim → final)
          const existingIdx = next.findIndex((t) => t.segment_id === segment.id);

          const entry: TranscriptionEntry = {
            speaker,
            text: segment.text,
            is_final: segment.final,
            timestamp: Date.now(),
            segment_id: segment.id,
          };

          if (existingIdx >= 0) {
            next[existingIdx] = entry;
          } else {
            next.push(entry);
          }
        }

        return next;
      });

      setIsActive(true);
    };

    room.on(RoomEvent.TranscriptionReceived, handleTranscription);

    return () => {
      clearTimeout(noTranscriptionWarning);
      room.off(RoomEvent.TranscriptionReceived, handleTranscription);
    };
  }, [room, enabled]);

  // Salvar no banco periodicamente (mesma lógica do hook antigo)
  useEffect(() => {
    if (!meetingId || !enabled) return;

    const save = async () => {
      const finals = transcriptionsRef.current.filter((s) => s.is_final);
      if (finals.length === 0) return;
      try {
        await supabase
          .from(tableName as any)
          .update({ transcriptions: finals })
          .eq('id', meetingId);
      } catch {
        // silent
      }
    };

    saveTimerRef.current = setInterval(save, SAVE_INTERVAL_MS);
    return () => {
      if (saveTimerRef.current) clearInterval(saveTimerRef.current);
    };
  }, [meetingId, enabled, tableName]);

  // API pública — compatível com o hook antigo
  const startTranscription = useCallback(async () => {
    // Agent já está rodando na sala (spawned pelo LiveKit Cloud Dispatch),
    // não precisamos fazer nada aqui. Mantemos a função pra compatibilidade.
    setIsActive(true);
  }, []);

  const stopTranscription = useCallback(() => {
    setIsActive(false);
  }, []);

  return {
    transcriptions,
    transcriptionsRef,
    isTranscribing: isActive,
    isActive,
    startTranscription,
    stopTranscription,
  };
}
