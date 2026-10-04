/**
 * CallScreenShareEnhancer — plug-and-play pro MeetRoom com 3 features do MentoringRoom:
 *
 * 1. Áudio no share: força { audio: true, systemAudio: 'include' } em todo share
 *    (VideoConference do LiveKit não passa isso por default → tela sem áudio).
 * 2. Overlay Zoom-style: durante share, thumbnails dos participantes flutuam no
 *    canto superior direito (não somem quando a tela ocupa tudo).
 * 3. Document Picture-in-Picture (Chrome/Edge): quando O LOCAL user compartilha,
 *    abre janela do sistema flutuando por cima de qualquer app com as câmeras
 *    dos outros participantes (pra ver reações enquanto apresenta em PowerPoint).
 *
 * Usar:
 *   <VideoConference ... />
 *   <CallScreenShareEnhancer />
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRoomContext, useLocalParticipant, useTracks, ParticipantTile } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { cn } from '@/lib/utils';

const HUES_CACHE = new Map<string, number>();
function getHue(seed: string): number {
  const cached = HUES_CACHE.get(seed);
  if (cached !== undefined) return cached;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  HUES_CACHE.set(seed, h);
  return h;
}
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function CallScreenShareEnhancer() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();

  // 1) MONKEY-PATCH: força áudio no setScreenShareEnabled do local participant.
  // O VideoConference default do LiveKit chama sem opções → sem áudio da aba.
  useEffect(() => {
    if (!localParticipant) return;
    const lp: any = localParticipant;
    const original = lp.setScreenShareEnabled?.bind(lp);
    if (typeof original !== 'function') return;

    lp.setScreenShareEnabled = async (enabled: boolean, captureOptions?: any, publishOptions?: any) => {
      if (enabled) {
        const opts = { audio: true, systemAudio: 'include', ...(captureOptions || {}) };
        return original(true, opts, publishOptions);
      }
      return original(enabled, captureOptions, publishOptions);
    };

    return () => {
      // Restaura original ao desmontar (evita side-effects em outros lugares)
      lp.setScreenShareEnabled = original;
    };
  }, [localParticipant]);

  // Estado de screen share (é alguém compartilhando?)
  const screenTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: true });
  const cameraTracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: false }]);
  const isSharing = screenTracks.length > 0;

  // Câmeras dos REMOTOS (pra overlay + PiP)
  const remoteCameras = cameraTracks.filter((t) => !t.participant.isLocal);

  // 3) DOCUMENT PICTURE-IN-PICTURE (Chrome/Edge): abre quando EU compartilho.
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const localIsSharing = localParticipant?.isScreenShareEnabled;
  useEffect(() => {
    const supportsPip = typeof window !== 'undefined' && 'documentPictureInPicture' in window;
    if (!localIsSharing || !supportsPip) {
      if (pipWindow) {
        try { pipWindow.close(); } catch {}
        setPipWindow(null);
      }
      return;
    }
    if (pipWindow) return;

    let cancelled = false;
    (async () => {
      try {
        const pip = await (window as any).documentPictureInPicture.requestWindow({
          width: 340,
          height: 480,
        });
        if (cancelled) { pip.close(); return; }

        // Copia stylesheets do documento pai (Tailwind etc.)
        try {
          for (const sheet of Array.from(document.styleSheets)) {
            try {
              const rules = Array.from((sheet as any).cssRules || []).map((r: any) => r.cssText).join('\n');
              const style = pip.document.createElement('style');
              style.textContent = rules;
              pip.document.head.appendChild(style);
            } catch {
              if ((sheet as any).href) {
                const link = pip.document.createElement('link');
                link.rel = 'stylesheet';
                link.href = (sheet as any).href;
                pip.document.head.appendChild(link);
              }
            }
          }
        } catch (err) {
          console.warn('[CallPiP] copiar styles falhou:', err);
        }

        pip.document.body.style.margin = '0';
        pip.document.body.style.background = '#09090b';
        pip.document.title = 'Participantes ao vivo';

        pip.addEventListener('pagehide', () => setPipWindow(null));

        setPipWindow(pip);
      } catch (err) {
        console.warn('[CallPiP] requestWindow falhou:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [localIsSharing, pipWindow]);

  return (
    <>
      {/* 2) OVERLAY Zoom-style: thumbnails flutuando no canto direito durante share */}
      {isSharing && remoteCameras.length > 0 && (
        <ScreenShareCameraOverlay cameras={remoteCameras} />
      )}

      {/* 3) Document PiP window (Chrome/Edge) */}
      {pipWindow && createPortal(
        <PipCameraGrid cameraTracks={remoteCameras} />,
        pipWindow.document.body,
      )}
    </>
  );
}

