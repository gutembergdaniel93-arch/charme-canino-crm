/**
 * useLiveKitTranscriptionAuto — Wrapper que escolhe entre:
 * - V1 (Soniox via WebSocket no browser) — default
 * - V2 (LiveKit Agent nativo + Deepgram) — novo
 *
 * Controle via env var VITE_TRANSCRIPTION_PROVIDER:
 * - 'soniox' (default): comportamento antigo, não quebra nada
 * - 'livekit': usa transcrição nativa do LiveKit (precisa Agent Python rodando)
 *
 * Ambos os hooks retornam a mesma interface. Ambos são chamados sempre pra
 * respeitar rules-of-hooks, mas só um fica realmente ativo via `enabled`.
 */
import { Room } from 'livekit-client';
import { useLiveKitTranscription } from './useLiveKitTranscription';
import { useLiveKitTranscriptionV2 } from './useLiveKitTranscriptionV2';

const PROVIDER = (import.meta.env.VITE_TRANSCRIPTION_PROVIDER || 'soniox') as
  | 'soniox'
  | 'livekit';

export function useLiveKitTranscriptionAuto(
  room: Room | null,
  meetingId: string | null,
  enabled: boolean = true,
) {
  const useLivekit = PROVIDER === 'livekit';

  // Ambos rodam sempre (rules-of-hooks), mas só 1 está ativo:
  const soniox = useLiveKitTranscription(room, meetingId, enabled && !useLivekit);
  const livekit = useLiveKitTranscriptionV2(room, meetingId, enabled && useLivekit);

  return useLivekit ? livekit : soniox;
}
