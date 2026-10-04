/**
 * MeetRoom — Sala de vídeo LiveKit com painel de contexto pro vendedor
 * Rota pública: /meet/:roomId?role=host&lead_id=...
 */
import { useEffect, useState, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import {
  LiveKitRoom,
  VideoConference,
  PreJoin,
  LocalUserChoices,
  formatChatMessageLinks,
  useRoomContext,
  useTracks,
} from '@livekit/components-react';
import { RoomOptions, VideoPresets, RoomEvent, Track } from 'livekit-client';
import '@livekit/components-styles';
import '@/styles/livekit-ptbr.css';
import { getLiveKitToken } from '@/lib/livekit';
import { Card } from '@/components/ui/card';
import { Loader2, Video, AlertCircle, ArrowLeft, CheckCircle2, PanelRightClose, PanelRightOpen, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { SalesCoachPanel } from '@/components/meeting/SalesCoachPanel';
import { RecordingIndicator } from '@/components/meeting/RecordingIndicator';
import { LiveKitEndMeetingModal } from '@/components/meeting/LiveKitEndMeetingModal';
import { CallEndedModal } from '@/components/calls/CallEndedModal';
import { useLiveKitTranscriptionAuto } from '@/hooks/useLiveKitTranscriptionAuto';
import { CoachChat } from '@/components/meeting/CoachChat';
import { RaiseHandOverlay } from '@/components/meeting/RaiseHandOverlay';
import { CallScreenShareEnhancer } from '@/components/meeting/CallScreenShareEnhancer';
import { ParticipantNameOverlay } from '@/components/meeting/ParticipantNameOverlay';
import { ScreenShareTip } from '@/components/meeting/ScreenShareTip';
import { BackgroundBlurToggle } from '@/components/meeting/BackgroundBlurToggle';
import { PlaybookFloatingCard } from '@/components/meeting/PlaybookFloatingCard';
import { PlaybookPreselector } from '@/components/meeting/PlaybookPreselector';
import { cn } from '@/lib/utils';
import { logAction } from '@/lib/action-log';
import { useCreateOnboarding, useProcessTranscription } from '@/hooks/useOnboardings';
import { useToast } from '@/hooks/use-toast';

// Componente interno que usa o room context
function RoomContent({ leadId, meetingId, isHost, isObserver, roomName, mode, organizationId }: { leadId?: string; meetingId?: string; isHost: boolean; isObserver: boolean; roomName: string; mode: 'sales' | 'cs'; organizationId?: string }) {
  const room = useRoomContext();
  const [showPanel, setShowPanel] = useState(true);
  const [hostPresent, setHostPresent] = useState(isHost); // host sempre vê a si mesmo
  const [userClosedPanel, setUserClosedPanel] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  // Intercepta clique em "Sair" pra pedir confirmação antes de desconectar
  // (evita host sair por acidente perdendo a call inteira)
  useEffect(() => {
    const onClickCapture = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('.lk-disconnect-button') as HTMLButtonElement | null;
      if (!btn) return;
      if (btn.dataset.confirmed === '1') return; // já confirmou, deixa passar
      e.preventDefault();
      e.stopPropagation();
      setShowLeaveConfirm(true);
    };
    document.addEventListener('click', onClickCapture, true);
    return () => document.removeEventListener('click', onClickCapture, true);
  }, []);

  // Sair sem deletar a sala (Agent + egress continuam, outros participantes permanecem)
  const confirmLeaveOnly = () => {
    setShowLeaveConfirm(false);
    (window as any).__meetEndForAll = false;
    const btn = document.querySelector('.lk-disconnect-button') as HTMLButtonElement | null;
    if (btn) {
      btn.dataset.confirmed = '1';
      btn.click();
    } else {
      room?.disconnect().catch(() => {});
    }
  };

  // Encerrar pra todos: deleta sala (usa flag lida no onDisconnected do MeetRoom)
  const confirmEndForAll = () => {
    setShowLeaveConfirm(false);
    (window as any).__meetEndForAll = true;
    const btn = document.querySelector('.lk-disconnect-button') as HTMLButtonElement | null;
    if (btn) {
      btn.dataset.confirmed = '1';
      btn.click();
    } else {
      room?.disconnect().catch(() => {});
    }
  };

  // Detecta screen share ativo (qualquer participante)
  const screenShareTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: true });
  const isScreenSharing = screenShareTracks.length > 0;

  // Auto-fecha painel quando alguém compartilha tela (libera espaço pro layout horizontal)
  useEffect(() => {
    if (isScreenSharing && showPanel && !userClosedPanel) {
      setShowPanel(false);
    } else if (!isScreenSharing && !userClosedPanel) {
      setShowPanel(true);
    }
  }, [isScreenSharing, showPanel, userClosedPanel]);

  // Detectar presença do host entre os participantes
  useEffect(() => {
    if (isHost) { setHostPresent(true); return; }
    if (!room) return;

    const checkHost = () => {
      let found = false;
      room.remoteParticipants.forEach((p) => {
        try {
          const meta = p.metadata ? JSON.parse(p.metadata) : null;
          if (meta?.role === 'host' || p.identity?.includes('host')) found = true;
        } catch {}
        // Fallback: qualquer participante remoto conta como host pro lead
        if (p.audioTrackPublications.size > 0 || p.videoTrackPublications.size > 0) found = true;
      });
      setHostPresent(found);
    };

    // checkHost imediato (pode ainda estar vazio se room não terminou de sincronizar)
    checkHost();
    // Fallback: re-verifica depois de 1s. Cobre o caso em que `room` é fornecido
    // pelo provider antes do `Connected` event, ou se nenhum evento dispara
    // pra participantes JÁ presentes quando lead entra.
    const fallback = setTimeout(checkHost, 1000);

    // Eventos que disparam checkHost.
    // CRÍTICO: `RoomEvent.Connected` é o único que dispara DEPOIS do lead
    // sincronizar e que garante `remoteParticipants` populado com TODOS
    // os participantes que JÁ estavam na sala antes dele entrar.
    // `participantConnected` só dispara pra NEW connections após o lead conectar.
    room.on(RoomEvent.Connected, checkHost);
    room.on(RoomEvent.ParticipantConnected, checkHost);
    room.on(RoomEvent.ParticipantDisconnected, checkHost);
    room.on(RoomEvent.TrackSubscribed, checkHost);
    return () => {
      clearTimeout(fallback);
      room.off(RoomEvent.Connected, checkHost);
      room.off(RoomEvent.ParticipantConnected, checkHost);
      room.off(RoomEvent.ParticipantDisconnected, checkHost);
      room.off(RoomEvent.TrackSubscribed, checkHost);
    };
  }, [room, isHost]);

  // Transcrição ao vivo (só pra host, economia de quota).
  // Provider escolhido via env VITE_TRANSCRIPTION_PROVIDER=soniox|livekit
  const { transcriptions: liveTranscription } = useLiveKitTranscriptionAuto(
    room,
    meetingId || null,
    isHost,
  );

  // Lobby (só pra guest, quando host ainda não chegou)
  if (!isHost && !hostPresent) {
    return (
      <div className="h-screen w-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-6">
            <Loader2 className="h-10 w-10 text-emerald-500 animate-spin" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-3">Aguardando o anfitrião</h1>
          <p className="text-sm text-zinc-400 mb-8">
            Você está conectado. A reunião vai começar assim que o anfitrião entrar na sala.
          </p>
          <div className="p-4 rounded-lg bg-zinc-900 border border-zinc-800 text-left">
            <p className="text-xs text-zinc-500 mb-1">DICAS ENQUANTO ESPERA</p>
            <ul className="text-xs text-zinc-300 space-y-1 mt-2">
              <li>✓ Teste seu microfone e câmera</li>
              <li>✓ Procure um ambiente silencioso</li>
              <li>✓ Tenha boa iluminação</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  const leaveConfirmDialog = (
    <AlertDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <LogOut className="h-5 w-5 text-red-500" />
            {isHost ? 'Sair da reunião?' : 'Sair da reunião?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isHost
              ? 'Escolha como sair. "Apenas sair" mantém a sala aberta (Agent + gravação continuam). "Encerrar pra todos" finaliza pra todos e abre o fluxo de processamento da transcrição.'
              : 'Tem certeza que quer sair? Você precisará entrar novamente se clicar por engano.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:gap-2 flex-col sm:flex-row">
          <AlertDialogCancel>Continuar na reunião</AlertDialogCancel>
          {isHost ? (
            <>
              <AlertDialogAction
                onClick={confirmLeaveOnly}
                className="bg-zinc-700 hover:bg-zinc-800 text-white"
              >
                Apenas sair
              </AlertDialogAction>
              <AlertDialogAction
                onClick={confirmEndForAll}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                Encerrar pra todos
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction
              onClick={confirmLeaveOnly}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Sair
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // Observer — vê video + painel + chat privado, hidden
  if (isObserver) {
    return (
      <div className="h-screen w-screen bg-black flex overflow-hidden" data-lk-theme="default">
        <div className="flex-1 relative min-w-0 h-full">
          <VideoConference chatMessageFormatter={formatChatMessageLinks} />
          <ParticipantNameOverlay />
          <CallScreenShareEnhancer />
          <div className="absolute top-4 left-4 z-50 px-3 py-1.5 rounded-full bg-purple-600 text-white text-xs font-bold shadow-lg">
            👁 MODO OBSERVADOR · invisível pra todos
          </div>
        </div>
        <aside className="w-[380px] shrink-0 h-full">
          <CoachChat role="observer" />
        </aside>
        {leaveConfirmDialog}
      </div>
    );
  }

  if (!isHost) {
    // Guest/lead — só vídeo, sem painel
    return (
      <div className="h-screen w-screen bg-black relative" data-lk-theme="default">
        <VideoConference chatMessageFormatter={formatChatMessageLinks} />
        <ParticipantNameOverlay />
        <CallScreenShareEnhancer />
        <RaiseHandOverlay isHost={false} />
        {leaveConfirmDialog}
      </div>
    );
  }

  // Host (vendedor) — vídeo + painel lado a lado
  return (
    <div className="h-screen w-screen bg-black flex overflow-hidden" data-lk-theme="default">
      {/* Área do vídeo */}
      <div className="flex-1 relative min-w-0 h-full">
        <VideoConference chatMessageFormatter={formatChatMessageLinks} />
        <ParticipantNameOverlay />
        <CallScreenShareEnhancer />
        <RaiseHandOverlay isHost={true} />
        <ScreenShareTip />

        {/* Playbook card flutuante (só host, esconde quando compartilhando tela) */}
        <PlaybookFloatingCard leadId={leadId} meetingId={meetingId} mode={mode} organizationId={organizationId} hidden={isScreenSharing} />

        {/* Recording indicator */}
        <div className="absolute top-4 left-4 z-50">
          <RecordingIndicator roomName={roomName} />
        </div>

        {/* Blur de fundo (só host) */}
        <BackgroundBlurToggle />

        {/* Toggle do painel */}
        <Button
          onClick={() => { setShowPanel(!showPanel); setUserClosedPanel(true); }}
          variant="secondary"
          size="icon"
          className="absolute top-4 right-4 z-50 bg-zinc-800/80 hover:bg-zinc-700 text-white backdrop-blur"
          title={showPanel ? 'Ocultar painel' : 'Mostrar painel'}
        >
          {showPanel ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      </div>

      {/* Painel lateral (lado a lado, sem fixed) */}
      {showPanel && (
        <aside className="w-[400px] shrink-0 h-full border-l border-zinc-800">
          <SalesCoachPanel
            leadId={leadId}
            meetingId={meetingId}
            liveTranscription={liveTranscription}
            mode={mode}
            organizationId={organizationId}
          />
        </aside>
      )}

      {/* Coach Chat flutuante pro host */}
      <CoachChat role="host" />

      {leaveConfirmDialog}
    </div>
  );
}

export default function MeetRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { teamMember } = useAuth();

  const [preJoinChoices, setPreJoinChoices] = useState<LocalUserChoices | null>(null);
  const [connectionData, setConnectionData] = useState<{ token: string; url: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [endCallData, setEndCallData] = useState<any>(null);
  const [showCallEnded, setShowCallEnded] = useState(false);
  const [meetingDbId, setMeetingDbId] = useState<string | null>(null);
  const [meetingTranscriptions, setMeetingTranscriptions] = useState<any[]>([]);
  const [taskActivityId, setTaskActivityId] = useState<string | null>(null);

  // Role é derivado da AUTENTICAÇÃO, não da URL (URL pode quebrar, auth não).
  //   - teamMember autenticado → host por default (observer se explicitamente pedido)
  //   - não autenticado → guest (nunca pode virar host mesmo com URL manipulada)
  // Isso blinda: link com param errado/corrompido nunca derruba vendedor pra guest,
  // e cliente nunca consegue forçar host via URL.
  const roleParam = searchParams.get('role') as 'host' | 'guest' | 'observer' | null;
  const role: 'host' | 'guest' | 'observer' = (() => {
    if (teamMember) {
      // Staff autenticado: observer só se pedido explicitamente; caso contrário host
      if (roleParam === 'observer') return 'observer';
      return 'host';
    }
    // Não autenticado: sempre guest (URL param irrelevante)
    if (roleParam === 'host' || roleParam === 'observer') {
      console.warn(`[MeetRoom] role=${roleParam} na URL mas usuário não autenticado — forçando guest`);
    }
    return 'guest';
  })();
  const nameParam = searchParams.get('name') || '';
  const leadIdParam = searchParams.get('lead_id') || undefined;
  const orgId = searchParams.get('org_id') || undefined;
  const [resolvedLeadId, setResolvedLeadId] = useState<string | undefined>(leadIdParam);
  const leadId = resolvedLeadId;

  // Se só tem orgId (cliente), busca primary_contact_id → vira leadId
  useEffect(() => {
    if (!leadIdParam && orgId) {
      (async () => {
        const { data } = await supabase.from('organizations').select('primary_contact_id').eq('id', orgId).maybeSingle();
        if (data?.primary_contact_id) setResolvedLeadId(data.primary_contact_id);
      })();
    }
  }, [leadIdParam, orgId]);

  // ═══════════════════════════════════════════════════════════════
  // Detecção de MODO (sales/cs) + category via company_activities
  // Fonte de verdade: a task que gerou o meeting_link.
  // ═══════════════════════════════════════════════════════════════
  const [taskMeta, setTaskMeta] = useState<{
    team: 'sales' | 'cs' | 'marketing' | 'internal' | null;
    task_type: string | null;
    lead_id: string | null;
    organization_id: string | null;
  } | null>(null);
  const [resolvedOrgId, setResolvedOrgId] = useState<string | undefined>(orgId);

  const TASK_TYPE_TO_CATEGORY: Record<string, string> = {
    onboarding: 'onboarding',
    checkin: 'checkin',
    renewal: 'renewal',
    upsell: 'upsell',
    rescue: 'churn_recovery',
    nps: 'checkin',
  };
  const CS_TASK_TYPES = Object.keys(TASK_TYPE_TO_CATEGORY);

  useEffect(() => {
    if (!roomId) return;
    (async () => {
      // 1) Fonte primária: company_activities (tasks de sales/CS com meeting_link)
      const { data } = await supabase
        .from('company_activities')
        .select('team, task_type, lead_id, organization_id')
        .like('meeting_link', `%${roomId}%`)
        .maybeSingle();
      if (data) {
        setTaskMeta(data as any);
        if (!orgId && data.organization_id) setResolvedOrgId(data.organization_id);
        if (!leadIdParam && data.lead_id) setResolvedLeadId(data.lead_id);
        return;
      }

      // 2) Fallback: reuniões do time (tabela meetings, sem task associada)
      // Criadas via /gestao/reunioes — team='internal', meeting_type='team'
      const { data: meetingData } = await supabase
        .from('meetings')
        .select('team, meeting_type, lead_id, organization_id')
        .or(`livekit_room_name.eq.${roomId},meeting_link.ilike.%${roomId}%`)
        .maybeSingle();
      if (meetingData) {
        // Se é reunião interna do time → force task_type='internal' (vira ata)
        const isInternal = meetingData.team === 'internal' || meetingData.meeting_type === 'team';
        setTaskMeta({
          team: (meetingData.team || (isInternal ? 'internal' : 'sales')) as any,
          task_type: isInternal ? 'internal' : (meetingData.meeting_type || null),
          lead_id: meetingData.lead_id,
          organization_id: meetingData.organization_id,
        });
        if (!orgId && meetingData.organization_id) setResolvedOrgId(meetingData.organization_id);
        if (!leadIdParam && meetingData.lead_id) setResolvedLeadId(meetingData.lead_id);
      }
    })();
  }, [roomId, orgId, leadIdParam]);

  const mode: 'sales' | 'cs' = (() => {
    if (taskMeta?.team === 'cs') return 'cs';
    if (taskMeta?.task_type && CS_TASK_TYPES.includes(taskMeta.task_type)) return 'cs';
    if (resolvedOrgId && !leadIdParam) return 'cs';
    return 'sales';
  })();

  const suggestedCategory: string | null = taskMeta?.task_type
    ? (TASK_TYPE_TO_CATEGORY[taskMeta.task_type] || null)
    : null;
  const meetingIdParam = searchParams.get('meeting_id') || undefined;
  const returnUrl = searchParams.get('return') || '/';
  const isHost = role === 'host';
  const isObserver = role === 'observer';

  const defaultName = useMemo(() => {
    return nameParam || teamMember?.name || '';
  }, [nameParam, teamMember]);

  const roomOptions: RoomOptions = {
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    publishDefaults: {
      // Câmera: simulcast h360/h720 (mínimo h360 evita blur em thumbnail)
      videoSimulcastLayers: [VideoPresets.h360, VideoPresets.h720],
      // Screen share: 1080p nativo com bitrate alto pra UI/texto ficar legível
      // (default do LiveKit é baixo e faz downscale ruim em dashboards)
      screenShareEncoding: {
        maxBitrate: 3_000_000,
        maxFramerate: 15,
      },
      screenShareSimulcastLayers: [VideoPresets.h1080],
    },
  };

  // Observer: pula PreJoin, conecta direto sem camera/mic (precisa estar ANTES dos returns)
  useEffect(() => {
    if (!isObserver || connectionData || loading || !roomId) return;
    (async () => {
      setLoading(true);
      try {
        const { token, url } = await getLiveKitToken({
          roomName: roomId,
          participantName: defaultName || 'Observador',
          role: 'observer' as any,
          metadata: { lead_id: leadId, org_id: orgId },
        });
        setPreJoinChoices({ username: defaultName || 'Observador', videoEnabled: false, audioEnabled: false } as any);
        setConnectionData({ token, url });
      } catch (err: any) {
        setError(err.message || 'Erro ao conectar');
      } finally {
        setLoading(false);
      }
    })();
  }, [isObserver, connectionData, loading, roomId, defaultName, leadId, orgId]);

  const handlePreJoin = async (choices: LocalUserChoices) => {
    if (!roomId) return;
    setPreJoinChoices(choices);
    setLoading(true);
    setError(null);

    try {
      // Garante que a meeting existe no banco (pra gravação funcionar)
      // Cria se não existir, mesmo como guest (o host logado depois atualiza)
      try {
        // 1) Busca primária: livekit_room_name (forma correta)
        let { data: existing } = await supabase
          .from('meetings')
          .select('id, livekit_room_name')
          .eq('livekit_room_name', roomId)
          .maybeSingle();

        // 2) Fallback: alguns registros antigos (ex: criados via /gestao/reunioes antes
        //    do fix de livekit_room_name) só têm o roomId no meeting_link. Busca por lá
        //    e auto-corrige preenchendo o campo, pra não duplicar na próxima vez.
        if (!existing) {
          const { data: legacy } = await supabase
            .from('meetings')
            .select('id, livekit_room_name')
            .ilike('meeting_link', `%${roomId}%`)
            .is('livekit_room_name', null)
            .limit(1)
            .maybeSingle();
          if (legacy) {
            existing = legacy;
            // Auto-heal: preenche o room_name pra detecção futura ser direta
            await supabase.from('meetings')
              .update({ livekit_room_name: roomId })
              .eq('id', legacy.id);
          }
        }

        if (existing) {
          setMeetingDbId(existing.id);
          // Garante que task fica em "em andamento" enquanto meeting está ativa
          const { data: existingFull } = await supabase.from('meetings').select('activity_id, status').eq('id', existing.id).maybeSingle();
          if (existingFull?.activity_id && existingFull.status === 'active') {
            await supabase.from('company_activities').update({ status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', existingFull.activity_id);
          }
        } else {
          // Buscar activity vinculada (pela meeting_link contendo o roomId)
          const { data: act } = await supabase
            .from('company_activities')
            .select('id, lead_id, organization_id, task_type, team')
            .like('meeting_link', `%${roomId}%`)
            .maybeSingle();

          // Deriva meeting_type da task (CS usa task_type direto, sales vira 'sales_call')
          const CS_TYPES = ['onboarding', 'checkin', 'renewal', 'upsell', 'rescue', 'nps', 'training'];
          const derivedMeetingType = act?.task_type && CS_TYPES.includes(act.task_type)
            ? act.task_type
            : (act?.team === 'cs' ? 'cs_meeting' : 'sales_call');

          const { data: newMeet, error: insertErr } = await supabase.from('meetings').insert({
            title: `Reunião ${roomId}`,
            lead_id: leadId || act?.lead_id || null,
            organization_id: orgId || act?.organization_id || null,
            activity_id: act?.id || null,
            meeting_type: derivedMeetingType,
            status: 'active',
            started_at: new Date().toISOString(),
            livekit_room_name: roomId,
            recording_status: 'pending',
            created_by: teamMember?.id || null,
            meeting_link: window.location.origin + '/meet/' + roomId,
            participants: teamMember ? [{ id: teamMember.id, name: teamMember.name, role: 'host' }] : [],
            transcriptions: [],
          }).select('id').single();
          if (insertErr) console.warn('[MeetRoom] insert meeting falhou:', insertErr);
          else if (newMeet) {
            setMeetingDbId(newMeet.id);
            console.log('[MeetRoom] meeting criada:', roomId, newMeet.id, 'activity:', act?.id);
            if (teamMember?.id) {
              logAction({ userId: teamMember.id, action: 'started_meeting', resourceType: 'meeting', resourceId: newMeet.id, leadId: leadId || act?.lead_id || undefined, metadata: { room: roomId } });
            }
            // Marca a task como "em andamento" pra UI mostrar "AO VIVO"
            if (act?.id) {
              await supabase.from('company_activities')
                .update({ status: 'in_progress', updated_at: new Date().toISOString() })
                .eq('id', act.id);
            }
          }
        }
      } catch (err) {
        console.warn('[MeetRoom] erro ao criar meeting:', err);
      }

      const { token, url } = await getLiveKitToken({
        roomName: roomId,
        participantName: choices.username || defaultName || 'Participante',
        role,
        metadata: { lead_id: leadId, org_id: orgId },
      });
      setConnectionData({ token, url });
    } catch (err: any) {
      setError(err.message || 'Erro ao conectar');
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    // Se NÃO é host, apenas encerra e volta
    if (!isHost || !teamMember) {
      setConnectionData(null);
      setEnded(true);
      return;
    }

    // Lê intenção do host: "Apenas sair" (false) vs "Encerrar pra todos" (true)
    // Flag setada pelos botões do AlertDialog no RoomContent via window
    const endForAll = (window as any).__meetEndForAll === true;
    // Reset flag pra próxima vez
    (window as any).__meetEndForAll = false;

    // "Apenas sair": não deleta sala — Agent + egress + outros participantes continuam
    if (!endForAll) {
      setConnectionData(null);
      setEnded(true);
      return;
    }

    // "Encerrar pra todos": deleta sala (Agent/egress param, todos são expulsos)
    if (roomId) {
      supabase.functions.invoke('livekit-end-room', { body: { room_name: roomId } }).catch(() => {});
    }

    // Host — busca dados da meeting e abre modal de encerramento
    try {
      const { data: meeting } = await supabase
        .from('meetings')
        .select('id, transcriptions, activity_id')
        .eq('livekit_room_name', roomId)
        .maybeSingle();

      if (meeting) {
        setMeetingDbId(meeting.id);
        setMeetingTranscriptions(meeting.transcriptions || []);
        setTaskActivityId(meeting.activity_id || null);
      }

      // Busca activity vinculada pela meeting_link (fallback)
      if (!meeting?.activity_id && roomId) {
        const { data: act } = await supabase
          .from('company_activities')
          .select('id')
          .like('meeting_link', `%${roomId}%`)
          .maybeSingle();
        if (act) setTaskActivityId(act.id);
      }
    } catch (err) {
      console.warn('Erro ao buscar meeting:', err);
    }

    setConnectionData(null);
    setShowEndModal(true);
  };

  const createOnboarding = useCreateOnboarding();
  const processOnboardingTranscription = useProcessTranscription();
  const { toast: rootToast } = useToast();
  const [processingOnboarding, setProcessingOnboarding] = useState(false);

  const handleEndConfirmed = async (status: 'completed' | 'no_show' | 'rescheduled', data?: any) => {
    setShowEndModal(false);
    if (status !== 'completed' || !data) {
      setEnded(true);
      return;
    }

    // Fonte da verdade: taskMeta.task_type (da company_activities) > data.meetingType > fallback por mode
    const resolvedMeetingType = taskMeta?.task_type || data.meetingType || (mode === 'cs' ? 'cs_meeting' : 'sales_call');

    // Onboarding tem fluxo próprio: createOnboarding + processTranscription
    if (resolvedMeetingType === 'onboarding' && (data.organizationId || resolvedOrgId)) {
      const orgIdFinal = data.organizationId || resolvedOrgId!;
      const rawTranscript = Array.isArray(data.transcriptions)
        ? data.transcriptions.filter((t: any) => t.is_final !== false).map((t: any) => `${t.speaker || 'Speaker'}: ${t.text}`).join('\n')
        : '';

      if (rawTranscript.length < 20) {
        rootToast({
          title: 'Transcrição muito curta',
          description: 'Não foi possível processar o onboarding (transcrição vazia). Volte ao cliente e processe manualmente.',
          variant: 'destructive',
        });
        setEnded(true);
        return;
      }

      setProcessingOnboarding(true);
      try {
        const onboarding = await createOnboarding.mutateAsync({
          organization_id: orgIdFinal,
          meeting_id: meetingDbId || undefined,
          activity_id: data.activityId || taskActivityId || undefined,
          transcription_source: 'meeting',
          transcription_raw: rawTranscript,
          created_by: teamMember?.id,
        });
        await processOnboardingTranscription.mutateAsync({
          id: onboarding.id,
          transcription: rawTranscript,
          source: 'meeting',
        });
        // Redireciona pra aba Onboarding do cliente
        navigate(`/clientes/${orgIdFinal}?tab=onboarding`);
      } catch (err: any) {
        console.error('[MeetRoom] erro ao processar onboarding:', err);
        rootToast({
          title: 'Erro ao processar onboarding',
          description: err?.message || 'Transcrição foi salva na reunião. Processe manualmente em /clientes/:id?tab=onboarding.',
          variant: 'destructive',
        });
        setProcessingOnboarding(false);
        setEnded(true);
      }
      return;
    }

    // Demais tipos → CallEndedModal (sales_call mantém análise sales; CS/interno vai pra ata)
    setEndCallData({
      callId: data.callId,
      transcriptions: data.transcriptions || [],
      leadId: data.leadId,
      organizationId: data.organizationId || resolvedOrgId,
      activityId: data.activityId,
      meetingType: resolvedMeetingType,
      peerName: defaultName,
    });
    setShowCallEnded(true);
  };

  // Tela de processamento de onboarding
  if (processingOnboarding) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4 gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
        <p className="text-zinc-200 text-sm font-medium">Gerando dossiê de onboarding...</p>
        <p className="text-zinc-500 text-xs">IA está estruturando objetivos, trilhas e contexto do cliente</p>
      </div>
    );
  }

  // Modal de encerramento (aparece após sair da sala, antes de redirecionar)
  if (showEndModal && !ended) {
    return (
      <>
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
          <p className="text-zinc-400 text-sm">Encerrando reunião...</p>
        </div>
        <LiveKitEndMeetingModal
          open={showEndModal}
          meetingId={meetingDbId || undefined}
          activityId={taskActivityId || undefined}
          leadId={leadId}
          organizationId={resolvedOrgId}
          meetingType={taskMeta?.task_type || undefined}
          transcriptions={meetingTranscriptions}
          onConfirmed={handleEndConfirmed}
          onCancel={() => { setShowEndModal(false); setEnded(true); }}
        />
      </>
    );
  }

  // CallEndedModal — análise IA pós-reunião (só se status = completed)
  if (showCallEnded && endCallData) {
    return (
      <>
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
          <p className="text-zinc-400 text-sm">Analisando reunião...</p>
        </div>
        <CallEndedModal
          externalOpen={showCallEnded}
          externalData={endCallData}
          onExternalClose={() => { setShowCallEnded(false); setEnded(true); }}
        />
      </>
    );
  }

  if (ended) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <Card className="w-full max-w-md p-8 bg-zinc-900 border-zinc-800 text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="h-7 w-7 text-emerald-500" />
          </div>
          <h1 className="text-xl font-bold text-white mb-2">
            {teamMember ? 'Reunião encerrada' : 'Obrigado pela reunião!'}
          </h1>
          <p className="text-sm text-zinc-400 mb-6">
            {teamMember
              ? 'A gravação e a análise estarão disponíveis em breve no CRM.'
              : 'A reunião foi encerrada. Nos falaremos em breve — qualquer dúvida, é só chamar no WhatsApp.'}
          </p>
          <div className="flex gap-2 justify-center">
            {teamMember ? (
              <Button onClick={() => navigate(returnUrl)} className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Voltar ao CRM
              </Button>
            ) : (
              <Button onClick={() => window.close()} variant="outline">Fechar</Button>
            )}
          </div>
        </Card>
      </div>
    );
  }

  if (!connectionData) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <Card className="w-full max-w-md p-6 bg-zinc-900 border-zinc-800">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <Video className="h-5 w-5 text-emerald-500" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">Entrar na reunião</h1>
              <p className="text-xs text-zinc-400">Sala: {roomId}</p>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-950/50 border border-red-800 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
              <p className="text-sm text-zinc-400">Conectando...</p>
            </div>
          ) : (
            <>
              {defaultName && (
                <div className="mb-3 p-2 rounded-lg bg-emerald-950/30 border border-emerald-800/50 text-center">
                  <p className="text-xs text-emerald-300">
                    Entrando como <strong className="text-emerald-200">{defaultName}</strong>
                    {isHost && <span className="ml-1 text-[10px] text-emerald-400">• HOST</span>}
                  </p>
                </div>
              )}
              <PreJoin
                defaults={{ username: defaultName, videoEnabled: true, audioEnabled: true }}
                onSubmit={handlePreJoin}
                data-lk-theme="default"
                userLabel="Seu nome"
                joinLabel="Entrar na sala"
                micLabel="Microfone"
                camLabel="Câmera"
              />
              {/* Seletor de playbook — só pro host, CS ou Sales */}
              {isHost && (
                <PlaybookPreselector
                  meetingId={meetingDbId || meetingIdParam}
                  mode={mode}
                  suggestedCategory={suggestedCategory}
                />
              )}
            </>
          )}

          <p className="text-[10px] text-zinc-500 text-center mt-4">
            Ao entrar, você autoriza o uso de câmera e microfone. A reunião pode ser gravada.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={connectionData.token}
      serverUrl={connectionData.url}
      connect={true}
      video={preJoinChoices?.videoEnabled}
      audio={preJoinChoices?.audioEnabled}
      options={roomOptions}
      onDisconnected={handleDisconnect}
      onError={(err) => {
        console.error('LiveKit error:', err);
        setError(err.message);
      }}
    >
      <RoomContent leadId={leadId} meetingId={meetingDbId || meetingIdParam} isHost={isHost} isObserver={isObserver} roomName={roomId!} mode={mode} organizationId={resolvedOrgId} />
    </LiveKitRoom>
  );
}