// ─── Overlay dentro do site (canto superior direito da área de vídeo) ───
function ScreenShareCameraOverlay({ cameras }: { cameras: any[] }) {
  const MAX = 5;
  const sorted = [...cameras].sort((a, b) => (b.participant.isSpeaking ? 1 : 0) - (a.participant.isSpeaking ? 1 : 0));
  const visible = sorted.slice(0, MAX);
  const overflow = cameras.length - visible.length;

  return (
    <div className="absolute top-4 right-4 z-30 flex flex-col gap-2 max-h-[calc(100%-2rem)] overflow-hidden pointer-events-none">
      {visible.map((t) => {
        const meta = (() => { try { return JSON.parse(t.participant.metadata || '{}'); } catch { return {}; } })();
        const name = t.participant.name || meta.member_name || meta.email || 'Participante';
        const speaking = t.participant.isSpeaking;
        const hue = getHue(t.participant.identity);
        return (
          <div
            key={t.participant.identity}
            className={cn(
              'relative w-40 aspect-video rounded-xl overflow-hidden bg-zinc-900 border-2 shadow-2xl shadow-black/60 transition-all pointer-events-auto',
              speaking ? 'border-[#FF6B35] shadow-[0_0_0_2px_rgba(255,107,53,0.6)]' : 'border-black/40',
            )}
            title={name}
          >
            {t.publication ? (
              <ParticipantTile trackRef={t} disableSpeakingIndicator className="!border-0 !rounded-xl !w-full !h-full" />
            ) : (
              <div className="w-full h-full flex items-center justify-center" style={{ background: `linear-gradient(135deg, hsl(${hue} 60% 25%), hsl(${hue} 50% 15%))` }}>
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-base" style={{ background: `hsl(${hue} 70% 45%)` }}>
                  {getInitials(name)}
                </div>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 px-1.5 py-0.5 bg-gradient-to-t from-black/90 to-transparent">
              <p className="text-white text-[10px] font-medium truncate text-left">{name}</p>
            </div>
          </div>
        );
      })}
      {overflow > 0 && (
        <div className="w-40 aspect-video rounded-xl bg-zinc-900/95 border-2 border-black/40 shadow-2xl shadow-black/60 flex items-center justify-center pointer-events-none">
          <span className="text-white text-lg font-bold">+{overflow}</span>
        </div>
      )}
    </div>
  );
}

// ─── Grid renderizado dentro da janela PiP do SO ───
function PipCameraGrid({ cameraTracks }: { cameraTracks: any[] }) {
  const N = cameraTracks.length;
  const cols = N <= 1 ? 1 : 2;

  return (
    <div style={{
      width: '100%',
      height: '100vh',
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gap: '4px',
      padding: '4px',
      background: '#09090b',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxSizing: 'border-box',
    }}>
      {cameraTracks.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a', fontSize: '12px' }}>
          Nenhum participante com câmera
        </div>
      ) : cameraTracks.slice(0, 4).map((t) => {
        const meta = (() => { try { return JSON.parse(t.participant.metadata || '{}'); } catch { return {}; } })();
        const name = t.participant.name || meta.member_name || meta.email || t.participant.identity;
        return (
          <div key={t.participant.identity} style={{
            position: 'relative',
            borderRadius: '8px',
            overflow: 'hidden',
            background: '#18181b',
            border: t.participant.isSpeaking ? '2px solid #FF6B35' : '1px solid #27272a',
            minHeight: 0,
          }}>
            <ParticipantTile trackRef={t} disableSpeakingIndicator className="!border-0 !w-full !h-full [&_video]:!object-cover" />
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              padding: '2px 6px',
              background: 'linear-gradient(to top, rgba(0,0,0,0.85), transparent)',
              color: 'white', fontSize: '10px', fontWeight: 500,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{name}</div>
          </div>
        );
      })}
      {cameraTracks.length > 4 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '14px', fontWeight: 'bold', background: '#18181b', borderRadius: '8px' }}>
          +{cameraTracks.length - 4}
        </div>
      )}
    </div>
  );
}
