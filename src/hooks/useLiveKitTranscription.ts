/**
 * useLiveKitTranscription — Conecta useSoniox aos tracks do LiveKit
 *
 * Captura streams dos participantes (mic local + audio remoto agregado),
 * passa pro useSoniox como externalStreams → reusa toda a lógica robusta
 * de token buffering, reconexão, dedup de speakers.
 */
import { useEffect, useRef, useState } from 'react';
import { Room, Track, RoomEvent } from 'livekit-client';
import { supabase } from '@/lib/supabase';
import { useSoniox } from './useSoniox';

const SAVE_INTERVAL_MS = 10000;

export function useLiveKitTranscription(room: Room | null, meetingId: string | null, enabled: boolean = true) {
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const remoteAudioElRef = useRef<HTMLAudioElement | null>(null);

  // Workaround Chrome bug #121673: audio track remoto do WebRTC produz frames zerados
  // em createMediaStreamSource se não houver <audio> element consumindo primeiro.
  // Criamos um <audio muted autoplay> escondido que "ativa" o pipeline de decoding.
  useEffect(() => {
    if (!remoteStream) {
      if (remoteAudioElRef.current) {
        remoteAudioElRef.current.srcObject = null;
        remoteAudioElRef.current.remove();
        remoteAudioElRef.current = null;
      }
      return;
    }
    if (!remoteAudioElRef.current) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.muted = true; // não duplica o áudio (LiveKit já toca nativamente)
      el.playsInline = true;
      el.style.display = 'none';
      el.setAttribute('data-purpose', 'livekit-soniox-remote-probe');
      document.body.appendChild(el);
      remoteAudioElRef.current = el;
    }
    remoteAudioElRef.current.srcObject = remoteStream;
    remoteAudioElRef.current.play().catch(() => {});
    console.log('[LiveKitTranscription] audio probe element anexado ao remoteStream (workaround Chrome)');
  }, [remoteStream]);

  // Atualiza streams quando a sala muda ou tracks entram
  useEffect(() => {
    if (!room || !enabled) {
      setMicStream(null);
      setRemoteStream(null);
      return;
    }

    const updateStreams = () => {
      // Mic local
      const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const micTrack = micPub?.track?.mediaStreamTrack;

      if (micTrack && micTrack.readyState === 'live') {
        setMicStream((prev) => {
          const newTrackId = micTrack.id;
          const existingTrackId = prev?.getAudioTracks()[0]?.id;
          if (newTrackId === existingTrackId) return prev;
          console.log('[LiveKitTranscription] mic track conectado:', newTrackId);
          return new MediaStream([micTrack]);
        });
      }

      // Audio remoto (agregado) — força subscribe se necessário
      const remoteTracks: MediaStreamTrack[] = [];
      room.remoteParticipants.forEach((p) => {
        p.audioTrackPublications.forEach((pub) => {
          // Força subscribe se ainda não está
          if (!pub.isSubscribed) {
            try {
              pub.setSubscribed(true);
            } catch {}
          }
          const track = pub.track?.mediaStreamTrack;
          if (track && track.readyState === 'live') {
            remoteTracks.push(track);
          }
        });
      });

      if (remoteTracks.length > 0) {
        setRemoteStream((prev) => {
          const newIds = remoteTracks.map((t) => t.id).join(',');
          const existingIds = prev?.getAudioTracks().map((t) => t.id).join(',');
          if (newIds === existingIds) return prev;
          console.log('[LiveKitTranscription] remote tracks conectados:', remoteTracks.length, newIds);
          return new MediaStream(remoteTracks);
        });
      } else {
        setRemoteStream((prev) => {
          if (prev === null) return prev;
          console.log('[LiveKitTranscription] remote stream agora null');
          return null;
        });
      }
    };

    updateStreams();
    // Eventos granulares: cada um dispara update imediato
    room.on(RoomEvent.TrackSubscribed, updateStreams);
    room.on(RoomEvent.TrackUnsubscribed, updateStreams);
    room.on(RoomEvent.TrackPublished, updateStreams);
    room.on(RoomEvent.TrackUnpublished, updateStreams);
    room.on(RoomEvent.LocalTrackPublished, updateStreams);
    room.on(RoomEvent.LocalTrackUnpublished, updateStreams);
    room.on(RoomEvent.ParticipantConnected, updateStreams);
    room.on(RoomEvent.ParticipantDisconnected, updateStreams);
    room.on(RoomEvent.TrackMuted, updateStreams);
    room.on(RoomEvent.TrackUnmuted, updateStreams);

    // Polling de fallback: verifica a cada 2s caso algum evento perca
    const pollInterval = setInterval(updateStreams, 2000);

    return () => {
      clearInterval(pollInterval);
      room.off(RoomEvent.TrackSubscribed, updateStreams);
      room.off(RoomEvent.TrackUnsubscribed, updateStreams);
      room.off(RoomEvent.TrackPublished, updateStreams);
      room.off(RoomEvent.TrackUnpublished, updateStreams);
      room.off(RoomEvent.LocalTrackPublished, updateStreams);
      room.off(RoomEvent.LocalTrackUnpublished, updateStreams);
      room.off(RoomEvent.ParticipantConnected, updateStreams);
      room.off(RoomEvent.ParticipantDisconnected, updateStreams);
      room.off(RoomEvent.TrackMuted, updateStreams);
      room.off(RoomEvent.TrackUnmuted, updateStreams);
    };
  }, [room, enabled]);

  const { transcriptions, transcriptionsRef, isTranscribing, startTranscription, stopTranscription } = useSoniox({
    speakerName: 'Você',
    remoteSpeakerName: 'Lead',
    externalStreams: { mic: micStream, system: remoteStream },
  });

  // Autostart quando tem pelo menos o mic
  useEffect(() => {
    if (!enabled || !micStream || isTranscribing) return;
    startTranscription().catch((err) => console.warn('[useLiveKitTranscription] startTranscription error:', err));
  }, [enabled, micStream, isTranscribing, startTranscription]);

  // Salvar no banco periodicamente
  useEffect(() => {
    if (!meetingId || !enabled) return;
    const save = async () => {
      const finals = transcriptionsRef.current.filter((s: any) => s.is_final);
      if (finals.length === 0) return;
      try {
        await supabase.from('meetings').update({ transcriptions: finals }).eq('id', meetingId);
      } catch {}
    };
    saveTimerRef.current = setInterval(save, SAVE_INTERVAL_MS);
    return () => { if (saveTimerRef.current) clearInterval(saveTimerRef.current); };
  }, [meetingId, enabled, transcriptionsRef]);

  // Cleanup ao sair
  useEffect(() => {
    return () => {
      if (isTranscribing) stopTranscription();
    };
  }, [isTranscribing, stopTranscription]);

  return { transcriptions, isActive: isTranscribing, transcriptionsRef };
}
