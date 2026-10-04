import { supabase } from '@/lib/supabase';

export interface LiveKitTokenRequest {
  roomName: string;
  participantName: string;
  participantIdentity?: string;
  role?: 'host' | 'guest' | 'observer' | 'mentor' | 'student';
  metadata?: Record<string, unknown>;
}

export function generateRoomName(prefix = 'meeting') {
  const entropy = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${Date.now()}-${entropy}`;
}

export function getMeetUrl(roomName: string, params?: Record<string, string | undefined>) {
  const configuredBase = import.meta.env.VITE_CRM_URL || import.meta.env.VITE_APP_URL;
  const base = configuredBase || window.location.origin;
  const url = new URL(`/meet/${encodeURIComponent(roomName)}`, base);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url.toString();
}

export async function getLiveKitToken(request: LiveKitTokenRequest) {
  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: {
      room_name: request.roomName,
      participant_name: request.participantName,
      participant_identity: request.participantIdentity,
      role: request.role,
      metadata: request.metadata,
    },
  });
  if (error) throw new Error(error.message || 'Não foi possível gerar o acesso à reunião.');
  const url = data?.url || data?.ws_url;
  if (!data?.token || !url) throw new Error('O servidor LiveKit retornou uma resposta incompleta.');
  return { token: String(data.token), url: String(url) };
}
