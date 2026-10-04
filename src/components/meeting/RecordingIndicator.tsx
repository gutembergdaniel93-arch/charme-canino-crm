/**
 * RecordingIndicator — Badge "🔴 REC 02:34" que só o HOST vê
 * Consulta meetings.recording_status periodicamente pra saber se tá gravando
 */
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

interface RecordingIndicatorProps {
  roomName: string;
}

export function RecordingIndicator({ roomName }: RecordingIndicatorProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [elapsed, setElapsed] = useState('00:00');

  // Polling de status da gravação (a cada 3s)
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const { data } = await supabase
        .from('meetings')
        .select('recording_status, started_at')
        .eq('livekit_room_name', roomName)
        .maybeSingle();
      if (cancelled || !data) return;
      const recording = data.recording_status === 'recording';
      setIsRecording(recording);
      if (recording && data.started_at) {
        setStartedAt(new Date(data.started_at));
      }
    };
    check();
    const interval = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [roomName]);

  // Timer
  useEffect(() => {
    if (!isRecording || !startedAt) return;
    const tick = () => {
      const diff = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      const mm = Math.floor(diff / 60).toString().padStart(2, '0');
      const ss = (diff % 60).toString().padStart(2, '0');
      setElapsed(`${mm}:${ss}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isRecording, startedAt]);

  if (!isRecording) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-800/80 backdrop-blur text-zinc-300 text-xs font-medium">
        <div className="w-2 h-2 rounded-full bg-zinc-500" />
        Aguardando gravação...
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-600/90 backdrop-blur text-white text-xs font-bold shadow-lg">
      <div className={cn("w-2 h-2 rounded-full bg-white", "animate-pulse")} />
      REC {elapsed}
    </div>
  );
}
