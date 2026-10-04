/**
 * RaiseHandOverlay — sinalização simples de "levantar mão" pra MeetRoom 1:1 / N:N
 * Diferente da MentoringRoom: SEM fila, SEM dossiê, SEM NPS — só broadcast efêmero via DataChannel.
 */
import { useEffect, useState, useCallback } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, DataPacket_Kind, RemoteParticipant } from 'livekit-client';
import { Hand } from 'lucide-react';
import { cn } from '@/lib/utils';

const TOPIC = 'raise-hand';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function RaiseHandOverlay({ isHost }: { isHost: boolean }) {
  const room = useRoomContext();
  const [myHand, setMyHand] = useState(false);
  // identity -> { name, ts }
  const [raised, setRaised] = useState<Record<string, { name: string; ts: number }>>({});

  const broadcast = useCallback(async (raisedNow: boolean) => {
    if (!room?.localParticipant) return;
    const payload = JSON.stringify({
      type: 'raise_hand',
      raised: raisedNow,
      identity: room.localParticipant.identity,
      name: room.localParticipant.name || room.localParticipant.identity,
    });
    try {
      await room.localParticipant.publishData(encoder.encode(payload), { reliable: true, topic: TOPIC });
    } catch (err) {
      console.warn('[RaiseHand] publish falhou', err);
    }
  }, [room]);

  // Receber broadcasts
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: DataPacket_Kind, topic?: string) => {
      if (topic && topic !== TOPIC) return;
      try {
        const msg = JSON.parse(decoder.decode(payload));
        if (msg?.type !== 'raise_hand') return;
        const id = msg.identity || participant?.identity;
        if (!id) return;
        setRaised((prev) => {
          const next = { ...prev };
          if (msg.raised) next[id] = { name: msg.name || id, ts: Date.now() };
          else delete next[id];
          return next;
        });
      } catch {}
    };
    const onLeft = (p: RemoteParticipant) => {
      setRaised((prev) => {
        if (!prev[p.identity]) return prev;
        const next = { ...prev }; delete next[p.identity]; return next;
      });
    };
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
    };
  }, [room]);

  const toggleHand = async () => {
    const next = !myHand;
    setMyHand(next);
    await broadcast(next);
  };

  // Host pode baixar a mão de qualquer um (envia evento direcionado)
  const lowerFor = async (identity: string) => {
    if (!room?.localParticipant) return;
    const payload = JSON.stringify({ type: 'raise_hand_lower', target: identity });
    try {
      await room.localParticipant.publishData(encoder.encode(payload), { reliable: true, topic: TOPIC });
    } catch {}
    setRaised((prev) => { const n = { ...prev }; delete n[identity]; return n; });
  };

  // Receber "lower" direcionado a mim
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array, _p?: RemoteParticipant, _k?: DataPacket_Kind, topic?: string) => {
      if (topic && topic !== TOPIC) return;
      try {
        const msg = JSON.parse(decoder.decode(payload));
        if (msg?.type === 'raise_hand_lower' && msg.target === room.localParticipant.identity) {
          setMyHand(false);
        }
      } catch {}
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room]);

  const list = Object.entries(raised).sort((a, b) => a[1].ts - b[1].ts);

  return (
    <>
      {/* Botão de levantar a mão — posicionado à direita, MESMA LINHA da toolbar
          do LiveKit (mic/câmera/hangup). Antes ficava flutuando bottom-24 center
          e ficava em cima do rosto do usuário — reclamação Frank 06/07. */}
      <button
        onClick={toggleHand}
        className={cn(
          'absolute bottom-4 right-4 z-50 h-11 px-4 rounded-full',
          'flex items-center gap-2 text-sm font-medium shadow-lg backdrop-blur transition-all',
          myHand
            ? 'bg-amber-500 text-zinc-900 hover:bg-amber-400'
            : 'bg-zinc-800/90 text-white hover:bg-zinc-700 border border-zinc-700',
        )}
        title={myHand ? 'Baixar a mão' : 'Levantar a mão'}
      >
        <Hand className={cn('h-4 w-4', myHand && 'animate-pulse')} />
        <span className="hidden md:inline">{myHand ? 'Baixar a mão' : 'Levantar a mão'}</span>
      </button>

      {/* Painel de quem levantou a mão — canto superior direito, longe da toolbar */}
      {list.length > 0 && (
        <div className="absolute top-16 right-4 z-50 w-64 rounded-xl bg-zinc-900/95 border border-zinc-700 backdrop-blur shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 text-xs font-semibold text-amber-400">
            <Hand className="h-3.5 w-3.5" />
            Mão levantada ({list.length})
          </div>
          <div className="max-h-56 overflow-y-auto">
            {list.map(([id, info]) => (
              <div key={id} className="px-3 py-2 flex items-center justify-between gap-2 hover:bg-zinc-800/60">
                <span className="text-sm text-white truncate">{info.name}</span>
                {isHost && (
                  <button
                    onClick={() => lowerFor(id)}
                    className="text-[11px] text-zinc-400 hover:text-white px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700"
                  >
                    Baixar
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Indicador flutuante no tile de quem levantou */}
      <RaisedTileIndicators raised={raised} />
    </>
  );
}

function RaisedTileIndicators({ raised }: { raised: Record<string, { name: string; ts: number }> }) {
  // Marca via CSS o tile do participante. LiveKit adiciona data-lk-participant-identity nos tiles.
  useEffect(() => {
    const ids = Object.keys(raised);
    const tiles = document.querySelectorAll<HTMLElement>('[data-lk-participant-identity]');
    tiles.forEach((el) => {
      const id = el.getAttribute('data-lk-participant-identity') || '';
      const has = ids.includes(id);
      el.classList.toggle('has-raised-hand', has);
    });
  }, [raised]);
  return null;
}
