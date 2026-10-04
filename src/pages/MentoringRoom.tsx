/**
 * MentoringRoom — Broadcast Studio Íntimo
 * Sala de mentoria ao vivo com layout webinar
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LiveKitRoom, RoomAudioRenderer, useLocalParticipant, useParticipants, useRoomContext,
  useTracks, ParticipantTile,
} from '@livekit/components-react';
import { Track, RoomEvent, ParticipantEvent } from 'livekit-client';
import '@livekit/components-styles';
import '@/styles/livekit-ptbr.css';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { getInitials, getHue, timeAgo } from '@/lib/mentoring-helpers';
import {
  Mic, MicOff, Video as VideoIcon, VideoOff, PhoneOff, Hand, MessageSquare, MessagesSquare,
  Loader2, AlertCircle, Users, Heart, ChevronRight, X, BarChart3, HelpCircle,
  Mail, Phone, Star, Target, Activity, Clock, Send, Check, Radio, Smile,
  Settings, Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { BackgroundBlurToggle } from '@/components/meeting/BackgroundBlurToggle';
import { ScreenShareTip } from '@/components/meeting/ScreenShareTip';
import { useLiveKitTranscriptionV2 } from '@/hooks/useLiveKitTranscriptionV2';
import { MonitorUp, MonitorOff, Paperclip, Image as ImageIcon, FileText, Download } from 'lucide-react';
import { toast } from 'sonner';

// ─── Types ───
interface MentorMode { kind: 'mentor'; memberId: string; memberName: string; sessionId: string; sessionTitle: string; sessionStartedAt: string | null; }
interface StudentMode { kind: 'student'; email: string; memberName: string; phone?: string; externalId?: string; leadId: string | null; sessionId: string; sessionTitle: string; sessionStartedAt: string | null; }
type AccessMode = MentorMode | StudentMode;

interface Question { id: string; lead_id: string | null; member_email: string; member_name: string | null; question: string; submitted_at: string; status: string; source: string; }
interface EnrichedParticipant {
  id: string; member_email: string; member_name: string | null; lead_id: string | null;
  hand_raised_at: string | null; questions_count: number; entered_at: string; left_at: string | null;
  org_id: string | null; org_name: string | null;
  days_as_client: number | null;
  health_score: number | null; health_status: string | null; lead_avatar: string | null;
}

const LIVEKIT_URL = 'wss://iap-isclypwt.livekit.cloud';

type ChatMsg = {
  id: string;
  from: string;
  isMentor: boolean;
  text: string;
  ts: number;
  media_url?: string;
  media_type?: 'image' | 'file';
  media_filename?: string;
  media_size?: number;
};

async function getLiveKitToken(params: { roomName: string; participantName: string; role: 'host' | 'guest'; metadata?: any }) {
  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: { room_name: params.roomName, participant_name: params.participantName, role: params.role, metadata: params.metadata },
  });
  if (error || !data?.token) throw new Error(error?.message || 'Falha ao gerar token');
  return data as { token: string; url: string };
}

// ─── Avatar ───
function Avatar({ name, email, size = 'md', ring = false, photoUrl }: { name?: string; email: string; size?: 'sm' | 'md' | 'lg' | 'xl'; ring?: boolean; photoUrl?: string | null }) {
  const hue = getHue(email);
  const initials = getInitials(name || email);
  const sizes = { sm: 'w-7 h-7 text-[10px]', md: 'w-9 h-9 text-xs', lg: 'w-12 h-12 text-sm', xl: 'w-16 h-16 text-lg' };
  if (photoUrl) {
    return (
      <img src={photoUrl} alt={name || email} className={cn('rounded-full object-cover shrink-0 shadow-lg', sizes[size], ring && 'ring-2 ring-[#FF6B35]/40 ring-offset-2 ring-offset-zinc-950')} />
    );
  }
  return (
    <div
      className={cn('relative rounded-full flex items-center justify-center font-bold text-white shrink-0 shadow-lg', sizes[size], ring && 'ring-2 ring-[#FF6B35]/40 ring-offset-2 ring-offset-zinc-950')}
      style={{ background: `linear-gradient(135deg, hsl(${hue}, 70%, 55%), hsl(${(hue + 40) % 360}, 75%, 40%))` }}
    >
      {initials}
    </div>
  );
}

// Health badge ao lado do nome
function HealthDot({ score }: { score: number | null }) {
  if (score === null) return <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" title="Sem health" />;
  const color = score >= 70 ? 'bg-emerald-400' : score >= 40 ? 'bg-amber-400' : 'bg-red-400';
  return <span className={cn('w-1.5 h-1.5 rounded-full', color)} title={`Health ${score}`} />;
}

// ─── Main Component ───
export default function MentoringRoom() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { teamMember } = useAuth();

  const jwt = searchParams.get('token');
  const isPublic = searchParams.get('pub') === '1';
  const [mode, setMode] = useState<AccessMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [participantDbId, setParticipantDbId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [showNps, setShowNps] = useState(false);

  useEffect(() => {
    if (!sessionId) { setError('Sessão não encontrada'); setLoading(false); return; }
    (async () => {
      try {
        let session: any = null;

        if (isPublic) {
          // Entrada via link público: pegar dados do sessionStorage (gravado pelo MentoringPublicJoin)
          // RLS de mentoring_sessions impede leitura anônima — confiamos no payload já vindo da edge fn pública.
          const stored = sessionStorage.getItem(`mentoria_pub_${sessionId}`);
          if (!stored) { setError('Acesso público expirado, abra o link novamente'); setLoading(false); return; }
          let pub: any;
          try { pub = JSON.parse(stored); } catch { setError('Dados de acesso inválidos'); setLoading(false); return; }
          if (!pub.livekit_token || !pub.room_name) { setError('Token público inválido'); setLoading(false); return; }
          setRoomName(pub.room_name);
          const m: StudentMode = {
            kind: 'student',
            email: pub.member_email,
            memberName: pub.member_name || pub.member_email,
            phone: undefined,
            externalId: undefined,
            leadId: pub.lead_id || null,
            sessionId,
            sessionTitle: pub.session_title || 'Mentoria',
            sessionStartedAt: pub.session_started_at || null,
          };
          setMode(m);
          setParticipantDbId(pub.participant_id);
          setToken(pub.livekit_token);
        } else if (jwt) {
          const { data: verify, error: verifyErr } = await supabase.functions.invoke('mentoring-jwt-verify', { body: { token: jwt, session_id: sessionId } });
          if (verifyErr || !verify?.valid) { setError('Link inválido ou expirado'); setLoading(false); return; }
          session = verify.session;
          if (!session) { setError('Sessão não encontrada'); setLoading(false); return; }
          setRoomName(session.livekit_room_name);

          const m: StudentMode = {
            kind: 'student',
            email: verify.member.email,
            memberName: verify.member.name || verify.member.email,
            phone: verify.member.phone,
            externalId: verify.member.external_id,
            leadId: verify.lead?.id || null,
            sessionId,
            sessionTitle: session.title,
            sessionStartedAt: session.started_at || null,
          };
          setMode(m);

          const { data: partResp } = await supabase.functions.invoke('mentoring-actions', {
            body: { action: 'join_session', session_id: sessionId, email: m.email, name: m.memberName, phone: m.phone, external_id: m.externalId, lead_id: m.leadId },
          });
          if (partResp?.participant?.id) setParticipantDbId(partResp.participant.id);

          const lk = await getLiveKitToken({ roomName: session.livekit_room_name, participantName: m.memberName, role: 'guest', metadata: { lead_id: m.leadId, email: m.email } });
          setToken(lk.token);
        } else if (teamMember) {
          const { data: mentorSession } = await supabase.from('mentoring_sessions').select('id, title, livekit_room_name, status, started_at').eq('id', sessionId).maybeSingle();
          if (!mentorSession) { setError('Sessão não encontrada'); setLoading(false); return; }
          session = mentorSession;
          setRoomName(session.livekit_room_name);

          const m: MentorMode = { kind: 'mentor', memberId: teamMember.id, memberName: teamMember.name, sessionId, sessionTitle: session.title, sessionStartedAt: session.started_at || new Date().toISOString() };
          setMode(m);
          const lk = await getLiveKitToken({ roomName: session.livekit_room_name, participantName: teamMember.name, role: 'host', metadata: { team_member_id: teamMember.id } });
          setToken(lk.token);

          if (session.status === 'scheduled') {
            await supabase.functions.invoke('mentoring-actions', { body: { action: 'start_session', session_id: sessionId } });
          }
        } else {
          setError('Faça login pra entrar como mentor'); setLoading(false); return;
        }
        setLoading(false);
      } catch (e: any) { setError(e.message); setLoading(false); }
    })();
  }, [sessionId, jwt, teamMember, isPublic]);

  const handleDisconnect = async () => {
    if (mode?.kind === 'student' && participantDbId) {
      await supabase.functions.invoke('mentoring-actions', { body: { action: 'leave_session', participant_id: participantDbId } });
      setShowNps(true);
    } else if (mode?.kind === 'mentor') {
      if (roomName) supabase.functions.invoke('livekit-end-room', { body: { room_name: roomName } }).catch(() => {});
      // end_session já dispara analyze-mentoring-session server-side (que faz push pro PAIN no fim).
      // Server-side é robusto contra abort do client quando o componente re-renderiza.
      await supabase.functions.invoke('mentoring-actions', { body: { action: 'end_session', session_id: sessionId } });
      // pain-end-call-sync continua no client (só marca call_sessions.status='ended')
      supabase.functions.invoke('pain-end-call-sync', { body: { mentoring_session_id: sessionId } })
        .catch(() => {});
      setEnded(true);
    }
  };

  if (loading) return (
    <div className="min-h-screen bg-mesh bg-grain flex items-center justify-center">
      <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }} className="w-10 h-10 rounded-full border-2 border-zinc-800 border-t-[#FF6B35]" />
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-mesh bg-grain flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="text-center max-w-sm">
        <AlertCircle className="h-14 w-14 text-red-500 mx-auto mb-4" />
        <h1 className="font-display text-white text-2xl font-bold mb-2">Ops!</h1>
        <p className="text-zinc-400 text-sm">{error}</p>
      </motion.div>
    </div>
  );

  if (showNps && mode?.kind === 'student') {
    return <NpsModal sessionId={sessionId!} participantId={participantDbId} leadId={mode.leadId} email={mode.email} onDone={() => { setShowNps(false); setEnded(true); }} />;
  }

  if (ended) return (
    <div className="min-h-screen bg-mesh bg-grain flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="text-center max-w-md">
        <motion.div initial={{ scale: 0.5 }} animate={{ scale: 1 }} transition={{ type: 'spring', damping: 14 }} className="w-20 h-20 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto mb-5">
          <Smile className="h-10 w-10 text-emerald-400" />
        </motion.div>
        <h1 className="font-display text-white text-3xl font-bold tracking-tight mb-2">Valeu pela presença!</h1>
        <p className="text-zinc-400 text-sm mb-6">A próxima mentoria já está a caminho.</p>
        <Button onClick={() => navigate('/')} className="bg-gradient-to-r from-[#FF6B35] to-[#FF4500] hover:opacity-90 rounded-full px-6 brand-glow">Voltar</Button>
      </motion.div>
    </div>
  );

  if (!token || !mode || !roomName) return null;

  const isMentor = mode.kind === 'mentor';

  return (
    <LiveKitRoom
      token={token}
      serverUrl={LIVEKIT_URL}
      connect
      onDisconnected={() => { if (isMentor) setEnded(true); else setShowNps(true); }}
      video={isMentor}
      audio={isMentor}
    >
      <RoomAudioRenderer />
      <div className="mentoring-room-wrapper min-h-screen bg-mesh text-white">
        <RoomShell mode={mode} participantDbId={participantDbId} onLeave={handleDisconnect} />
      </div>
    </LiveKitRoom>
  );
}

// ─── Shell ───
function RoomShell({ mode, participantDbId, onLeave }: { mode: AccessMode; participantDbId: string | null; onLeave: () => void }) {
  const isMentor = mode.kind === 'mentor';
  const [showQueue, setShowQueue] = useState(true);
  const [selectedMember, setSelectedMember] = useState<{ email: string; name: string | null; leadId: string | null; csNote?: string | null } | null>(null);
  const [questionOpen, setQuestionOpen] = useState(false);
  const [questionSent, setQuestionSent] = useState(false);
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();

  const [stageInvite, setStageInvite] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const isMentorMode = mode.kind === 'mentor';

  // Transcrição nativa LiveKit (Agent Python Deepgram) — salva em mentoring_sessions.transcriptions
  useLiveKitTranscriptionV2(
    room as any,
    mode.sessionId,
    true,
    { tableName: 'mentoring_sessions' },
  );

  // Prompt "Perguntas?" do host pra galera (overlay central)
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [promptText, setPromptText] = useState('Perguntas?');
  // Pergunta ativa sendo exibida (quando host clica "Mostrar + responder")
  const [activeQuestion, setActiveQuestion] = useState<{ text: string; author: string } | null>(null);

  // Live queue (broadcast via DataChannel — todos veem em tempo real)
  // mãos levantadas pendentes
  const [liveHandsRaised, setLiveHandsRaised] = useState<Map<string, { name: string; identity?: string; ts: number }>>(new Map());
  // notificações volantes (toast curto pra "X levantou a mão" / "Y fez pergunta")
  const [liveNotices, setLiveNotices] = useState<{ id: number; text: string; tone: 'hand' | 'question' }[]>([]);

  const pushNotice = (text: string, tone: 'hand' | 'question') => {
    const id = Date.now() + Math.random();
    setLiveNotices((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => setLiveNotices((prev) => prev.filter((n) => n.id !== id)), 5000);
  };

  // Chat público + prompt — recebe mensagens via DataChannel
  useEffect(() => {
    if (!room) return;
    const handler = (payload: Uint8Array, participant: any) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === 'chat') {
          let isMentor = false;
          try { isMentor = !!JSON.parse(participant?.metadata || '{}').team_member_id; } catch {}
          setChatMessages((prev) => [...prev, {
            id: `${Date.now()}-${Math.random()}`,
            from: participant?.name || 'Anônimo',
            isMentor,
            text: msg.text || '',
            ts: Date.now(),
            media_url: msg.media_url,
            media_type: msg.media_type,
            media_filename: msg.media_filename,
            media_size: msg.media_size,
          }]);
          if (!chatOpen) setUnreadChat((n) => n + 1);
        } else if (msg.type === 'prompt_show') {
          setActivePrompt(msg.text || 'Perguntas?');
        } else if (msg.type === 'prompt_hide') {
          setActivePrompt(null);
        } else if (msg.type === 'question_show') {
          setActiveQuestion({ text: msg.text || '', author: msg.author || 'Aluno' });
        } else if (msg.type === 'question_hide') {
          setActiveQuestion(null);
        } else if (msg.type === 'hand_raised') {
          const key = msg.participant_id || msg.identity || `${msg.name}-${msg.ts}`;
          setLiveHandsRaised((prev) => {
            const next = new Map(prev);
            next.set(key, { name: msg.name || 'Aluno', identity: msg.identity, ts: msg.ts || Date.now() });
            return next;
          });
          pushNotice(`✋ ${msg.name || 'Aluno'} levantou a mão`, 'hand');
        } else if (msg.type === 'hand_lowered') {
          const key = msg.participant_id || msg.identity || `${msg.name}-${msg.ts}`;
          setLiveHandsRaised((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        } else if (msg.type === 'question_submitted') {
          pushNotice(`💬 ${msg.name || 'Aluno'} fez uma pergunta`, 'question');
        }
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [room, chatOpen]);

  // Limpa mão levantada do Map quando participant desconecta (sai antes de baixar a mão).
  // Sem isso o banner "X levantou a mão" persiste pra sempre porque o broadcast hand_lowered
  // nunca chega (aluno saiu da sala).
  useEffect(() => {
    if (!room) return;
    const onDisconnected = (participant: any) => {
      const identity = participant?.identity;
      if (!identity) return;
      setLiveHandsRaised((prev) => {
        // Remove qualquer entry cuja identity bate (chave pode ser participant_id OU identity)
        let changed = false;
        const next = new Map(prev);
        for (const [key, value] of prev.entries()) {
          if (value.identity === identity || key === identity) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    room.on(RoomEvent.ParticipantDisconnected, onDisconnected);
    return () => { room.off(RoomEvent.ParticipantDisconnected, onDisconnected); };
  }, [room]);

  // Sincroniza liveHandsRaised Map com o banco a cada 5s. Garante que se aluno baixou a mão
  // (banco hand_raised_at=null) ou saiu sem broadcast, a entrada some do Map e o banner
  // amarelo "X levantou a mão" desaparece — em QUALQUER cenário (broadcast falhou, sem net,
  // fechou tab antes do disconnect propagar, etc).
  useEffect(() => {
    if (!mode || !('sessionId' in mode) || !mode.sessionId) return;
    let cancelled = false;
    const sessionId = mode.sessionId;
    const sync = async () => {
      const { data, error } = await supabase
        .from('mentoring_participants')
        .select('id, hand_raised_at')
        .eq('session_id', sessionId);
      if (cancelled || error || !data) return;
      const activeIds = new Set(data.filter((p: any) => !!p.hand_raised_at).map((p: any) => p.id));
      setLiveHandsRaised((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const key of prev.keys()) {
          // key pode ser participant_id (do broadcast) ou identity (fallback)
          if (!activeIds.has(key)) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    sync();
    const i = setInterval(sync, 5000);
    return () => { cancelled = true; clearInterval(i); };
  }, [mode]);

  const showPrompt = async (text: string) => {
    if (!room || !text.trim()) return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'prompt_show', text: text.trim() }));
    await room.localParticipant.publishData(payload, { reliable: true });
    setActivePrompt(text.trim());
    setPromptEditorOpen(false);
  };
  const hidePrompt = async () => {
    if (!room) return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'prompt_hide' }));
    await room.localParticipant.publishData(payload, { reliable: true });
    setActivePrompt(null);
  };
  const hideQuestion = async () => {
    if (!room) return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'question_hide' }));
    await room.localParticipant.publishData(payload, { reliable: true });
    setActiveQuestion(null);
  };

  useEffect(() => { if (chatOpen) setUnreadChat(0); }, [chatOpen]);

  const sendChat = async (
    text: string,
    media?: { url: string; type: 'image' | 'file'; filename: string; size: number },
  ) => {
    if (!room) return;
    if (!text.trim() && !media) return;
    const body: any = { type: 'chat', text: text.trim() };
    if (media) {
      body.media_url = media.url;
      body.media_type = media.type;
      body.media_filename = media.filename;
      body.media_size = media.size;
    }
    const payload = new TextEncoder().encode(JSON.stringify(body));
    await room.localParticipant.publishData(payload, { reliable: true });
    // Adiciona localmente também (não vem de volta)
    setChatMessages((prev) => [...prev, {
      id: `${Date.now()}-me`,
      from: 'Você',
      isMentor: isMentorMode,
      text: text.trim(),
      ts: Date.now(),
      media_url: media?.url,
      media_type: media?.type,
      media_filename: media?.filename,
      media_size: media?.size,
    }]);
  };

  const requestLeave = () => {
    if (isMentorMode) setConfirmExit(true);
    else onLeave();
  };
  const confirmLeave = () => { setConfirmExit(false); onLeave(); };

  // Aluno recebe "take_stage" → modal pra aceitar (gesture válido pro mobile)
  useEffect(() => {
    if (mode.kind !== 'student' || !room) return;
    const handler = async (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === 'take_stage') {
          setStageInvite(true);
        } else if (msg.type === 'leave_stage') {
          setStageInvite(false);
          await localParticipant.setCameraEnabled(false);
          await localParticipant.setMicrophoneEnabled(false);
        } else if (msg.type === 'focus_mode') {
          setFocusMode(!!msg.enabled);
        }
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [mode.kind, room, localParticipant]);

  // Mentor recebe "focus_mode" sync (do próprio botão local)
  const acceptStage = async () => {
    try {
      await localParticipant.setCameraEnabled(true);
      await localParticipant.setMicrophoneEnabled(true);
      // Confirma ao host (e a todos) que tá no palco — VideoStage libera o render
      if (room) {
        const payload = new TextEncoder().encode(JSON.stringify({ type: 'take_stage_confirmed' }));
        await room.localParticipant.publishData(payload, { reliable: true });
      }
    } catch {}
    setStageInvite(false);
  };
  const declineStage = () => setStageInvite(false);

  return (
    <div className="flex flex-col h-[100dvh]">
      <Header startedAt={('sessionStartedAt' in mode) ? mode.sessionStartedAt : null} />
      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 min-w-0 relative flex flex-col">
          <VideoStage
            mode={mode}
            onAskQuestion={() => setQuestionOpen(true)}
            questionSent={questionSent}
            chatMessages={chatMessages}
            onPickStudent={async (email) => {
              if (mode.kind !== 'mentor') return;
              const { data } = await supabase
                .from('mentoring_participants')
                .select('member_email, member_name, lead_id')
                .eq('session_id', mode.sessionId)
                .eq('member_email', email)
                .maybeSingle();
              setSelectedMember({ email, name: data?.member_name || null, leadId: data?.lead_id || null });
            }}
          />
          {mode.kind === 'student' && <FloatingQuestionCTA onClick={() => setQuestionOpen(true)} hasSent={questionSent} />}
          <BackgroundBlurToggle />
          {isMentor && <ScreenShareTip />}

          {/* Live notices: aparecem pra TODOS quando alguém levanta mão / faz pergunta */}
          <div className="absolute top-20 right-4 z-30 flex flex-col gap-2 pointer-events-none">
            <AnimatePresence>
              {liveNotices.map((n) => (
                <motion.div
                  key={n.id}
                  initial={{ opacity: 0, x: 40, scale: 0.9 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 40, scale: 0.9 }}
                  transition={{ type: 'spring', damping: 22, stiffness: 280 }}
                  className={cn(
                    'px-3.5 py-2 rounded-xl backdrop-blur-md text-white text-xs font-semibold shadow-lg border',
                    n.tone === 'hand'
                      ? 'bg-amber-500/90 border-amber-300/40'
                      : 'bg-[#FF6B35]/90 border-[#FF6B35]/30',
                  )}
                >
                  {n.text}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {/* Contador de mãos levantadas em tempo real (visível pra todos) */}
          <AnimatePresence>
            {liveHandsRaised.size > 0 && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-amber-500/90 backdrop-blur rounded-full px-4 py-1.5 text-xs text-white font-bold flex items-center gap-2 shadow-lg pointer-events-none"
              >
                <Hand className="w-3.5 h-3.5" />
                {liveHandsRaised.size === 1
                  ? `${Array.from(liveHandsRaised.values())[0].name} levantou a mão`
                  : `${liveHandsRaised.size} pessoas com a mão levantada`}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Overlay com pergunta específica sendo respondida pelo host */}
          <AnimatePresence>
            {activeQuestion && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                transition={{ type: 'spring', damping: 22, stiffness: 200 }}
                className="absolute bottom-28 left-1/2 -translate-x-1/2 z-30 max-w-2xl w-[90%] pointer-events-none"
              >
                <div className="bg-gradient-to-br from-zinc-900/95 to-zinc-950/95 backdrop-blur-xl border-2 border-[#FF6B35]/50 rounded-3xl px-6 py-4 shadow-2xl brand-glow pointer-events-auto">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#FF6B35] to-[#FF4500] flex items-center justify-center shrink-0">
                      <MessageSquare className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-[#FF6B35] font-bold uppercase tracking-wider">Pergunta de {activeQuestion.author}</p>
                      <p className="text-white text-lg font-semibold leading-snug mt-0.5 whitespace-pre-wrap">{activeQuestion.text}</p>
                    </div>
                    <button
                      onClick={isMentorMode ? hideQuestion : () => setActiveQuestion(null)}
                      className="shrink-0 text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-800"
                      title={isMentorMode ? 'Esconder pra todos' : 'Fechar (só pra mim)'}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Overlay "Perguntas?" pros alunos (broadcast do host) */}
          <AnimatePresence>
            {activePrompt && mode.kind === 'student' && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: 'spring', damping: 20, stiffness: 250 }}
                className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none"
              >
                <div className="bg-gradient-to-br from-[#FF6B35] to-[#FF4500] rounded-3xl px-12 py-8 shadow-2xl pointer-events-auto border-4 border-white/20 relative">
                  <button
                    onClick={() => setActivePrompt(null)}
                    className="absolute top-3 right-3 text-white/70 hover:text-white p-1 rounded-full hover:bg-white/10 transition"
                    aria-label="Fechar aviso"
                  >
                    <X className="h-5 w-5" />
                  </button>
                  <div className="text-center">
                    <p className="font-display text-5xl font-bold text-white mb-4">{activePrompt}</p>
                    <div className="flex gap-2 justify-center">
                      <button
                        onClick={() => setQuestionOpen(true)}
                        className="bg-white text-[#FF4500] rounded-full px-6 py-2.5 text-sm font-bold hover:scale-105 transition"
                      >
                        Fazer pergunta
                      </button>
                      <button
                        onClick={() => setActivePrompt(null)}
                        className="bg-white/20 text-white rounded-full px-5 py-2.5 text-sm font-medium hover:bg-white/30 transition"
                      >
                        Agora não
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
            {activePrompt && isMentor && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-[#FF6B35]/90 backdrop-blur rounded-full px-4 py-1.5 text-xs text-white font-semibold flex items-center gap-2 shadow-lg"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                Prompt ativo: "{activePrompt}"
                <button onClick={hidePrompt} className="ml-2 underline hover:no-underline">Fechar</button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Editor do prompt (modal do host) */}
          <AnimatePresence>
            {promptEditorOpen && isMentor && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-8"
                onClick={() => setPromptEditorOpen(false)}
              >
                <motion.div
                  initial={{ scale: 0.95 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0.95 }}
                  onClick={(e) => e.stopPropagation()}
                  className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-md w-full"
                >
                  <h3 className="text-white font-bold text-lg mb-1">Exibir mensagem na tela</h3>
                  <p className="text-zinc-400 text-xs mb-4">Aparece pra todos os alunos (grande, no centro)</p>
                  <input
                    autoFocus
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') showPrompt(promptText); }}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white text-lg font-semibold focus:outline-none focus:border-[#FF6B35]"
                    placeholder="Perguntas?"
                  />
                  <div className="flex gap-2 mt-4">
                    <Button variant="outline" className="flex-1" onClick={() => setPromptEditorOpen(false)}>Cancelar</Button>
                    <Button className="flex-1 bg-[#FF6B35] hover:bg-[#FF4500] text-white" onClick={() => showPrompt(promptText)}>
                      Exibir pra todos
                    </Button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          <ControlsBar
            mode={mode}
            participantDbId={participantDbId}
            onLeave={requestLeave}
            onAskQuestion={() => setQuestionOpen(true)}
            onToggleChat={() => setChatOpen(!chatOpen)}
            unreadChat={unreadChat}
            chatOpen={chatOpen}
            onOpenPrompt={() => setPromptEditorOpen(true)}
            onHidePrompt={hidePrompt}
            activePrompt={activePrompt}
          />
        </main>
        {isMentor && showQueue && (
          <aside className="w-[380px] border-l border-zinc-800/60 flex flex-col">
            <MentorPanel sessionId={mode.sessionId} onSelectMember={setSelectedMember} onClose={() => setShowQueue(false)} onShowQuestion={setActiveQuestion} />
          </aside>
        )}
      </div>
      {isMentor && !showQueue && (
        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setShowQueue(true)} className="fixed right-4 bottom-28 bg-gradient-to-br from-[#FF6B35] to-[#FF4500] text-white rounded-2xl p-3 shadow-lg shadow-[#FF6B35]/30 z-20 brand-glow">
          <Users className="h-5 w-5" />
        </motion.button>
      )}

      {/* Painel de chat */}
      <AnimatePresence>
        {chatOpen && (
          <ChatPanel
            messages={chatMessages}
            onSend={sendChat}
            onClose={() => setChatOpen(false)}
            myName={mode.kind === 'mentor' ? mode.memberName : mode.memberName}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {isMentor && selectedMember && <LeadDossierPanel member={selectedMember} onClose={() => setSelectedMember(null)} />}
      </AnimatePresence>

      {questionOpen && mode.kind === 'student' && (
        <QuestionModal
          mode={mode}
          participantDbId={participantDbId}
          onClose={() => setQuestionOpen(false)}
          onSent={() => setQuestionSent(true)}
        />
      )}

      {/* Modal confirmar saída do mentor */}
      {confirmExit && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
          <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="card-premium rounded-3xl max-w-md w-full p-7 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center">
              <PhoneOff className="w-8 h-8 text-red-400" />
            </div>
            <h2 className="font-display text-2xl font-bold text-white mb-2">Encerrar a mentoria?</h2>
            <p className="text-zinc-400 text-sm mb-6">
              Ao sair, a call será encerrada <span className="font-semibold text-white">para todos os alunos</span>.
              A gravação será finalizada e a sala fechada. Esta ação não pode ser desfeita.
            </p>
            <div className="flex gap-2">
              <Button onClick={() => setConfirmExit(false)} variant="outline" className="flex-1 bg-transparent border-zinc-800 text-zinc-300 hover:bg-zinc-800/60 rounded-xl">Cancelar</Button>
              <Button onClick={confirmLeave} className="flex-1 bg-red-500 hover:bg-red-600 text-white rounded-xl font-semibold">
                <PhoneOff className="h-4 w-4 mr-2" /> Encerrar agora
              </Button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Modal de "Você foi chamado!" pro aluno */}
      {stageInvite && mode.kind === 'student' && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
          <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="card-premium rounded-3xl max-w-md w-full p-7 text-center">
            <motion.div animate={{ scale: [1, 1.1, 1] }} transition={{ duration: 1.5, repeat: Infinity }} className="w-20 h-20 mx-auto mb-5 rounded-full bg-gradient-to-br from-[#FF6B35] to-[#FF4500] flex items-center justify-center shadow-2xl brand-glow">
              <Hand className="h-10 w-10 text-white" />
            </motion.div>
            <h2 className="font-display text-2xl font-bold text-white mb-2">Você foi chamado!</h2>
            <p className="text-zinc-400 text-sm mb-6">O mentor te deu a palavra. Liga câmera e microfone pra falar?</p>
            <div className="flex gap-2">
              <Button onClick={declineStage} variant="outline" className="flex-1 bg-transparent border-zinc-800 text-zinc-300 hover:bg-zinc-800/60 rounded-xl">Agora não</Button>
              <Button onClick={acceptStage} className="flex-1 bg-gradient-to-r from-[#FF6B35] to-[#FF4500] hover:opacity-90 rounded-xl brand-glow">
                <Mic className="h-4 w-4 mr-2" /> Aceitar
              </Button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}

// ─── Header ───
function Header({ startedAt }: { startedAt: string | null }) {
  const participants = useParticipants();
  const [elapsed, setElapsed] = useState('00:00');
  const startMs = startedAt ? new Date(startedAt).getTime() : Date.now();

  useEffect(() => {
    const i = setInterval(() => {
      const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      setElapsed(`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`);
    }, 1000);
    return () => clearInterval(i);
  }, [startMs]);

  return (
    <header className="h-16 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-xl flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/15 border border-red-500/30">
          <div className="w-2 h-2 rounded-full bg-red-500 live-dot" />
          <span className="text-red-400 text-[10px] font-bold uppercase tracking-[0.2em]">Ao vivo</span>
        </div>
        <span className="font-mono text-zinc-400 text-sm tabular-nums">{elapsed}</span>
      </div>
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-zinc-500" />
          <span className="font-mono text-zinc-300 text-sm font-semibold tabular-nums">{participants.length}</span>
        </div>
      </div>
    </header>
  );
}

// ─── VideoStage ───
function VideoStage({ mode, onAskQuestion, questionSent, onPickStudent, chatMessages }: { mode: AccessMode; onAskQuestion: () => void; questionSent: boolean; onPickStudent?: (email: string) => void; chatMessages?: ChatMsg[] }) {
  const room = useRoomContext();
  const isMentor = mode.kind === 'mentor';
  const allParticipants = useParticipants();

  // Quem o host autorizou a subir ao palco (identity do aluno). Null = palco fechado.
  const [allowedStageIdentity, setAllowedStageIdentity] = useState<string | null>(null);

  const removeFromStage = async (participantIdentity: string) => {
    if (!room || !isMentor) return;
    // Notifica o aluno pra desligar câmera/mic
    const leaveData = new TextEncoder().encode(JSON.stringify({ type: 'leave_stage' }));
    await room.localParticipant.publishData(leaveData, { reliable: true, destinationIdentities: [participantIdentity] });
    // Broadcast pra todos: palco liberado
    const broadcastData = new TextEncoder().encode(JSON.stringify({ type: 'stage_set', identity: null }));
    await room.localParticipant.publishData(broadcastData, { reliable: true });
    setAllowedStageIdentity(null);
  };

  // Host: quando chama take_stage, broadcast o identity autorizado
  useEffect(() => {
    if (!room || !isMentor) return;
    const handler = (payload: Uint8Array, participant: any) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === 'take_stage_confirmed' && participant?.identity) {
          setAllowedStageIdentity(participant.identity);
          // Broadcast pra audiência saber quem tá no palco
          const broadcast = new TextEncoder().encode(JSON.stringify({ type: 'stage_set', identity: participant.identity }));
          room.localParticipant.publishData(broadcast, { reliable: true });
        }
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [room, isMentor]);

  // Aluno/audiência: escuta stage_set do host pra saber quem está no palco
  useEffect(() => {
    if (!room || isMentor) return;
    const handler = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === 'stage_set') setAllowedStageIdentity(msg.identity ?? null);
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [room, isMentor]);

  // Tracks de câmera + compartilhamento de tela (com placeholder=false)
  const cameraTracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: false }]);
  const screenTracks = useTracks([{ source: Track.Source.ScreenShare, withPlaceholder: false }]);

  // Modo de visualização: 'palco' (host+aluno grande) OU 'galeria' (grid todos iguais).
  // Persiste em localStorage — cada user mantém sua preferência entre reuniões.
  const [viewMode, setViewMode] = useState<'palco' | 'galeria'>(() => {
    if (typeof window === 'undefined') return 'palco';
    return (localStorage.getItem('mentoring-view-mode') as any) || 'palco';
  });
  useEffect(() => {
    try { localStorage.setItem('mentoring-view-mode', viewMode); } catch {}
  }, [viewMode]);

  // ─── Document Picture-in-Picture (Chrome/Edge) ───
  // Quando o USER LOCAL começa a compartilhar tela, abre uma janela do OS
  // flutuando por cima de tudo com as câmeras dos outros participantes.
  // Ideal pra ver reações da audiência enquanto apresenta em PowerPoint/etc.
  // Fecha automaticamente ao parar o share ou trocar de sala.
  const { localParticipant } = useLocalParticipant();
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  useEffect(() => {
    const isSharing = localParticipant?.isScreenShareEnabled;
    const supportsPip = typeof window !== 'undefined' && 'documentPictureInPicture' in window;
    if (!isSharing || !supportsPip) {
      // Fecha se estava aberta
      if (pipWindow) {
        try { pipWindow.close(); } catch {}
        setPipWindow(null);
      }
      return;
    }
    if (pipWindow) return; // já aberta

    let cancelled = false;
    (async () => {
      try {
        const pip = await (window as any).documentPictureInPicture.requestWindow({
          width: 340,
          height: 620,
        });
        if (cancelled) { pip.close(); return; }

        // Copia stylesheets do documento pai pra dentro do PiP window (Tailwind etc.)
        try {
          for (const sheet of Array.from(document.styleSheets)) {
            try {
              const rules = Array.from((sheet as any).cssRules || []).map((r: any) => r.cssText).join('\n');
              const style = pip.document.createElement('style');
              style.textContent = rules;
              pip.document.head.appendChild(style);
            } catch {
              // stylesheet cross-origin — clona só o link
              if ((sheet as any).href) {
                const link = pip.document.createElement('link');
                link.rel = 'stylesheet';
                link.href = (sheet as any).href;
                pip.document.head.appendChild(link);
              }
            }
          }
        } catch (err) {
          console.warn('[PiP] copiar styles falhou:', err);
        }

        pip.document.body.style.margin = '0';
        pip.document.body.style.background = '#09090b';
        pip.document.title = 'Alunos ao vivo';

        // Handler pra quando o usuário fechar a janela manualmente
        pip.addEventListener('pagehide', () => setPipWindow(null));

        setPipWindow(pip);
      } catch (err) {
        console.warn('[PiP] requestWindow falhou:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [localParticipant?.isScreenShareEnabled, pipWindow]);

  const { mainTrack, secondaryTrack, isScreenSharing } = React.useMemo(() => {
    const hostCamera = cameraTracks.find((t) => {
      try { return !!JSON.parse(t.participant.metadata || '{}').team_member_id; } catch { return false; }
    });
    // Screen share: PRIORIZA host. Se host não tá compartilhando, pega de qualquer aluno.
    const hostScreen = screenTracks.find((t) => {
      try { return !!JSON.parse(t.participant.metadata || '{}').team_member_id; } catch { return false; }
    });
    const studentScreen = screenTracks.find((t) => {
      try { return !JSON.parse(t.participant.metadata || '{}').team_member_id; } catch { return true; }
    });
    const activeScreen = hostScreen || studentScreen;
    // onStage: só aluno autorizado com câmera publicada
    let onStage = null;
    if (allowedStageIdentity) {
      onStage = cameraTracks.find((t) => {
        if (t === hostCamera) return false;
        if (t.participant.identity !== allowedStageIdentity) return false;
        const pub: any = t.publication;
        return pub && pub.track && !pub.isMuted;
      });
    }
    // Main: screen share (se houver) > camera host; Secondary: aluno no palco OU camera host (se tela tá compartilhando)
    if (activeScreen) {
      return { mainTrack: activeScreen, secondaryTrack: onStage || hostCamera || null, isScreenSharing: true };
    }
    return { mainTrack: hostCamera || null, secondaryTrack: onStage || null, isScreenSharing: false };
  }, [cameraTracks, screenTracks, allowedStageIdentity]);
  const isStudent = mode.kind === 'student';

  // Audience: todos exceto host e quem está no palco
  const stageIdentities = new Set([mainTrack?.participant.identity, secondaryTrack?.participant.identity].filter(Boolean) as string[]);
  const audience = allParticipants.filter((p) => !stageIdentities.has(p.identity));
  const audienceTrackByIdentity = new Map(cameraTracks.filter((t) => !stageIdentities.has(t.participant.identity)).map((t) => [t.participant.identity, t]));

  // Galeria: TODAS as câmeras (host + audience) num grid igual. Screen share
  // sempre tem prioridade — em share ativo, ignora modo galeria pra não perder a tela.
  const galleryMode = viewMode === 'galeria' && !isScreenSharing;

  // Toggle Palco/Galeria (aparece em ambos os modos, canto superior esquerdo).
  const modeToggle = cameraTracks.length >= 2 && !isScreenSharing ? (
    <div className="absolute top-8 left-8 z-40 flex items-center gap-1 p-1 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 shadow-2xl">
      <button
        onClick={() => setViewMode('palco')}
        className={cn(
          'px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-all',
          viewMode === 'palco' ? 'bg-[#FF6B35] text-white shadow-lg' : 'text-zinc-400 hover:text-white',
        )}
        title="Palco: você grande, alunos embaixo"
      >
        Palco
      </button>
      <button
        onClick={() => setViewMode('galeria')}
        className={cn(
          'px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-all',
          viewMode === 'galeria' ? 'bg-[#FF6B35] text-white shadow-lg' : 'text-zinc-400 hover:text-white',
        )}
        title="Galeria: todos juntos em grid"
      >
        Galeria
      </button>
    </div>
  ) : null;

  // Early return: modo Galeria renderiza grid limpo, sem palco.
  if (galleryMode) {
    return (
      <div className="flex-1 p-6 flex flex-col gap-4 min-h-0 bg-grain relative">
        {modeToggle}
        <GalleryGrid cameraTracks={cameraTracks} onPickStudent={onPickStudent} isMentor={isMentor} />
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 flex flex-col gap-4 min-h-0 bg-grain">
      {modeToggle}
      <div className={cn(
        'flex-1 min-h-0 relative transition-all duration-500',
        // Screen share: main full + secondary vira PIP no canto. Câmera lado a lado: grid 50/50.
        isScreenSharing ? 'block' : 'grid gap-6',
        !isScreenSharing && (secondaryTrack ? 'grid-cols-[1fr_1fr]' : 'grid-cols-1'),
      )}>
        {mainTrack ? (
          // Container do mainTrack: <div> puro (SEM motion.div layout).
          // motion.div layout aplica transform: scale(scaleX, scaleY) durante transições e
          // pode ficar com scale assimétrico stuck → vídeo aparece esticado horizontal.
          // Sempre w-full h-full pra ocupar a célula do grid; o object-fit do vídeo controla o conteúdo.
          <div className="relative rounded-3xl overflow-hidden bg-zinc-950 border border-zinc-800/60 shadow-2xl shadow-black/50 w-full h-full">
            <ParticipantTile
              key={mainTrack.participant.identity}
              trackRef={mainTrack}
              disableSpeakingIndicator
              className={cn(
                '!border-0 !rounded-3xl',
                isScreenSharing ? '[&_video]:!object-contain [&_video]:!w-full [&_video]:!h-full' : '[&_video]:!object-cover',
              )}
            />
            <div className="absolute bottom-4 left-4 flex items-center gap-2">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10">
                <div className="w-1.5 h-1.5 rounded-full bg-[#FF6B35] live-dot" />
                <span className="text-white text-sm font-semibold">{mainTrack.participant.name || 'Mentor'}</span>
                {(() => {
                  const isHost = (() => { try { return !!JSON.parse(mainTrack.participant.metadata || '{}').team_member_id; } catch { return false; } })();
                  if (isScreenSharing && !isHost) {
                    return <span className="text-emerald-400 text-[10px] font-bold tracking-wider uppercase ml-1">Compartilhando</span>;
                  }
                  if (isScreenSharing && isHost) {
                    return <span className="text-[#FF6B35] text-[10px] font-bold tracking-wider uppercase ml-1">Host · Tela</span>;
                  }
                  return <span className="text-[#FF6B35] text-[10px] font-bold tracking-wider uppercase ml-1">Host</span>;
                })()}
              </div>
            </div>
            {mainTrack.participant.isSpeaking && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute top-4 left-4 flex items-center gap-1 px-2 py-1 rounded-md bg-[#FF6B35]/15 backdrop-blur-sm border border-[#FF6B35]/30">
                {[0, 1, 2].map((i) => (
                  <motion.div key={i} className="w-0.5 bg-[#FF6B35] rounded-full" animate={{ height: ['4px', '12px', '4px'] }} transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }} />
                ))}
              </motion.div>
            )}
          </div>
        ) : isStudent ? (
          <WaitingMentor sessionTitle={mode.sessionTitle} studentName={mode.memberName} onAskQuestion={onAskQuestion} questionSent={questionSent} />
        ) : (
          <div className="relative rounded-3xl bg-zinc-950 border border-zinc-800/60 flex items-center justify-center overflow-hidden">
            <div className="text-center">
              <div className="relative w-20 h-20 mx-auto mb-5">
                <motion.div className="absolute inset-0 rounded-full border-2 border-[#FF6B35]/30" animate={{ scale: [1, 1.3, 1], opacity: [1, 0, 1] }} transition={{ duration: 2, repeat: Infinity }} />
                <div className="absolute inset-2 rounded-full bg-[#FF6B35]/10 flex items-center justify-center"><VideoIcon className="w-8 h-8 text-[#FF6B35]" /></div>
              </div>
              <p className="text-white font-display font-bold text-lg mb-1">Studio pronto</p>
              <p className="text-zinc-500 text-sm">Ative sua câmera pra começar</p>
            </div>
          </div>
        )}

        <AnimatePresence>
          {secondaryTrack && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, x: 40 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.9, x: 40 }}
              transition={{ type: 'spring', damping: 22, stiffness: 180 }}
              className={cn(
                'relative rounded-3xl overflow-hidden bg-zinc-950 border-2 border-[#FF6B35]/50 shadow-2xl brand-glow',
                // Em screen share: PIP flutuante no canto inferior direito (~22% da largura, máx 320px)
                isScreenSharing
                  ? 'absolute bottom-4 right-4 w-[22%] min-w-[180px] max-w-[320px] aspect-video z-10'
                  : 'aspect-video max-h-full',
              )}
            >
              <ParticipantTile key={secondaryTrack.participant.identity} trackRef={secondaryTrack} disableSpeakingIndicator className="!border-0 !rounded-3xl [&_video]:!object-cover" />
              <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
              <div className="absolute bottom-4 left-4">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#FF6B35] text-white text-sm font-semibold shadow-lg">
                  <Hand className="w-3.5 h-3.5" strokeWidth={2.5} />
                  {secondaryTrack.participant.name}
                </div>
              </div>
              {isMentor && (
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => removeFromStage(secondaryTrack.participant.identity)}
                  className="absolute top-3 right-3 bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 shadow-lg z-10"
                  title="Devolver à audiência"
                >
                  <X className="w-3.5 h-3.5" strokeWidth={2.5} />
                  Devolver
                </motion.button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {audience.length > 0 && !isScreenSharing && (
        <AudienceStrip
          participants={audience}
          tracksByIdentity={audienceTrackByIdentity}
          isMentor={isMentor}
          onPickStudent={onPickStudent}
        />
      )}
      {/* Zoom-style: durante screen share, thumbnails flutuam no canto */}
      {audience.length > 0 && isScreenSharing && (
        <AudiencePipOverlay
          participants={audience}
          tracksByIdentity={audienceTrackByIdentity}
          isMentor={isMentor}
          onPickStudent={onPickStudent}
        />
      )}
      {/* Document PiP window (Chrome/Edge): renderiza câmeras dos remotos
          numa janela do SO que flutua por cima de qualquer app (PowerPoint,
          Chrome, etc). Só aparece quando eu compartilho E o browser suporta. */}
      {pipWindow && createPortal(
        <PipStagePortal
          cameraTracks={cameraTracks.filter((t) => !t.participant.isLocal)}
          chatMessages={chatMessages || []}
        />,
        pipWindow.document.body,
      )}
    </div>
  );
}

// ─── PipStagePortal ───
// Renderiza dentro da Document PiP window. Câmeras em cima + chat embaixo.
function PipStagePortal({ cameraTracks, chatMessages }: { cameraTracks: any[]; chatMessages: ChatMsg[] }) {
  const N = cameraTracks.length;
  const cols = N <= 1 ? 1 : 2;
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Auto-scroll pro fim quando nova msg chega
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chatMessages.length]);

  const lastMessages = chatMessages.slice(-30); // últimas 30 pra não pesar

  return (
    <div style={{
      width: '100%',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#09090b',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxSizing: 'border-box',
    }}>
      {/* Câmeras: ~70% da altura */}
      <div style={{
        flex: '0 0 70%',
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: '4px',
        padding: '4px',
        boxSizing: 'border-box',
        minHeight: 0,
      }}>
        {cameraTracks.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a', fontSize: '11px' }}>
            Nenhum aluno com câmera
          </div>
        ) : cameraTracks.slice(0, 4).map((t) => {
          const name = t.participant.name || (() => { try { return JSON.parse(t.participant.metadata || '{}').email; } catch { return t.participant.identity; } })();
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

      {/* Chat: ~30% da altura */}
      <div style={{
        flex: '1 1 30%',
        display: 'flex',
        flexDirection: 'column',
        background: '#0f0f11',
        borderTop: '1px solid #27272a',
        minHeight: 0,
      }}>
        <div style={{
          padding: '6px 10px',
          fontSize: '10px',
          fontWeight: 700,
          color: '#a1a1aa',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          borderBottom: '1px solid #27272a',
          background: '#18181b',
        }}>
          Chat da mentoria
        </div>
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          minHeight: 0,
        }}>
          {lastMessages.length === 0 ? (
            <div style={{ color: '#52525b', fontSize: '11px', textAlign: 'center', marginTop: '20px' }}>
              Sem mensagens ainda
            </div>
          ) : lastMessages.map((m) => (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
              <div style={{ fontSize: '10px', fontWeight: 600, color: m.isMentor ? '#FF6B35' : '#a1a1aa' }}>
                {m.from}
              </div>
              {m.text && (
                <div style={{
                  fontSize: '12px',
                  color: '#f4f4f5',
                  wordBreak: 'break-word',
                  lineHeight: 1.35,
                }}>{m.text}</div>
              )}
              {m.media_url && m.media_type === 'image' && (
                <img src={m.media_url} alt="" style={{ maxWidth: '100%', borderRadius: '4px', marginTop: '2px' }} />
              )}
              {m.media_url && m.media_type === 'file' && (
                <div style={{ fontSize: '11px', color: '#71717a', fontStyle: 'italic' }}>📎 {m.media_filename || 'arquivo'}</div>
              )}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
      </div>
    </div>
  );
}

// ─── GalleryGrid ───
// Modo Galeria: todas as câmeras em grid igual (Zoom/Meet style).
// Grid auto-adaptativo baseado em quantos participantes têm câmera.
function GalleryGrid({
  cameraTracks, isMentor, onPickStudent,
}: {
  cameraTracks: any[];
  isMentor: boolean;
  onPickStudent?: (email: string) => void;
}) {
  const N = cameraTracks.length;
  // Grid ideal: 1=1, 2=2, 3-4=2x2, 5-6=3x2, 7-9=3x3, 10-12=4x3, 13-16=4x4, 17+=5col
  const cols = N <= 1 ? 1 : N <= 2 ? 2 : N <= 4 ? 2 : N <= 6 ? 3 : N <= 9 ? 3 : N <= 12 ? 4 : N <= 16 ? 4 : 5;

  if (N === 0) {
    return (
      <div className="flex-1 min-h-0 rounded-3xl bg-zinc-950 border border-zinc-800/60 flex items-center justify-center">
        <div className="text-center">
          <VideoIcon className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">Nenhuma câmera ligada</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 min-h-0 grid gap-3"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {cameraTracks.map((t) => {
        const meta = (() => { try { return JSON.parse(t.participant.metadata || '{}'); } catch { return {}; } })();
        const email: string | undefined = meta.email;
        const isHost = !!meta.team_member_id;
        const name: string = t.participant.name || meta.member_name || email || 'Participante';
        const speaking = t.participant.isSpeaking;

        return (
          <button
            key={t.participant.identity}
            onClick={() => isMentor && email && onPickStudent?.(email)}
            disabled={!isMentor || !email}
            className={cn(
              'relative rounded-2xl overflow-hidden bg-zinc-950 border-2 shadow-xl transition-all min-h-0',
              speaking ? 'border-[#FF6B35] shadow-[0_0_0_2px_rgba(255,107,53,0.4)]' : 'border-zinc-800/60',
              isMentor && email ? 'hover:border-[#FF6B35]/60 cursor-pointer' : 'cursor-default',
            )}
            title={isMentor && email ? `Ver dossiê de ${name}` : name}
          >
            <ParticipantTile trackRef={t} disableSpeakingIndicator className="!border-0 !rounded-2xl [&_video]:!object-cover !w-full !h-full" />
            <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 bg-gradient-to-t from-black/90 to-transparent flex items-center gap-2">
              <span className="text-white text-sm font-semibold truncate">{name}</span>
              {isHost && (
                <span className="text-[9px] font-bold uppercase tracking-wider text-[#FF6B35] bg-[#FF6B35]/15 border border-[#FF6B35]/30 px-1.5 py-0.5 rounded-md shrink-0">Host</span>
              )}
            </div>
            {speaking && (
              <div className="absolute top-3 left-3 flex items-center gap-1 px-2 py-1 rounded-md bg-[#FF6B35]/15 backdrop-blur-sm border border-[#FF6B35]/30">
                {[0, 1, 2].map((i) => (
                  <motion.div key={i} className="w-0.5 bg-[#FF6B35] rounded-full" animate={{ height: ['4px', '10px', '4px'] }} transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }} />
                ))}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── AudiencePipOverlay ───
// Coluna vertical FLUTUANTE de câmeras no canto superior direito da tela
// compartilhada. Igual ao Zoom / Google Meet — não rouba espaço do vídeo
// principal, fica sobreposta. Máx 5 thumbnails; excedente vira "+N".
function AudiencePipOverlay({
  participants, tracksByIdentity, isMentor, onPickStudent,
}: {
  participants: any[];
  tracksByIdentity: Map<string, any>;
  isMentor: boolean;
  onPickStudent?: (email: string) => void;
}) {
  const MAX_TILES = 5;
  // Prioriza quem está falando pra mostrar primeiro
  const sorted = [...participants].sort((a, b) => (b.isSpeaking ? 1 : 0) - (a.isSpeaking ? 1 : 0));
  const visible = sorted.slice(0, MAX_TILES);
  const overflow = participants.length - visible.length;

  return (
    <div className="absolute top-4 right-4 z-30 flex flex-col gap-2 max-h-[calc(100%-2rem)] overflow-hidden pointer-events-none">
      {visible.map((p) => {
        const meta = (() => { try { return JSON.parse(p.metadata || '{}'); } catch { return {}; } })();
        const email: string | undefined = meta.email;
        const name: string = p.name || meta.member_name || email || 'Participante';
        const trackRef = tracksByIdentity.get(p.identity);
        const speaking = p.isSpeaking;
        const hue = getHue(email || p.identity);

        return (
          <button
            key={p.identity}
            onClick={() => isMentor && email && onPickStudent?.(email)}
            className={cn(
              'group relative w-40 aspect-video rounded-xl overflow-hidden bg-zinc-900 border-2 shadow-2xl shadow-black/60 transition-all pointer-events-auto',
              speaking ? 'border-[#FF6B35] shadow-[0_0_0_2px_rgba(255,107,53,0.6)]' : 'border-black/40',
              isMentor && email ? 'hover:scale-105 hover:border-[#FF6B35]/70 cursor-pointer' : 'cursor-default',
            )}
            title={isMentor && email ? `Ver dossiê de ${name}` : name}
          >
            {trackRef ? (
              <ParticipantTile trackRef={trackRef} disableSpeakingIndicator className="!border-0 !rounded-xl !w-full !h-full" />
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
          </button>
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

// ─── AudienceStrip ───
function AudienceStrip({
  participants, tracksByIdentity, isMentor, onPickStudent,
}: {
  participants: any[];
  tracksByIdentity: Map<string, any>;
  isMentor: boolean;
  onPickStudent?: (email: string) => void;
}) {
  return (
    <div className="shrink-0 h-28 rounded-2xl bg-zinc-950/60 border border-zinc-800/60 backdrop-blur-sm p-2">
      <div className="h-full flex gap-2 overflow-x-auto overflow-y-hidden audience-scroll">
        {participants.map((p) => {
          const meta = (() => { try { return JSON.parse(p.metadata || '{}'); } catch { return {}; } })();
          const email: string | undefined = meta.email;
          const name: string = p.name || meta.member_name || email || 'Participante';
          const trackRef = tracksByIdentity.get(p.identity);
          const speaking = p.isSpeaking;
          const hue = getHue(email || p.identity);

          return (
            <button
              key={p.identity}
              onClick={() => isMentor && email && onPickStudent?.(email)}
              className={cn(
                'group relative shrink-0 w-32 h-full rounded-xl overflow-hidden bg-zinc-900 border transition-all',
                speaking ? 'border-[#FF6B35] shadow-[0_0_0_2px_rgba(255,107,53,0.4)]' : 'border-zinc-800/60',
                isMentor && email ? 'hover:border-[#FF6B35]/60 cursor-pointer' : 'cursor-default',
              )}
              title={isMentor && email ? `Ver dossiê de ${name}` : name}
            >
              {trackRef ? (
                <ParticipantTile trackRef={trackRef} disableSpeakingIndicator className="!border-0 !rounded-xl !w-full !h-full" />
              ) : (
                <div className="w-full h-full flex items-center justify-center" style={{ background: `linear-gradient(135deg, hsl(${hue} 60% 25%), hsl(${hue} 50% 15%))` }}>
                  <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-base" style={{ background: `hsl(${hue} 70% 45%)` }}>
                    {getInitials(name)}
                  </div>
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 px-1.5 py-1 bg-gradient-to-t from-black/85 to-transparent">
                <p className="text-white text-[11px] font-medium truncate text-left">{name}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── WaitingMentor ───
function WaitingMentor({ sessionTitle, studentName, onAskQuestion, questionSent }: { sessionTitle: string; studentName: string; onAskQuestion: () => void; questionSent: boolean }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="relative rounded-3xl overflow-hidden bg-mesh border border-zinc-800/60 flex items-center justify-center h-full">
      <motion.div className="absolute top-8 left-8 w-48 h-48 rounded-full bg-[#FF6B35]/10 blur-3xl" animate={{ x: [0, 30, 0], y: [0, -20, 0] }} transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }} />
      <motion.div className="absolute bottom-8 right-8 w-64 h-64 rounded-full bg-blue-500/10 blur-3xl" animate={{ x: [0, -40, 0], y: [0, 30, 0] }} transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }} />

      <div className="relative z-10 text-center max-w-md px-6">
        <div className="relative w-24 h-24 mx-auto mb-6">
          <motion.div className="absolute inset-0 rounded-full bg-[#FF6B35]/20" animate={{ scale: [1, 1.6, 1], opacity: [0.6, 0, 0.6] }} transition={{ duration: 2.5, repeat: Infinity }} />
          <motion.div className="absolute inset-0 rounded-full bg-[#FF6B35]/20" animate={{ scale: [1, 1.6, 1], opacity: [0.6, 0, 0.6] }} transition={{ duration: 2.5, repeat: Infinity, delay: 0.8 }} />
          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[#FF6B35] to-[#FF4500] flex items-center justify-center shadow-2xl">
            <Radio className="w-10 h-10 text-white" strokeWidth={2.5} />
          </div>
        </div>

        <motion.h2 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="font-display text-3xl font-bold text-white mb-2 tracking-tight">
          {studentName ? `Olá, ${studentName.split(' ')[0]}` : 'Olá'}
        </motion.h2>
        <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="text-zinc-400 text-base mb-1">
          O mentor está prestes a entrar
        </motion.p>
        <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="text-zinc-600 text-xs uppercase tracking-[0.2em] font-semibold mb-8">
          {sessionTitle}
        </motion.p>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="card-premium rounded-2xl p-5">
          {questionSent ? (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                <Check className="w-5 h-5 text-emerald-400" strokeWidth={2.5} />
              </div>
              <div className="text-left">
                <p className="text-white font-semibold text-sm">Pergunta na fila</p>
                <p className="text-zinc-500 text-xs">O mentor vai priorizar ao iniciar</p>
              </div>
            </div>
          ) : (
            <>
              <p className="text-zinc-300 text-sm font-medium mb-3 text-left">
                Quer adiantar sua dúvida?
                <span className="text-zinc-500 font-normal block mt-0.5">O mentor responde primeiro quem mandou antes.</span>
              </p>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={onAskQuestion}
                className="w-full rounded-xl bg-gradient-to-r from-[#FF6B35] to-[#FF8555] text-white font-semibold text-sm py-3 px-4 flex items-center justify-center gap-2 brand-glow"
              >
                <MessageSquare className="w-4 h-4" />
                Mandar pergunta agora
              </motion.button>
            </>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}

// ─── AudienceBadge + Floating Question CTA ───
function AudienceBadge({ studentName, email }: { studentName: string; email: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="absolute bottom-28 left-6 card-premium rounded-2xl p-3 pr-5 flex items-center gap-3 max-w-xs z-10">
      <div className="relative">
        <Avatar name={studentName} email={email} size="md" ring />
        <motion.div animate={{ scale: [1, 1.4, 1], opacity: [0.8, 0, 0.8] }} transition={{ duration: 2, repeat: Infinity }} className="absolute inset-0 rounded-full border-2 border-emerald-400 pointer-events-none" />
      </div>
      <div className="min-w-0">
        <p className="text-white text-xs font-semibold truncate">{studentName || 'Você'}</p>
        <p className="text-emerald-400 text-[10px] font-medium flex items-center gap-1">
          <span className="w-1 h-1 rounded-full bg-emerald-400 live-dot" />
          Na audiência
        </p>
      </div>
    </motion.div>
  );
}

function WelcomeCTA({ studentName, onAskQuestion }: { studentName: string; onAskQuestion: () => void }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 12000); // some após 12s
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  const firstName = studentName?.split(' ')[0] || 'Aluno';
  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ type: 'spring', damping: 22, delay: 0.5 }}
      className="absolute top-4 left-1/2 -translate-x-1/2 z-20 max-w-md w-[calc(100%-2rem)]"
    >
      <div className="card-premium rounded-2xl p-4 flex items-center gap-3 brand-glow">
        <div className="text-3xl shrink-0">👋</div>
        <div className="min-w-0 flex-1">
          <p className="font-display text-white font-bold text-sm">Olá {firstName}!</p>
          <p className="text-zinc-400 text-xs mt-0.5">Tem alguma dúvida pra tirar nessa call?</p>
        </div>
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={onAskQuestion}
          className="bg-gradient-to-r from-[#FF6B35] to-[#FF4500] text-white font-semibold text-xs px-4 py-2 rounded-xl flex items-center gap-1.5 shrink-0"
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Perguntar
        </motion.button>
        <button onClick={() => setVisible(false)} className="text-zinc-600 hover:text-white p-1 shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </motion.div>
  );
}

function FloatingQuestionCTA({ onClick, hasSent }: { onClick: () => void; hasSent: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', damping: 20, delay: 0.3 }}
      className="absolute bottom-28 right-6 z-10"
    >
      <motion.button
        whileHover={{ scale: 1.04, y: -2 }}
        whileTap={{ scale: 0.96 }}
        onClick={onClick}
        className={cn(
          'group flex items-center gap-2.5 px-4 py-3 rounded-2xl font-semibold text-sm shadow-2xl transition-all',
          hasSent
            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
            : 'bg-gradient-to-r from-[#FF6B35] to-[#FF4500] text-white brand-glow'
        )}
      >
        {hasSent ? (
          <>
            <Check className="w-4 h-4" strokeWidth={2.5} />
            <span>Pergunta na fila</span>
          </>
        ) : (
          <>
            <MessageSquare className="w-4 h-4" strokeWidth={2.5} />
            <span>Mandar pergunta</span>
            <motion.span
              className="w-1.5 h-1.5 rounded-full bg-white/80"
              animate={{ scale: [1, 1.4, 1] }}
              transition={{ duration: 1.8, repeat: Infinity }}
            />
          </>
        )}
      </motion.button>
    </motion.div>
  );
}

// ─── ControlsBar ───
// Selector de dispositivos: mic, câmera, saída de áudio
function DeviceSelector({ room }: { room: any }) {
  const [open, setOpen] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  const [active, setActive] = useState<{ mic?: string; cam?: string; out?: string }>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        // Permissão pra labels (alguns browsers exigem getUserMedia antes)
        try { await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); } catch {}
        const list = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setMics(list.filter((d) => d.kind === 'audioinput'));
        setCams(list.filter((d) => d.kind === 'videoinput'));
        setOuts(list.filter((d) => d.kind === 'audiooutput'));
      } catch (err) {
        console.error('[DeviceSelector] enumerateDevices falhou:', err);
      }
    };
    load();
    const onChange = () => load();
    navigator.mediaDevices.addEventListener?.('devicechange', onChange);
    return () => { cancelled = true; navigator.mediaDevices.removeEventListener?.('devicechange', onChange); };
  }, [open]);

  const switchDevice = async (kind: 'audioinput' | 'videoinput' | 'audiooutput', deviceId: string) => {
    if (!room) return;
    try {
      await room.switchActiveDevice(kind, deviceId);
      setActive((prev) => ({
        ...prev,
        ...(kind === 'audioinput' && { mic: deviceId }),
        ...(kind === 'videoinput' && { cam: deviceId }),
        ...(kind === 'audiooutput' && { out: deviceId }),
      }));
    } catch (err) {
      console.error('[DeviceSelector] switchActiveDevice falhou:', err);
    }
  };

  return (
    <div className="relative">
      <CtrlButton onClick={() => setOpen((v) => !v)} highlighted={open} icon={<Settings className="h-5 w-5" />} label="Áudio/Vídeo" />
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 w-80 rounded-2xl bg-zinc-950/95 backdrop-blur-2xl border border-zinc-800/60 shadow-2xl p-3 z-50"
          >
            <div className="space-y-3">
              <DeviceGroup label="Microfone" icon={<Mic className="w-3.5 h-3.5" />} devices={mics} activeId={active.mic} onSelect={(id) => switchDevice('audioinput', id)} />
              <DeviceGroup label="Câmera" icon={<VideoIcon className="w-3.5 h-3.5" />} devices={cams} activeId={active.cam} onSelect={(id) => switchDevice('videoinput', id)} />
              <DeviceGroup label="Saída de áudio" icon={<Volume2 className="w-3.5 h-3.5" />} devices={outs} activeId={active.out} onSelect={(id) => switchDevice('audiooutput', id)} />
            </div>
            <button onClick={() => setOpen(false)} className="absolute top-2 right-2 text-zinc-500 hover:text-white p-1 rounded-md hover:bg-zinc-800/60">
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DeviceGroup({ label, icon, devices, activeId, onSelect }: { label: string; icon: React.ReactNode; devices: MediaDeviceInfo[]; activeId?: string; onSelect: (id: string) => void }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-zinc-400 mb-1.5">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-[0.2em]">{label}</span>
      </div>
      {devices.length === 0 ? (
        <p className="text-[11px] text-zinc-600 italic px-2">Nenhum dispositivo encontrado</p>
      ) : (
        <div className="space-y-0.5">
          {devices.map((d) => {
            const isActive = activeId === d.deviceId || (!activeId && d.deviceId === 'default');
            return (
              <button
                key={d.deviceId}
                onClick={() => onSelect(d.deviceId)}
                className={cn(
                  'w-full text-left text-xs px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-2',
                  isActive ? 'bg-[#FF6B35]/15 text-white border border-[#FF6B35]/40' : 'text-zinc-300 hover:bg-zinc-800/60 border border-transparent'
                )}
              >
                {isActive && <Check className="w-3 h-3 text-[#FF6B35] shrink-0" strokeWidth={3} />}
                <span className="truncate flex-1">{d.label || `${label} ${d.deviceId.slice(0, 6)}`}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CtrlButton({ onClick, icon, label, active = true, highlighted = false, badge }: any) {
  return (
    <motion.button
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.94 }}
      onClick={onClick}
      className={cn(
        'relative group flex flex-col items-center gap-1 transition-all',
      )}
      title={label}
    >
      <div className={cn(
        'w-12 h-12 rounded-2xl flex items-center justify-center transition-all relative',
        highlighted && 'bg-gradient-to-br from-[#FF6B35] to-[#FF4500] text-white shadow-lg shadow-[#FF6B35]/30 brand-glow',
        !highlighted && active && 'bg-zinc-800/80 group-hover:bg-zinc-700 text-white border border-zinc-700/60',
        !highlighted && !active && 'bg-red-500/15 group-hover:bg-red-500/25 text-red-400 border border-red-500/30'
      )}>
        {icon}
        {badge !== undefined && badge > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#FF6B35] text-white text-[10px] font-bold flex items-center justify-center border-2 border-zinc-950">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </div>
      <span className="text-[9px] uppercase tracking-wider font-semibold text-zinc-400 group-hover:text-white transition-colors">
        {label}
      </span>
    </motion.button>
  );
}

function ControlsBar({ mode, participantDbId, onLeave, onAskQuestion, onToggleChat, unreadChat, chatOpen, onOpenPrompt, onHidePrompt, activePrompt }: any) {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const [micOn, setMicOn] = useState(mode.kind === 'mentor');
  const [camOn, setCamOn] = useState(mode.kind === 'mentor');
  const [shareOn, setShareOn] = useState(false);

  // Sincroniza shareOn com o estado real do LiveKit.
  // Evita botão "preso" quando user clica em "Parar de compartilhar" na barra do Chrome.
  useEffect(() => {
    if (!localParticipant) return;
    const sync = () => setShareOn(!!localParticipant.isScreenShareEnabled);
    sync();
    const onChange = () => sync();
    localParticipant.on(ParticipantEvent.TrackPublished, onChange);
    localParticipant.on(ParticipantEvent.TrackUnpublished, onChange);
    localParticipant.on(ParticipantEvent.LocalTrackPublished, onChange);
    localParticipant.on(ParticipantEvent.LocalTrackUnpublished, onChange);
    return () => {
      localParticipant.off(ParticipantEvent.TrackPublished, onChange);
      localParticipant.off(ParticipantEvent.TrackUnpublished, onChange);
      localParticipant.off(ParticipantEvent.LocalTrackPublished, onChange);
      localParticipant.off(ParticipantEvent.LocalTrackUnpublished, onChange);
    };
  }, [localParticipant]);

  const [handUp, setHandUp] = useState(false);
  const [handLoading, setHandLoading] = useState(false);
  const [confirmLowerHand, setConfirmLowerHand] = useState(false);

  // Sincroniza handUp com o estado real do banco ao montar (evita re-clicar quando já tava levantada)
  useEffect(() => {
    if (!participantDbId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('mentoring_participants').select('hand_raised_at').eq('id', participantDbId).maybeSingle();
      if (!cancelled && data) setHandUp(!!data.hand_raised_at);
    })();
    return () => { cancelled = true; };
  }, [participantDbId]);
  const [reactionBurst, setReactionBurst] = useState<{ id: number; e: string }[]>([]);
  const isStudent = mode.kind === 'student';
  const isMentor = mode.kind === 'mentor';

  // Share screen com aprovação do host (somente alunos)
  const [shareStatus, setShareStatus] = useState<'idle' | 'awaiting' | 'approved' | 'denied'>('idle');
  const [pendingShareRequest, setPendingShareRequest] = useState<{ identity: string; name: string } | null>(null);

  // Aluno escuta resposta do host
  useEffect(() => {
    if (!isStudent || !room) return;
    const handler = async (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === 'share_approved') {
          setShareStatus('approved');
          // Auto-abrir picker do navegador direto — evita o "2º clique"
          // que os alunos reclamavam. Se o browser exigir gesture do usuário
          // (Safari/Firefox mais restritos), cai no catch e o botão fica com
          // estado 'approved' esperando o clique manual (fallback).
          try {
            await localParticipant.setScreenShareEnabled(true, { audio: true, systemAudio: 'include' } as any);
            setShareOn(true);
            setShareStatus('idle');
          } catch (err) {
            console.warn('[share] auto-open picker falhou (browser exige gesture do user):', err);
            // Deixa em 'approved' — botão fica destacado pra aluno clicar 1x.
          }
        } else if (msg.type === 'share_denied') {
          setShareStatus('denied');
          setTimeout(() => setShareStatus('idle'), 3000);
        }
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [isStudent, room, localParticipant]);

  // Host escuta pedidos de share
  useEffect(() => {
    if (!isMentor || !room) return;
    const handler = (payload: Uint8Array, participant: any) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === 'share_request' && participant) {
          setPendingShareRequest({ identity: participant.identity, name: participant.name || 'Aluno' });
        }
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [isMentor, room]);

  const respondShareRequest = async (approve: boolean) => {
    if (!pendingShareRequest || !room) return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: approve ? 'share_approved' : 'share_denied' }));
    await room.localParticipant.publishData(payload, { reliable: true, destinationIdentities: [pendingShareRequest.identity] });
    setPendingShareRequest(null);
  };

  const toggleShareScreen = async () => {
    // Detecção de suporte: iOS Safari / WebView não tem getDisplayMedia
    const supports = typeof navigator !== 'undefined'
      && !!(navigator.mediaDevices as any)
      && typeof (navigator.mediaDevices as any).getDisplayMedia === 'function';
    if (!supports) {
      toast.error('Compartilhamento de tela não é suportado neste navegador. Use o Chrome ou Edge no desktop.');
      return;
    }

    try {
      // Opções: captura ÁUDIO da aba/tela junto com o vídeo. Chrome/Edge
      // mostram checkbox "Compartilhar áudio da guia" no picker quando isso
      // está setado; sem essa opção, o áudio da tela nunca é publicado.
      const captureOpts = { audio: true, systemAudio: 'include' } as any;

      // Host: compartilha direto
      if (isMentor) {
        if (shareOn) {
          await localParticipant.setScreenShareEnabled(false);
        } else {
          await localParticipant.setScreenShareEnabled(true, captureOpts);
        }
        setShareOn(!shareOn);
        return;
      }
      // Aluno parando compartilhamento
      if (shareOn) {
        await localParticipant.setScreenShareEnabled(false);
        setShareOn(false);
        setShareStatus('idle');
        return;
      }
      // Aluno: se já aprovado, abre picker direto (fallback do auto-open)
      if (shareStatus === 'approved') {
        await localParticipant.setScreenShareEnabled(true, captureOpts);
        setShareOn(true);
        setShareStatus('idle');
        return;
      }
      // Aluno: pede autorização
      if (room) {
        const payload = new TextEncoder().encode(JSON.stringify({ type: 'share_request' }));
        await room.localParticipant.publishData(payload, { reliable: true });
        setShareStatus('awaiting');
      }
    } catch (err: any) {
      console.error('[MentoringRoom] share screen falhou:', err);
      // Erro NotAllowedError = usuário cancelou no picker. Não mostrar toast.
      if (err?.name !== 'NotAllowedError') {
        toast.error(`Não foi possível compartilhar: ${err?.message || 'erro desconhecido'}`);
      }
      // Se aluno tentou compartilhar e deu erro, volta status pra idle pra ele poder pedir de novo
      if (!isMentor) setShareStatus('idle');
    }
  };

  const broadcastHand = async (raised: boolean) => {
    if (!room) return;
    const myName = (mode as any).memberName || (room.localParticipant as any)?.name || 'Aluno';
    const payload = new TextEncoder().encode(JSON.stringify({
      type: raised ? 'hand_raised' : 'hand_lowered',
      participant_id: participantDbId,
      name: myName,
      identity: room.localParticipant?.identity,
      ts: Date.now(),
    }));
    try { await room.localParticipant.publishData(payload, { reliable: true }); } catch {}
  };

  const toggleHand = async () => {
    if (handLoading) return; // bloqueia clicks múltiplos durante a request
    if (handUp) {
      // Confirma antes de baixar
      setConfirmLowerHand(true);
      return;
    }
    setHandUp(true);
    setHandLoading(true);
    try {
      await supabase.functions.invoke('mentoring-actions', { body: { action: 'raise_hand', participant_id: participantDbId } });
      // Broadcast pro host + outros alunos receberem em tempo real
      broadcastHand(true);
    } finally {
      setHandLoading(false);
    }
  };

  const doLowerHand = async () => {
    if (handLoading) return;
    setHandUp(false);
    setConfirmLowerHand(false);
    setHandLoading(true);
    try {
      await supabase.functions.invoke('mentoring-actions', { body: { action: 'lower_hand', participant_id: participantDbId } });
      broadcastHand(false);
    } finally {
      setHandLoading(false);
    }
  };

  const sendReaction = async (emoji: string) => {
    const data = new TextEncoder().encode(JSON.stringify({ type: 'reaction', emoji }));
    await room?.localParticipant?.publishData(data, { reliable: false });
    const id = Date.now() + Math.random();
    setReactionBurst((prev) => [...prev, { id, e: emoji }]);
    setTimeout(() => setReactionBurst((prev) => prev.filter((r) => r.id !== id)), 2500);
  };

  return (
    <div className="relative min-h-[88px] border-t border-zinc-800/60 bg-zinc-950/80 backdrop-blur-xl flex items-center justify-center gap-3 px-6 py-2 shrink-0">
      <div className="absolute inset-x-0 bottom-full h-32 overflow-hidden pointer-events-none">
        <AnimatePresence>
          {reactionBurst.map((r) => (
            <motion.div key={r.id} initial={{ opacity: 0, y: 0, scale: 0.5, x: Math.random() * 300 - 150 }} animate={{ opacity: [0, 1, 1, 0], y: -120, scale: [0.5, 1.3, 1] }} exit={{ opacity: 0 }} transition={{ duration: 2.2 }} className="absolute bottom-0 left-1/2 text-4xl">
              {r.e}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <CtrlButton onClick={async () => { await localParticipant.setMicrophoneEnabled(!micOn); setMicOn(!micOn); }} active={micOn} icon={micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />} label={micOn ? 'Microfone' : 'Mic off'} />
      <CtrlButton onClick={async () => { await localParticipant.setCameraEnabled(!camOn); setCamOn(!camOn); }} active={camOn} icon={camOn ? <VideoIcon className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />} label={camOn ? 'Câmera' : 'Cam off'} />

      <DeviceSelector room={room} />

      <CtrlButton
        onClick={toggleShareScreen}
        highlighted={shareOn || shareStatus === 'approved'}
        icon={
          shareOn ? <MonitorOff className="h-5 w-5" /> :
          shareStatus === 'awaiting' ? <Loader2 className="h-5 w-5 animate-spin" /> :
          shareStatus === 'approved' ? <MonitorUp className="h-5 w-5" /> :
          shareStatus === 'denied' ? <X className="h-5 w-5" /> :
          <MonitorUp className="h-5 w-5" />
        }
        label={
          shareOn ? 'Parar' :
          shareStatus === 'awaiting' ? 'Aguardando' :
          shareStatus === 'approved' ? 'Compartilhar' :
          shareStatus === 'denied' ? 'Negado' :
          'Tela'
        }
      />


      {isMentor && (
        <CtrlButton
          onClick={activePrompt ? onHidePrompt : onOpenPrompt}
          highlighted={!!activePrompt}
          icon={<HelpCircle className="h-5 w-5" />}
          label={activePrompt ? 'Esconder' : 'Perguntar'}
        />
      )}

      <div className="w-px h-10 bg-zinc-800 mx-1" />

      <CtrlButton
        onClick={onToggleChat}
        highlighted={chatOpen}
        icon={<MessagesSquare className="h-5 w-5" />}
        label="Chat"
        badge={unreadChat}
      />

      {isStudent && (
        <>
          <CtrlButton
            onClick={toggleHand}
            highlighted={handUp}
            icon={<Hand className="h-5 w-5" />}
            label={handUp ? 'Mão ↑' : 'Levantar'}
          />
          <CtrlButton onClick={onAskQuestion} icon={<HelpCircle className="h-5 w-5" />} label="Pergunta" />

          <div className="w-px h-10 bg-zinc-800 mx-1" />
          <div className="flex gap-1.5 items-center">
            {['🔥', '👏', '❤️', '😂'].map((e) => (
              <motion.button key={e} whileHover={{ scale: 1.2, rotate: [0, -10, 10, 0] }} whileTap={{ scale: 0.85 }} onClick={() => sendReaction(e)} className="w-10 h-10 rounded-xl bg-zinc-800/60 hover:bg-zinc-700 text-lg flex items-center justify-center transition-colors">
                {e}
              </motion.button>
            ))}
          </div>
        </>
      )}

      <div className="flex-1" />

      <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.96 }} onClick={onLeave} className="h-14 px-6 rounded-2xl bg-red-500 hover:bg-red-600 text-white flex items-center gap-2 font-semibold shadow-lg shadow-red-500/20">
        <PhoneOff className="h-5 w-5" />
        <span className="text-sm hidden sm:inline">Sair</span>
      </motion.button>

      {/* Modal confirmar baixar mão (via portal pra escapar de transform) */}
      {confirmLowerHand && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
          <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="card-premium rounded-3xl max-w-sm w-full p-6 text-center">
            <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
              <Hand className="w-7 h-7 text-amber-400" />
            </div>
            <h3 className="font-display text-xl font-bold text-white mb-1">Baixar a mão?</h3>
            <p className="text-zinc-400 text-sm mb-5">Você vai sair do destaque na sala.</p>
            <div className="flex flex-col gap-2">
              <Button onClick={doLowerHand} className="w-full h-11 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-semibold">Sim, baixar</Button>
              <Button onClick={() => setConfirmLowerHand(false)} variant="outline" className="w-full h-11 bg-transparent border-zinc-800 text-zinc-300 hover:bg-zinc-800/60 rounded-xl">Cancelar</Button>
            </div>
          </motion.div>
        </div>,
        document.body
      )}

      {/* Host: notificação de pedido pra compartilhar tela */}
      {pendingShareRequest && createPortal(
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[60] max-w-md w-[92vw]"
        >
          <div className="card-premium rounded-2xl p-4 shadow-2xl border-2 border-[#FF6B35]/40 bg-zinc-950/95 backdrop-blur-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#FF6B35] to-amber-500 flex items-center justify-center shrink-0 shadow-lg">
                <MonitorUp className="w-5 h-5 text-white" strokeWidth={2.5} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-white font-semibold text-sm">{pendingShareRequest.name} quer compartilhar a tela</p>
                <p className="text-zinc-400 text-xs mt-0.5">Aprove pra liberar o compartilhamento</p>
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <Button onClick={() => respondShareRequest(false)} variant="outline" className="flex-1 h-9 text-xs bg-transparent border-zinc-700 text-zinc-300 hover:bg-zinc-800 rounded-xl">Negar</Button>
              <Button onClick={() => respondShareRequest(true)} className="flex-1 h-9 text-xs bg-gradient-to-r from-[#FF6B35] to-[#FF4500] hover:opacity-90 text-white rounded-xl font-semibold">Aprovar</Button>
            </div>
          </div>
        </motion.div>,
        document.body
      )}

      {/* Aluno: feedback de status do share */}
      {(shareStatus === 'awaiting' || shareStatus === 'approved' || shareStatus === 'denied') && createPortal(
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[60]"
        >
          <div className={cn(
            'rounded-2xl px-4 py-3 shadow-2xl border-2 backdrop-blur-2xl flex items-center gap-2',
            shareStatus === 'awaiting' && 'bg-zinc-950/95 border-amber-500/40',
            shareStatus === 'approved' && 'bg-zinc-950/95 border-emerald-500/50',
            shareStatus === 'denied' && 'bg-zinc-950/95 border-red-500/40',
          )}>
            {shareStatus === 'awaiting' && <><Loader2 className="w-4 h-4 text-amber-400 animate-spin" /><span className="text-amber-100 text-sm">Aguardando aprovação do mentor…</span></>}
            {shareStatus === 'approved' && <><Check className="w-4 h-4 text-emerald-400" /><span className="text-emerald-100 text-sm">Aprovado! Clique em <b>Compartilhar</b> pra escolher a tela</span></>}
            {shareStatus === 'denied' && <><X className="w-4 h-4 text-red-400" /><span className="text-red-100 text-sm">Mentor negou o pedido</span></>}
          </div>
        </motion.div>,
        document.body
      )}
    </div>
  );
}

// ─── QuestionModal ───
function QuestionModal({ mode, participantDbId, onClose, onSent }: { mode: StudentMode; participantDbId: string | null; onClose: () => void; onSent?: () => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const room = useRoomContext();

  const submit = async () => {
    if (!text.trim() || sending) return; // bloqueia double-click
    setSending(true);
    try {
      await supabase.functions.invoke('mentoring-actions', {
        body: { action: 'submit_question', session_id: mode.sessionId, participant_id: participantDbId, lead_id: mode.leadId, email: mode.email, name: mode.memberName, question: text.trim() },
      });
      // Broadcast em tempo real pra host + outros alunos verem que pergunta foi enviada
      if (room) {
        const payload = new TextEncoder().encode(JSON.stringify({
          type: 'question_submitted',
          name: mode.memberName,
          email: mode.email,
          question: text.trim(),
          ts: Date.now(),
        }));
        try { await room.localParticipant.publishData(payload, { reliable: true }); } catch {}
      }
    } finally {
      setSending(false);
    }
    onSent?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4" onClick={onClose}>
      <motion.div initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }} className="card-premium rounded-3xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#FF6B35] to-[#FF4500] flex items-center justify-center shrink-0">
            <MessageSquare className="w-5 h-5 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <h3 className="font-display text-white font-bold text-xl tracking-tight">Mandar pergunta</h3>
            <p className="text-zinc-400 text-xs mt-0.5">O mentor vai ler e responder em voz alta</p>
          </div>
        </div>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Qual sua dúvida?" className="bg-zinc-900/60 border-zinc-800 text-white placeholder:text-zinc-600 resize-none min-h-[110px] focus-visible:ring-[#FF6B35]/30 focus-visible:border-[#FF6B35]/50" autoFocus />
        <div className="flex gap-2 mt-5">
          <Button variant="outline" onClick={onClose} className="flex-1 bg-transparent border-zinc-800 text-zinc-300 hover:bg-zinc-800/60 rounded-xl">Cancelar</Button>
          <Button onClick={submit} disabled={!text.trim() || sending} className="flex-1 bg-gradient-to-r from-[#FF6B35] to-[#FF4500] hover:opacity-90 rounded-xl brand-glow">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Send className="h-4 w-4 mr-2" /> Enviar</>}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── PublicLinkButton (só host) ───
function PublicLinkButton({ sessionId }: { sessionId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data } = await supabase
        .from('mentoring_sessions')
        .select('share_token')
        .eq('id', sessionId)
        .maybeSingle();
      if (!cancel) {
        setToken(data?.share_token || null);
        setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [sessionId]);

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      // nanoid 12 chars seguro
      const arr = new Uint8Array(9);
      crypto.getRandomValues(arr);
      const newToken = btoa(String.fromCharCode(...arr)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + Date.now().toString(36).slice(-3);
      const { data, error } = await supabase
        .from('mentoring_sessions')
        .update({ share_token: newToken })
        .eq('id', sessionId)
        .select('share_token')
        .single();
      if (error) throw error;
      setToken(data.share_token);
    } catch (err: any) {
      toast.error(`Falha ao gerar link: ${err?.message || 'erro'}`);
    } finally {
      setGenerating(false);
    }
  };

  const revoke = async () => {
    if (!confirm('Revogar o link público? Quem ainda não entrou não conseguirá mais acessar.')) return;
    setGenerating(true);
    try {
      await supabase.from('mentoring_sessions').update({ share_token: null }).eq('id', sessionId);
      setToken(null);
    } finally {
      setGenerating(false);
    }
  };

  const copyLink = async () => {
    if (!token) return;
    const url = `${window.location.origin}/m/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success('Link copiado!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Não foi possível copiar');
    }
  };

  if (loading) return null;

  if (!token) {
    return (
      <button
        onClick={generate}
        disabled={generating}
        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-gradient-to-r from-[#FF6B35]/15 to-[#FF4500]/10 hover:from-[#FF6B35]/25 hover:to-[#FF4500]/20 border border-[#FF6B35]/30 rounded-xl text-[#FF6B35] text-xs font-bold transition disabled:opacity-50"
        title="Cria um link único pra divulgar em grupos de WhatsApp/Telegram"
      >
        {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Radio className="w-3.5 h-3.5" /> Gerar link público</>}
      </button>
    );
  }

  const url = `${window.location.origin}/m/${token}`;
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[9px] uppercase tracking-wider font-bold text-emerald-400 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Link público ativo
        </span>
        <button
          onClick={revoke}
          disabled={generating}
          className="text-[9px] uppercase tracking-wider font-semibold text-zinc-500 hover:text-red-400 transition"
        >
          Revogar
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          readOnly
          value={url}
          onClick={(e) => (e.target as HTMLInputElement).select()}
          className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-[10px] text-zinc-300 font-mono"
        />
        <button
          onClick={copyLink}
          className={cn(
            'shrink-0 px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition',
            copied ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-[#FF6B35] text-white hover:bg-[#FF4500]',
          )}
        >
          {copied ? 'Copiado!' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

// ─── MentorPanel ───
function MentorPanel({ sessionId, onSelectMember, onClose, onShowQuestion }: { sessionId: string; onSelectMember: (m: any) => void; onClose: () => void; onShowQuestion?: (q: { text: string; author: string }) => void }) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [participants, setParticipants] = useState<EnrichedParticipant[]>([]);
  const [handHistory, setHandHistory] = useState<any[]>([]);
  const [handoffsByEmail, setHandoffsByEmail] = useState<Map<string, { note: string; orgName: string | null; leadName: string | null }>>(new Map());
  const [tab, setTab] = useState<'queue' | 'participants'>('queue');
  const room = useRoomContext();

  // Busca handoffs do CS pra essa sessão (tarefa task_type=mentoring_handoff vinculada)
  useEffect(() => {
    let cancelled = false;
    let lastHash = '';
    const fetchHandoffs = async () => {
      const { data } = await supabase
        .from('company_activities')
        .select('id, description, organization_id, lead_id, organization:organizations(id, name, primary_contact_id), lead:leads(id, name, email)')
        .eq('mentoring_session_id', sessionId)
        .eq('task_type', 'mentoring_handoff');

      if (cancelled || !data) return;

      const m = new Map<string, { note: string; orgName: string | null; leadName: string | null }>();

      // Pra cada handoff: resolve emails do lead direto + TODOS os organization_members ativos da org
      const orgIds = Array.from(new Set(data.map((d: any) => d.organization_id).filter(Boolean))) as string[];
      const orgMembersByOrg = new Map<string, { name: string | null; email: string }[]>();
      if (orgIds.length > 0) {
        const { data: members } = await supabase
          .from('organization_members')
          .select('organization_id, contact:leads!organization_members_contact_id_fkey(id, name, email)')
          .in('organization_id', orgIds)
          .eq('status', 'active');
        members?.forEach((row: any) => {
          if (!row.contact?.email) return;
          const list = orgMembersByOrg.get(row.organization_id) || [];
          list.push({ name: row.contact.name, email: row.contact.email.toLowerCase() });
          orgMembersByOrg.set(row.organization_id, list);
        });
      }

      data.forEach((row: any) => {
        const note = row.description || '';
        const orgName = row.organization?.name || null;
        const leadName = row.lead?.name || null;
        const value = { note, orgName, leadName };

        // 1) email do lead direto (se tem)
        if (row.lead?.email) {
          m.set(row.lead.email.toLowerCase(), value);
        }
        // 2) TODOS os emails dos membros da org
        if (row.organization_id) {
          const members = orgMembersByOrg.get(row.organization_id) || [];
          members.forEach((mem) => {
            const existing = m.get(mem.email);
            // se já existe entrada (ex: lead direto), não sobrescreve. Senão, usa nome do membro.
            if (!existing) {
              m.set(mem.email, { ...value, leadName: leadName || mem.name });
            }
          });
        }
      });

      // Hash estável — só atualiza se mudou (evita re-render que dispara reorder visual)
      const hash = JSON.stringify(Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])));
      if (hash !== lastHash) {
        lastHash = hash;
        setHandoffsByEmail(m);
      }
    };
    fetchHandoffs();
    const i = setInterval(fetchHandoffs, 15000);
    return () => { cancelled = true; clearInterval(i); };
  }, [sessionId]);

  useEffect(() => {
    // Cache hashes pra evitar setState quando dados não mudaram (reduz re-render)
    let lastQuestionsHash = '';
    let lastParticipantsHash = '';
    let lastHandHistoryHash = '';
    const fetchAll = async () => {
      const { data } = await supabase.functions.invoke('mentoring-actions', { body: { action: 'get_session_data', session_id: sessionId } });
      const q = data?.questions || [];
      const p = data?.participants || [];
      const h = data?.hand_history || [];
      const qHash = JSON.stringify(q.map((x: any) => `${x.id}:${x.status}`));
      const pHash = JSON.stringify(p.map((x: any) => `${x.id}:${x.hand_raised_at}:${x.left_at}`));
      const hHash = JSON.stringify(h.map((x: any) => `${x.id}:${x.resolution}`));
      if (qHash !== lastQuestionsHash) { setQuestions(q); lastQuestionsHash = qHash; }
      if (pHash !== lastParticipantsHash) { setParticipants(p); lastParticipantsHash = pHash; }
      if (hHash !== lastHandHistoryHash) { setHandHistory(h); lastHandHistoryHash = hHash; }
    };
    fetchAll();
    const i = setInterval(fetchAll, 5000);
    return () => clearInterval(i);
  }, [sessionId]);

  const handRaised = participants.filter((p) => p.hand_raised_at);
  const pendingQuestions = questions.filter((q) => q.status === 'pending');
  const answeredQuestions = questions.filter((q) => q.status === 'answered' || q.status === 'skipped');
  const totalInQueue = handRaised.length + pendingQuestions.length;

  const sendStageEvent = async (email: string, type: 'take_stage' | 'leave_stage') => {
    if (!room) return;
    const identities = Array.from(room.remoteParticipants.values()).filter((p) => {
      try { const m = JSON.parse(p.metadata || '{}'); return m.email === email; } catch { return false; }
    }).map((p) => p.identity);
    if (identities.length === 0) return;
    const data = new TextEncoder().encode(JSON.stringify({ type }));
    await room.localParticipant.publishData(data, { reliable: true, destinationIdentities: identities });
  };

  // Detecta se algum aluno tá no palco (publicando câmera)
  const studentOnStage = room ? Array.from(room.remoteParticipants.values()).find((p) => {
    try {
      const m = JSON.parse(p.metadata || '{}');
      if (!m.email) return false;
      const cam = Array.from(p.trackPublications.values()).find((t: any) => t.source === 'camera');
      return cam && !cam.isMuted;
    } catch { return false; }
  }) : null;
  const onStageEmail = studentOnStage ? (() => { try { return JSON.parse(studentOnStage.metadata || '{}').email; } catch { return null; } })() : null;

  // Mostra pergunta pros alunos SEM marcar como respondida (continua na fila)
  const showOnly = (q: Question) => {
    const author = q.member_name || q.member_email;
    if (room) {
      const payload = new TextEncoder().encode(JSON.stringify({ type: 'question_show', text: q.question, author }));
      room.localParticipant.publishData(payload, { reliable: true }).catch(() => {});
    }
    onShowQuestion?.({ text: q.question, author });
  };

  const markAnswered = (q: Question) => {
    const author = q.member_name || q.member_email;
    // 1. Broadcast INSTANTÂNEO (fire-and-forget) — zero delay na UI
    if (room) {
      const payload = new TextEncoder().encode(JSON.stringify({
        type: 'question_show',
        text: q.question,
        author,
      }));
      room.localParticipant.publishData(payload, { reliable: true }).catch(() => {});
    }
    // Renderiza tb pro host (publishData não emite pra si mesmo)
    onShowQuestion?.({ text: q.question, author });
    // 2. Optimistic update local — remove da fila imediato
    setQuestions((prev) => prev.map((item) => item.id === q.id ? { ...item, status: 'answered' } : item));
    // 3. Persiste no banco em background
    supabase.functions.invoke('mentoring-actions', { body: { action: 'answer_question', question_id: q.id } }).catch((err) => console.error('[markAnswered] banco falhou:', err));
  };
  const skip = async (qid: string) => {
    setQuestions((prev) => prev.map((it) => it.id === qid ? { ...it, status: 'skipped' } : it));
    await supabase.functions.invoke('mentoring-actions', { body: { action: 'skip_question', question_id: qid } });
  };
  const bringBack = async (qid: string) => {
    setQuestions((prev) => prev.map((it) => it.id === qid ? { ...it, status: 'pending' } : it));
    await supabase.functions.invoke('mentoring-actions', { body: { action: 'unanswer_question', question_id: qid } });
  };
  const lowerHand = async (pid: string, resolution: 'answered' | 'skipped' = 'skipped') => { await supabase.functions.invoke('mentoring-actions', { body: { action: 'lower_hand', participant_id: pid, resolution } }); };

  // Helper: encontra remoteParticipant pelo email no metadata
  const findRemoteByEmail = (email: string | null) => {
    if (!room || !email) return null;
    return Array.from(room.remoteParticipants.values()).find((rp: any) => {
      try { return JSON.parse(rp.metadata || '{}').email === email; } catch { return false; }
    }) as any;
  };

  // Mute mic do aluno (admin via LiveKit Server API)
  const muteAlunoMic = async (email: string | null) => {
    const remote = findRemoteByEmail(email);
    if (!remote || !room) return;
    try {
      await supabase.functions.invoke('livekit-mute-participant', {
        body: { room_name: room.name, identity: remote.identity, source: 'microphone', muted: true },
      });
    } catch (err) { console.error('[muteAlunoMic] falhou:', err); }
  };
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="h-full flex flex-col bg-zinc-950/80 backdrop-blur-xl">
      <div className="px-5 py-4 border-b border-zinc-800/60 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#FF6B35] to-[#FF4500] flex items-center justify-center shadow-lg shadow-[#FF6B35]/30">
            <Users className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <h2 className="text-white font-bold text-sm leading-none">Control Room</h2>
            <p className="text-zinc-500 text-[10px] mt-0.5 uppercase tracking-widest font-semibold">Mentor Panel</p>
          </div>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-white p-1.5 rounded-lg hover:bg-zinc-800/60 transition-colors">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="px-3 pt-3 shrink-0">
        <PublicLinkButton sessionId={sessionId} />
      </div>

      <div className="p-3 shrink-0">
        <div className="relative grid grid-cols-2 bg-zinc-900/60 rounded-xl p-1 border border-zinc-800/60">
          <motion.div layoutId="tab-indicator" className="absolute inset-y-1 w-[calc(50%-4px)] bg-zinc-800 rounded-lg border border-zinc-700/60 shadow-sm" animate={{ x: tab === 'queue' ? 4 : 'calc(100% + 4px)' }} transition={{ type: 'spring', damping: 25, stiffness: 300 }} />
          <button onClick={() => setTab('queue')} className={cn('relative z-10 py-2 text-xs font-semibold transition-colors', tab === 'queue' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300')}>
            Fila {totalInQueue > 0 && <span className="ml-1.5 inline-flex min-w-[18px] h-[18px] items-center justify-center text-[9px] font-bold px-1 rounded-full bg-[#FF6B35] text-white">{totalInQueue}</span>}
          </button>
          <button onClick={() => setTab('participants')} className={cn('relative z-10 py-2 text-xs font-semibold transition-colors', tab === 'participants' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300')}>
            Alunos <span className="text-zinc-600 ml-1">{participants.length}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-2">
        {tab === 'queue' && (
          <AnimatePresence mode="popLayout">
            {handRaised.map((p, idx) => (
              <motion.div key={`hand-${p.id}`} layout initial={{ opacity: 0, y: -8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: -20, scale: 0.95 }} transition={{ delay: idx * 0.04 }} className="card-premium rounded-2xl p-3.5">
                <div className="flex items-start gap-3">
                  <div className="relative">
                    <Avatar name={p.member_name || undefined} email={p.member_email} size="md" photoUrl={p.lead_avatar} />
                    <motion.div animate={{ rotate: [0, 15, -10, 15, 0] }} transition={{ duration: 1.2, repeat: Infinity, repeatDelay: 1 }} className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-[#FF6B35] border-2 border-zinc-950 flex items-center justify-center shadow-lg">
                      <Hand className="w-2.5 h-2.5 text-white" strokeWidth={3} />
                    </motion.div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => onSelectMember({ email: p.member_email, name: p.member_name, leadId: p.lead_id })} className="font-semibold text-white text-sm truncate hover:text-[#FF6B35] transition-colors">
                        {p.member_name || p.member_email}
                      </button>
                      <HealthDot score={p.health_score} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-zinc-500 font-mono">
                      <span className="flex items-center gap-0.5"><Clock className="w-3 h-3" /> {timeAgo(p.hand_raised_at!)}</span>
                      {p.days_as_client !== null && <span>• cliente há {p.days_as_client}d</span>}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1.5 mt-3">
                  <Button size="sm" onClick={() => { sendStageEvent(p.member_email, 'take_stage'); lowerHand(p.id, 'answered'); }} className="flex-1 h-8 text-xs font-semibold bg-gradient-to-r from-[#FF6B35] to-[#FF4500] hover:opacity-90 brand-glow">
                    <Radio className="w-3 h-3 mr-1.5" /> Dar palavra
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { sendStageEvent(p.member_email, 'leave_stage'); lowerHand(p.id, 'skipped'); }} className="h-8 text-xs bg-transparent border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white">
                    <Hand className="w-3 h-3 mr-1.5" /> Baixar mão
                  </Button>
                </div>
              </motion.div>
            ))}

            {pendingQuestions.map((q, idx) => (
              <motion.div key={`q-${q.id}`} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ delay: (handRaised.length + idx) * 0.04 }} className="card-premium rounded-2xl p-3.5">
                <div className="flex items-start gap-3">
                  <Avatar name={q.member_name || undefined} email={q.member_email} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button onClick={() => onSelectMember({ email: q.member_email, name: q.member_name, leadId: q.lead_id })} className="font-semibold text-white text-xs truncate hover:text-[#FF6B35]">
                        {q.member_name || q.member_email}
                      </button>
                      {q.source === 'pre_call' && (
                        <span className="text-[9px] font-bold uppercase tracking-wider text-amber-400 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded-md">antecipada</span>
                      )}
                    </div>
                    <p className="text-zinc-200 text-sm mt-1.5 leading-snug line-clamp-3">{q.question}</p>
                  </div>
                </div>
                <div className="flex gap-1.5 mt-3">
                  <Button size="sm" onClick={() => showOnly(q)} className="flex-1 h-8 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white" title="Exibe a pergunta no telão sem marcar como respondida">
                    <Radio className="w-3 h-3 mr-1.5" /> Mostrar
                  </Button>
                  <Button size="sm" onClick={() => markAnswered(q)} className="flex-1 h-8 text-xs font-semibold bg-gradient-to-r from-[#FF6B35] to-[#FF4500] hover:opacity-90 brand-glow" title="Mostra e marca como respondida (sai da fila)">
                    <Check className="w-3 h-3 mr-1.5" /> Responder
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => skip(q.id)} className="h-8 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800/60" title="Descartar sem mostrar pros alunos">Pular</Button>
                </div>
              </motion.div>
            ))}

            {totalInQueue === 0 && answeredQuestions.length === 0 && (
              <div key="empty-queue" className="text-center py-16 px-6">
                <div className="relative w-16 h-16 mx-auto mb-4">
                  <div className="absolute inset-0 rounded-full bg-zinc-800/40 animate-pulse" />
                  <div className="absolute inset-3 rounded-full bg-zinc-800/80 flex items-center justify-center"><MessageSquare className="w-6 h-6 text-zinc-600" /></div>
                </div>
                <p className="text-zinc-400 font-semibold text-sm">Fila vazia</p>
                <p className="text-zinc-600 text-xs mt-1">Alunos ainda não mandaram perguntas</p>
              </div>
            )}

            {/* Histórico unificado — colapsável */}
            {(handHistory.filter((h) => h.resolved_at).length > 0 || answeredQuestions.length > 0) && (
              <div key="history-block" className="pt-3 mt-3 border-t border-zinc-800/40">
                <button
                  onClick={() => setHistoryOpen(!historyOpen)}
                  className="w-full flex items-center justify-between px-1 py-1 text-zinc-400 hover:text-white transition-colors"
                >
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em]">
                    Histórico da sessão ({handHistory.filter((h) => h.resolved_at).length + answeredQuestions.length})
                  </span>
                  <ChevronRight className={cn('h-3 w-3 transition-transform', historyOpen && 'rotate-90')} />
                </button>
                {historyOpen && (
                  <div className="mt-2 space-y-1.5">
                    {handHistory.filter((h) => h.resolved_at).map((h) => (
                      <div key={`h-${h.id}`} className="rounded-xl p-2.5 border border-zinc-900 bg-zinc-950/40 flex items-center gap-2">
                        <Hand className="w-3 h-3 text-zinc-600 shrink-0" />
                        <Avatar name={h.member_name || undefined} email={h.member_email} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="text-zinc-300 text-xs font-semibold truncate">{h.member_name || h.member_email}</p>
                          <p className="text-[10px] font-mono text-zinc-500">
                            {new Date(h.raised_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                            {h.resolution === 'answered' && <span className="text-emerald-400 ml-1">· chamado ao palco</span>}
                            {h.resolution === 'skipped' && <span className="text-amber-400 ml-1">· dispensado</span>}
                            {h.resolution === 'self_lowered' && <span className="text-zinc-500 ml-1">· aluno baixou</span>}
                          </p>
                        </div>
                      </div>
                    ))}
                    {answeredQuestions.map((q) => (
                      <div key={`done-${q.id}`} className="group rounded-xl p-2.5 border border-zinc-900 bg-zinc-950/40 opacity-70 hover:opacity-100 transition-opacity">
                        <div className="flex items-start gap-2">
                          <div className={cn('w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5',
                            q.status === 'answered' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-700/40 text-zinc-500')}>
                            {q.status === 'answered' ? <Check className="w-2.5 h-2.5" strokeWidth={3} /> : <X className="w-2.5 h-2.5" strokeWidth={3} />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-zinc-300 text-xs truncate">
                              {q.member_name || q.member_email}
                              <span className="text-zinc-600 ml-1">· {q.status === 'answered' ? 'respondida' : 'pulada'}</span>
                            </p>
                            <p className="text-zinc-500 text-xs leading-snug line-clamp-2 mt-0.5">{q.question}</p>
                          </div>
                          <button
                            onClick={() => bringBack(q.id)}
                            className="shrink-0 px-2 py-1 rounded-md text-[10px] font-semibold text-zinc-400 hover:text-white bg-zinc-800/40 hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition-all"
                            title="Trazer pergunta de volta pra fila"
                          >
                            ↩ Voltar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </AnimatePresence>
        )}

        {tab === 'participants' && (
          <AnimatePresence mode="popLayout">
            {/* Handoffs pendentes: cliente que o CS pediu pra apresentar mas ainda não entrou */}
            {(() => {
              const presentEmails = new Set(participants.map((p) => (p.member_email || '').toLowerCase()));
              const pending = Array.from(handoffsByEmail.entries()).filter(([email]) => !presentEmails.has(email));
              if (pending.length === 0) return null;
              return (
                <div key="handoffs-pending" className="mb-3">
                  <div className="px-1 mb-2 flex items-center gap-1.5">
                    <Star className="w-3 h-3 text-amber-400" />
                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400">CS pediu pra apresentar</span>
                  </div>
                  <div className="space-y-2">
                    {pending.map(([email, h]) => (
                      <motion.div
                        key={`pending-${email}`}
                        layout
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="rounded-xl p-3 bg-gradient-to-br from-amber-500/10 to-zinc-900/40 border-2 border-amber-500/25 border-dashed"
                      >
                        <div className="flex items-center gap-3">
                          <div className="relative">
                            <Avatar name={h.leadName || undefined} email={email} size="md" />
                            <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-zinc-800 border-2 border-zinc-950 flex items-center justify-center shadow-lg">
                              <Clock className="w-2.5 h-2.5 text-amber-400" strokeWidth={2.5} />
                            </div>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <p className="text-amber-100 text-sm font-semibold truncate">{h.leadName || h.orgName || email}</p>
                              <span className="text-[9px] font-bold uppercase tracking-wider text-amber-400 bg-amber-400/15 border border-amber-400/30 px-1.5 py-0.5 rounded-md whitespace-nowrap">aguardando</span>
                            </div>
                            {h.note && <p className="text-[11px] text-amber-200/70 leading-snug mt-1 line-clamp-2 italic">"{h.note}"</p>}
                            <p className="text-[10px] text-zinc-500 mt-0.5">{email}</p>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                  {participants.length > 0 && <div className="border-t border-zinc-800/40 mt-3 pt-1" />}
                </div>
              );
            })()}
            {[...participants]
              .sort((a, b) => {
                const aH = handoffsByEmail.has((a.member_email || '').toLowerCase()) ? 1 : 0;
                const bH = handoffsByEmail.has((b.member_email || '').toLowerCase()) ? 1 : 0;
                return bH - aH;
              })
              .map((p, idx) => {
              const handoff = handoffsByEmail.get((p.member_email || '').toLowerCase());
              const isHighlighted = !!handoff;
              return (
                <motion.button
                  key={p.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  onClick={() => onSelectMember({ email: p.member_email, name: p.member_name, leadId: p.lead_id, csNote: handoff?.note ?? null })}
                  className={cn(
                    'w-full rounded-xl p-3 text-left group flex items-center gap-3 transition-all',
                    isHighlighted
                      ? 'bg-gradient-to-br from-[#FF6B35]/15 to-amber-500/5 border-2 border-[#FF6B35]/40 shadow-lg shadow-[#FF6B35]/10 hover:from-[#FF6B35]/20 hover:border-[#FF6B35]/60'
                      : 'card-premium'
                  )}
                >
                  <div className="relative">
                    <Avatar name={p.member_name || undefined} email={p.member_email} size="md" photoUrl={p.lead_avatar} ring={isHighlighted} />
                    {isHighlighted && (
                      <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-gradient-to-br from-[#FF6B35] to-amber-500 border-2 border-zinc-950 flex items-center justify-center shadow-lg shadow-[#FF6B35]/40">
                        <Star className="w-2.5 h-2.5 text-white fill-white" strokeWidth={2.5} />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className={cn('text-sm font-semibold truncate transition-colors', isHighlighted ? 'text-[#FFD7B5] group-hover:text-white' : 'text-white group-hover:text-[#FF6B35]')}>
                        {p.member_name || p.member_email}
                      </p>
                      <HealthDot score={p.health_score} />
                      {isHighlighted && (
                        <span className="text-[9px] font-bold uppercase tracking-wider text-[#FF6B35] bg-[#FF6B35]/15 border border-[#FF6B35]/30 px-1.5 py-0.5 rounded-md">CS</span>
                      )}
                    </div>
                    {isHighlighted && handoff?.note && (
                      <p className="text-[11px] text-amber-200/80 leading-snug mt-1 line-clamp-2 italic">"{handoff.note}"</p>
                    )}
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-zinc-500 font-mono">
                      {p.days_as_client !== null && <span>cliente há {p.days_as_client}d</span>}
                      {p.questions_count > 0 && <span>• {p.questions_count} perg</span>}
                    </div>
                  </div>
                  {(() => {
                    const remote = findRemoteByEmail(p.member_email);
                    const micOn = remote ? remote.isMicrophoneEnabled : false;
                    return micOn ? (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); muteAlunoMic(p.member_email); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); muteAlunoMic(p.member_email); } }}
                        className="shrink-0 p-2 rounded-lg text-emerald-400 hover:text-white hover:bg-red-500/30 border border-emerald-500/30 hover:border-red-500/50 transition-colors cursor-pointer"
                        title="Mic ligado — clique pra mutar"
                      >
                        <Mic className="w-3.5 h-3.5" />
                      </span>
                    ) : (
                      <span className="shrink-0 p-2 rounded-lg text-zinc-600 border border-zinc-800/60" title="Mic mutado">
                        <MicOff className="w-3.5 h-3.5" />
                      </span>
                    );
                  })()}
                  <ChevronRight className={cn('w-4 h-4 transition-all', isHighlighted ? 'text-[#FF6B35]' : 'text-zinc-700 group-hover:text-[#FF6B35]', 'group-hover:translate-x-0.5')} />
                </motion.button>
              );
            })}
            {participants.length === 0 && (
              <div className="text-center py-16 text-zinc-600 text-xs">Ninguém entrou ainda</div>
            )}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

// ─── HealthGauge ───
function HealthGauge({ score }: { score: number | null }) {
  const value = score ?? 0;
  const pct = Math.max(0, Math.min(100, value));
  const circumference = 2 * Math.PI * 44;
  const strokeDashoffset = circumference - (pct / 100) * circumference;
  const color = pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';

  return (
    <div className="relative w-28 h-28 shrink-0">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(63,63,70,0.4)" strokeWidth="8" />
        <motion.circle cx="50" cy="50" r="44" fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={circumference} initial={{ strokeDashoffset: circumference }} animate={{ strokeDashoffset }} transition={{ duration: 1.2, ease: 'easeOut' }} style={{ filter: `drop-shadow(0 0 8px ${color}70)` }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-3xl font-bold text-white leading-none tracking-tight">{score !== null ? Math.round(value) : '—'}</span>
        <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-semibold mt-1">de 100</span>
      </div>
    </div>
  );
}

function StatTile({ icon, value, label, sub }: any) {
  return (
    <div className="card-premium rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-2 opacity-80">{icon}<span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{label}</span></div>
      <p className="font-display text-2xl font-bold text-white leading-none">{value}</p>
      {sub && <p className="text-[10px] text-zinc-500 mt-1.5">{sub}</p>}
    </div>
  );
}

function CollapsibleSection({ title, icon, defaultOpen, children }: { title: string; icon: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-zinc-900/40 transition-colors">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">{title}</span>
        </div>
        <ChevronRight className={cn('w-4 h-4 text-zinc-600 transition-transform', open && 'rotate-90')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SubScore({ label, value }: { label: string; value: number | null }) {
  const v = value ?? 0;
  const color = v >= 70 ? 'text-emerald-400' : v >= 40 ? 'text-amber-400' : v >= 20 ? 'text-orange-400' : 'text-red-400';
  return (
    <div className="text-center">
      <p className={cn('font-mono font-bold text-base', color)}>{value ?? '—'}</p>
      <p className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold mt-0.5">{label}</p>
    </div>
  );
}

// ─── LeadDossierPanel ───
function LeadDossierPanel({ member, onClose }: { member: { email: string; name: string | null; leadId: string | null; csNote?: string | null }; onClose: () => void }) {
  const [dossier, setDossier] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showWhats, setShowWhats] = useState(false);
  const [detailModal, setDetailModal] = useState<'lessons' | 'calls' | 'whatsapp' | 'support' | null>(null);

  useEffect(() => {
    if (!member?.leadId) { setLoading(false); return; }
    (async () => {
      const { data } = await supabase.functions.invoke('mentoring-actions', { body: { action: 'get_lead_dossier', lead_id: member.leadId } });
      setDossier(data?.dossier || null);
      setLoading(false);
    })();
  }, [member?.leadId]);

  const lead = dossier?.lead;
  const org = dossier?.org;
  const eng = dossier?.engagement;
  const objs = dossier?.objectives || [];
  const wpps = dossier?.whatsapp_messages || [];

  return (
    <motion.div initial={{ x: '100%', opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: '100%', opacity: 0 }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="fixed top-16 right-0 w-[440px] max-w-[92vw] bottom-24 bg-zinc-950/95 backdrop-blur-2xl border-l border-zinc-800/60 shadow-2xl shadow-black/50 z-30 flex flex-col overflow-hidden rounded-tl-3xl">
      <div className="px-5 py-4 border-b border-zinc-800/60 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#FF6B35] to-[#FF4500] flex items-center justify-center">
            <BarChart3 className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <h2 className="font-bold text-white text-sm leading-none">Dossiê</h2>
            <p className="text-zinc-500 text-[10px] mt-0.5 uppercase tracking-widest font-semibold">Aluno em foco</p>
          </div>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-white p-1.5 rounded-lg hover:bg-zinc-800/60 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {member.csNote && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-5 mt-4 mb-1 rounded-2xl p-4 bg-gradient-to-br from-[#FF6B35]/15 to-amber-500/10 border-2 border-[#FF6B35]/40 shadow-lg shadow-[#FF6B35]/10"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#FF6B35] to-amber-500 flex items-center justify-center shadow-md">
                <Star className="w-3 h-3 text-white fill-white" strokeWidth={2.5} />
              </div>
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#FFD7B5]">Recado do CS pra essa mentoria</span>
            </div>
            <p className="text-amber-100 text-sm leading-relaxed italic">"{member.csNote}"</p>
          </motion.div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }} className="w-8 h-8 rounded-full border-2 border-zinc-800 border-t-[#FF6B35]" />
          </div>
        ) : !lead ? (
          <div className="p-5">
            <div className="text-center py-8">
              <div className="w-20 h-20 mx-auto mb-4">
                <Avatar name={member.name || undefined} email={member.email} size="xl" ring />
              </div>
              <h3 className="font-display text-xl font-bold text-white mb-1">{member.name || 'Sem nome'}</h3>
              <p className="text-zinc-500 text-sm mb-4">{member.email}</p>
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[11px] font-semibold">
                <AlertCircle className="w-3 h-3" /> Não vinculado ao CRM
              </div>
              <p className="text-zinc-600 text-xs mt-4 max-w-xs mx-auto leading-relaxed">Esse aluno está logado na área de membros mas ainda não tem um lead correspondente no CRM.</p>
            </div>
          </div>
        ) : (
          <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06 } } }} className="p-5 space-y-4">
            <motion.div variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }} className="flex items-start gap-4">
              <Avatar name={lead.name} email={lead.email || member.email} size="xl" ring photoUrl={lead.avatar} />
              <div className="min-w-0 flex-1 pt-1">
                <h3 className="font-display text-xl font-bold text-white leading-tight tracking-tight truncate">{lead.name}</h3>
                {org && <p className="text-zinc-400 text-xs mt-0.5">{org.name}</p>}
                <div className="text-zinc-400 text-xs space-y-1 mt-2">
                  {lead.email && <div className="flex items-center gap-1.5"><Mail className="w-3 h-3 shrink-0" /><span className="truncate">{lead.email}</span></div>}
                  {lead.phone && <div className="flex items-center gap-1.5 font-mono"><Phone className="w-3 h-3 shrink-0" /> {lead.phone}</div>}
                </div>
                {dossier.days_as_client !== null && (
                  <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-semibold">
                    <Star className="w-2.5 h-2.5" /> Cliente há {dossier.days_as_client} dias
                  </div>
                )}
              </div>
            </motion.div>

            {dossier.health && (
              <motion.div variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }} className="card-premium rounded-2xl p-5">
                <div className="flex items-center gap-5">
                  <HealthGauge score={dossier.health.overall_score} />
                  <div className="min-w-0 flex-1">
                    <p className="text-zinc-500 text-[10px] font-bold uppercase tracking-[0.2em]">Health Score</p>
                    <p className="text-white font-semibold text-sm mt-1 capitalize">
                      {dossier.health.health_status === 'healthy' ? '✅ Saudável' : dossier.health.health_status === 'at_risk' ? '⚠️ Em risco' : dossier.health.health_status === 'critical' ? '🚨 Crítico' : dossier.health.health_status}
                    </p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Touchpoints — 4 canais com fallback do member_engagement_snapshots */}
            {(() => {
              const em = dossier.engagement_metrics || {};
              const wpps = dossier.whatsapp_messages || [];
              const lastWpp = wpps.length > 0 ? wpps[wpps.length - 1].sent_at : null;
              // Fallback: usa member_engagement_snapshots quando cs_engagement_metrics tá vazio
              // Prioriza dados reais (member_lessons_progress) sobre snapshots
              const lessonsCompleted = dossier.stats?.lessons_completed ?? em.member_area_completed_lessons ?? eng?.lessons_completed ?? 0;
              const lessonsTotal = dossier.stats?.lessons_total ?? em.member_area_total_lessons ?? eng?.lessons_started ?? 0;
              const lessonsTime = em.member_area_time_spent_minutes ?? eng?.total_time_minutes ?? 0;
              const lessonsLast = (dossier.lessons?.[0]?.last_watched_at) ?? em.member_area_last_access ?? eng?.last_access;
              const callsCount = (dossier.calls?.length) || em.zoom_total_participations || eng?.calls_attended || 0;
              const callsTime = em.zoom_total_minutes ?? eng?.calls_total_minutes ?? 0;
              const callsLast = (dossier.calls?.[0]?.starts_at) ?? em.zoom_last_participation ?? eng?.last_call_date;

              const channels = [
                { key: 'lessons' as const, label: 'Área de Membros', icon: '📚', last: lessonsLast, info: `${lessonsCompleted}/${lessonsTotal} aulas${lessonsTime ? ` · ${Math.round(lessonsTime/60)}h` : ''}`, count: lessonsTotal },
                { key: 'whatsapp' as const, label: 'WhatsApp', icon: '💬', last: lastWpp, info: `${wpps.length} mensagens`, count: wpps.length },
                { key: 'calls' as const, label: 'Calls Zoom', icon: '🎥', last: callsLast, info: `${callsCount} participações${callsTime ? ` · ${Math.round(callsTime/60)}h` : ''}`, count: callsCount },
              ];
              return (
                <motion.div variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}>
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 mb-2 px-1">Touchpoints — clique pra detalhes</p>
                  <div className="space-y-1.5">
                    {channels.map((c) => {
                      const days = c.last ? Math.floor((Date.now() - new Date(c.last).getTime()) / 86400000) : null;
                      const dotColor = days === null ? 'bg-zinc-700' : days <= 3 ? 'bg-emerald-400' : days <= 14 ? 'bg-amber-400' : 'bg-red-400';
                      const clickable = c.count > 0;
                      return (
                        <button
                          key={c.key}
                          onClick={() => clickable && setDetailModal(c.key)}
                          disabled={!clickable}
                          className={cn(
                            'w-full card-premium rounded-xl p-3 flex items-center gap-3 text-left transition-all',
                            clickable ? 'hover:border-[#FF6B35]/50 cursor-pointer group' : 'opacity-60 cursor-not-allowed'
                          )}
                        >
                          <div className="text-xl shrink-0">{c.icon}</div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <p className="text-white text-xs font-semibold">{c.label}</p>
                              <span className={cn('w-1.5 h-1.5 rounded-full', dotColor)} />
                            </div>
                            <p className="text-[10px] text-zinc-500 mt-0.5">
                              {c.info || '—'}
                              {c.last && <span className="font-mono"> · {timeAgo(c.last)} atrás</span>}
                            </p>
                          </div>
                          {clickable && <ChevronRight className="w-4 h-4 text-zinc-700 group-hover:text-[#FF6B35] group-hover:translate-x-0.5 transition-all shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              );
            })()}

            {/* Objetivos do cliente */}
            {objs.length > 0 && (
              <motion.div variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}>
                <CollapsibleSection
                  title={`Objetivos (${objs.filter((o: any) => o.status === 'completed').length}/${objs.length} completos)`}
                  icon={<Target className="w-3.5 h-3.5 text-[#FF6B35]" />}
                  defaultOpen={true}
                >
                  <div className="space-y-2">
                    {objs.map((o: any, i: number) => (
                      <div key={i} className="card-premium rounded-xl p-3">
                        <div className="flex items-start gap-2.5">
                          <div className={cn('w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5',
                            o.status === 'completed' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400')}>
                            {o.status === 'completed' ? <Check className="w-3 h-3" /> : <Target className="w-3 h-3" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-white text-xs leading-relaxed">{o.description}</p>
                            {o.deadline && (
                              <p className="text-[10px] text-zinc-500 mt-1 font-mono">prazo: {new Date(o.deadline).toLocaleDateString('pt-BR')}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CollapsibleSection>
              </motion.div>
            )}

            {lead.context && (
              <motion.div variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }} className="card-premium rounded-2xl p-4 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#FF6B35]/50 to-transparent" />
                <div className="flex items-center gap-1.5 mb-2">
                  <Target className="w-3.5 h-3.5 text-[#FF6B35]" strokeWidth={2.5} />
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#FF6B35]">Objetivo</span>
                </div>
                <p className="text-white text-sm leading-relaxed">{lead.context}</p>
              </motion.div>
            )}

            {dossier.last_nps && (
              <motion.div variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }} className="rounded-2xl p-4 border border-[#FF6B35]/25 bg-gradient-to-br from-[#FF6B35]/10 via-transparent to-transparent">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#FF6B35]">Último NPS</span>
                  <div className="flex items-center gap-1">
                    <Star className="w-3.5 h-3.5 text-[#FF6B35] fill-[#FF6B35]" />
                    <span className="font-display text-xl font-bold text-white">{dossier.last_nps.score}</span>
                    <span className="text-zinc-500 text-xs">/10</span>
                  </div>
                </div>
                {dossier.last_nps.comment && (
                  <p className="text-zinc-300 text-sm italic leading-relaxed border-l-2 border-[#FF6B35]/40 pl-3">"{dossier.last_nps.comment}"</p>
                )}
              </motion.div>
            )}

            {dossier.deals?.length > 0 && (
              <motion.div variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 mb-2 px-1">Jornada</p>
                <div className="space-y-2">
                  {dossier.deals.map((d: any) => (
                    <div key={d.id} className="card-premium rounded-xl p-3 flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-white font-semibold text-sm truncate">{d.title}</p>
                        <p className="text-zinc-500 text-[10px] uppercase tracking-wider mt-0.5">{d.status}</p>
                      </div>
                      {d.negotiated_price && (
                        <span className="font-mono font-bold text-emerald-400 text-sm shrink-0 ml-3">R$ {d.negotiated_price.toLocaleString('pt-BR')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {dossier.notes?.length > 0 && (
              <motion.div variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 mb-2 px-1">Últimas notas</p>
                <div className="relative pl-4 space-y-3">
                  <div className="absolute left-[5px] top-1.5 bottom-1.5 w-px bg-gradient-to-b from-[#FF6B35]/40 via-zinc-800 to-transparent" />
                  {dossier.notes.slice(0, 4).map((n: any, i: number) => (
                    <div key={i} className="relative">
                      <div className="absolute -left-[13px] top-1 w-2.5 h-2.5 rounded-full bg-[#FF6B35] ring-4 ring-zinc-950" />
                      <p className="text-white text-sm leading-relaxed">{n.content}</p>
                      <p className="text-zinc-600 text-[10px] mt-0.5 font-mono">{timeAgo(n.created_at)} atrás</p>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

          </motion.div>
        )}
      </div>

      {/* Modal de detalhes ao clicar em touchpoint */}
      <AnimatePresence>
        {detailModal && (
          <TouchpointDetailModal
            type={detailModal}
            dossier={dossier}
            onClose={() => setDetailModal(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── TouchpointDetailModal ───
function TouchpointDetailModal({ type, dossier, onClose }: { type: 'lessons' | 'calls' | 'whatsapp' | 'support'; dossier: any; onClose: () => void }) {
  const config = {
    lessons: { icon: '📚', title: 'Aulas assistidas', count: dossier.lessons?.length || 0 },
    calls: { icon: '🎥', title: 'Calls participadas', count: dossier.calls?.length || 0 },
    whatsapp: { icon: '💬', title: 'Conversas WhatsApp', count: dossier.whatsapp_messages?.length || 0 },
    support: { icon: '🆘', title: 'Suporte', count: 0 },
  }[type];

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-md p-4"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="card-premium rounded-3xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="text-2xl">{config.icon}</div>
            <div>
              <h2 className="font-display text-white font-bold text-lg leading-none">{config.title}</h2>
              <p className="text-zinc-500 text-xs mt-1">{config.count} item{config.count !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white p-2 rounded-lg hover:bg-zinc-800/60 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {type === 'lessons' && (
            <div className="space-y-2">
              {dossier.lessons?.map((l: any, i: number) => (
                <div key={i} className="card-premium rounded-xl p-4 flex items-start gap-3">
                  <div className={cn('w-7 h-7 rounded-full flex items-center justify-center shrink-0',
                    l.completed ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-700/40 text-zinc-500')}>
                    {l.completed ? <Check className="w-4 h-4" strokeWidth={3} /> : <span className="text-xs">▶</span>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-sm font-semibold">{l.lesson_title || `Aula ${i + 1}`}</p>
                    <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500 font-mono">
                      {l.last_watched_at && <span>👁 {new Date(l.last_watched_at).toLocaleString('pt-BR')}</span>}
                      {l.seconds_watched > 0 && <span>⏱ {Math.round(l.seconds_watched / 60)}min</span>}
                      {l.completed && l.completed_at && <span className="text-emerald-400">✓ {new Date(l.completed_at).toLocaleDateString('pt-BR')}</span>}
                    </div>
                  </div>
                </div>
              ))}
              {!dossier.lessons?.length && <p className="text-center text-zinc-500 py-12 text-sm">Nenhuma aula registrada</p>}
            </div>
          )}

          {type === 'calls' && (
            <div className="space-y-2">
              {dossier.calls?.map((c: any, i: number) => (
                <div key={i} className="card-premium rounded-xl p-4 flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/15 text-blue-400 flex items-center justify-center shrink-0">
                    🎥
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-white text-sm font-semibold">{c.title || 'Call'}</p>
                      {c.type && <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 uppercase tracking-wider shrink-0">{c.type}</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500 font-mono">
                      {c.starts_at && <span>📅 {new Date(c.starts_at).toLocaleString('pt-BR')}</span>}
                      {c.duration_seconds && <span>⏱ {Math.round(c.duration_seconds / 60)}min ouvindo</span>}
                    </div>
                  </div>
                </div>
              ))}
              {!dossier.calls?.length && (
                <div className="text-center py-12">
                  <p className="text-zinc-400 text-sm font-semibold">Não tem detalhes individuais ainda</p>
                  <p className="text-zinc-600 text-xs mt-1">Sistema só registra contagem agregada nesta versão</p>
                </div>
              )}
            </div>
          )}

          {type === 'whatsapp' && (
            <div className="space-y-2">
              {dossier.whatsapp_messages?.map((m: any, i: number) => (
                <div key={i} className={cn('flex', m.is_from_me ? 'justify-end' : 'justify-start')}>
                  <div className={cn('max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                    m.is_from_me ? 'bg-[#FF6B35]/15 text-white border border-[#FF6B35]/20 rounded-br-sm' : 'bg-zinc-800/80 text-zinc-100 rounded-bl-sm')}>
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                    <p className="text-[10px] text-zinc-500 mt-1 font-mono">{new Date(m.sent_at).toLocaleString('pt-BR')}</p>
                  </div>
                </div>
              ))}
              {!dossier.whatsapp_messages?.length && <p className="text-center text-zinc-500 py-12 text-sm">Nenhuma mensagem registrada</p>}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── ChatPanel ───
function ChatPanel({ messages, onSend, onClose, myName }: {
  messages: ChatMsg[];
  onSend: (text: string, media?: { url: string; type: 'image' | 'file'; filename: string; size: number }) => void;
  onClose: () => void;
  myName: string;
}) {
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    onSend(text);
    setText('');
  };

  const handleFile = async (file: File, kind: 'image' | 'file') => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Arquivo muito grande (máx 10MB)');
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split('.').pop() || 'bin';
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const path = `chat/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
      const { error } = await supabase.storage.from('mentoring-chat-media').upload(path, file, {
        contentType: file.type,
        cacheControl: '3600',
        upsert: false,
      });
      if (error) throw error;
      const { data: pub } = supabase.storage.from('mentoring-chat-media').getPublicUrl(path);
      onSend(text, { url: pub.publicUrl, type: kind, filename: file.name, size: file.size });
      setText('');
    } catch (err: any) {
      console.error('[ChatPanel] upload falhou:', err);
      toast.error(`Falha no upload: ${err?.message || 'erro'}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const formatBytes = (b?: number) => {
    if (!b) return '';
    if (b < 1024) return `${b}B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
    return `${(b / 1024 / 1024).toFixed(1)}MB`;
  };

  return (
    <motion.aside
      initial={{ x: '-100%', opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: '-100%', opacity: 0 }}
      transition={{ type: 'spring', damping: 28, stiffness: 280 }}
      className="fixed top-16 left-0 w-[360px] max-w-[90vw] bottom-24 bg-zinc-950/95 backdrop-blur-2xl border-r border-zinc-800/60 shadow-2xl z-30 flex flex-col rounded-tr-3xl overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-zinc-800/60 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center">
            <MessageSquare className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <h2 className="font-bold text-white text-sm leading-none">Chat ao vivo</h2>
            <p className="text-zinc-500 text-[10px] mt-0.5 uppercase tracking-widest font-semibold">Todos veem</p>
          </div>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-white p-1.5 rounded-lg hover:bg-zinc-800/60 transition-colors">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center py-10">
            <MessageSquare className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
            <p className="text-zinc-500 text-sm">Sem mensagens ainda</p>
            <p className="text-zinc-600 text-xs mt-1">Seja o primeiro a comentar 👇</p>
          </div>
        ) : (
          messages.map((m) => {
            const isMe = m.from === 'Você';
            return (
              <div key={m.id} className={cn('flex flex-col gap-1', isMe && 'items-end')}>
                <div className="flex items-center gap-1.5">
                  <span className={cn('text-[10px] font-bold', m.isMentor ? 'text-[#FF6B35]' : 'text-zinc-400')}>
                    {m.from}
                    {m.isMentor && <span className="ml-1 text-[8px] uppercase tracking-wider px-1 py-0.5 rounded bg-[#FF6B35]/15 text-[#FF6B35]">Mentor</span>}
                  </span>
                  <span className="text-[9px] text-zinc-600 font-mono">{new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className={cn(
                  'max-w-[85%] rounded-2xl text-sm leading-relaxed overflow-hidden',
                  isMe ? 'bg-[#FF6B35]/15 text-white border border-[#FF6B35]/20 rounded-tr-sm' :
                  m.isMentor ? 'bg-[#FF6B35]/10 text-white border border-[#FF6B35]/30 rounded-tl-sm' :
                  'bg-zinc-800/80 text-zinc-100 rounded-tl-sm'
                )}>
                  {m.media_type === 'image' && m.media_url && (
                    <button
                      type="button"
                      onClick={() => setLightbox(m.media_url!)}
                      className="block w-full bg-black/40 hover:opacity-90 transition"
                    >
                      <img
                        src={m.media_url}
                        alt={m.media_filename || 'imagem'}
                        className="max-w-full max-h-64 object-contain mx-auto"
                      />
                    </button>
                  )}
                  {m.media_type === 'file' && m.media_url && (
                    <a
                      href={m.media_url}
                      target="_blank"
                      rel="noreferrer"
                      download={m.media_filename}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition"
                    >
                      <FileText className="w-5 h-5 text-[#FF6B35] shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-xs font-medium truncate">{m.media_filename || 'arquivo'}</p>
                        <p className="text-zinc-500 text-[10px]">{formatBytes(m.media_size)}</p>
                      </div>
                      <Download className="w-4 h-4 text-zinc-400 shrink-0" />
                    </a>
                  )}
                  {m.text && (
                    <p className="whitespace-pre-wrap break-words px-3 py-2">{m.text}</p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f, 'image'); }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f, 'file'); }}
      />

      <form onSubmit={handleSend} className="border-t border-zinc-800/60 p-3 bg-zinc-950/60 shrink-0 flex gap-2 items-center">
        <button
          type="button"
          disabled
          onClick={() => imageInputRef.current?.click()}
          className="w-9 h-9 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition shrink-0 disabled:opacity-50"
          title="Upload de imagem será ativado após configurar URLs assinadas por sessão"
        >
          <ImageIcon className="w-4 h-4" />
        </button>
        <button
          type="button"
          disabled
          onClick={() => fileInputRef.current?.click()}
          className="w-9 h-9 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition shrink-0 disabled:opacity-50"
          title="Upload de arquivo será ativado após configurar URLs assinadas por sessão"
        >
          <Paperclip className="w-4 h-4" />
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={uploading ? 'Enviando…' : 'Digite uma mensagem...'}
          maxLength={300}
          disabled={uploading}
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#FF6B35]/50 focus:ring-2 focus:ring-[#FF6B35]/20 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!text.trim() || uploading}
          className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center transition-all shrink-0',
            text.trim() && !uploading ? 'bg-gradient-to-r from-[#FF6B35] to-[#FF4500] text-white hover:opacity-90' : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          )}
        >
          <Send className="w-4 h-4" />
        </button>
      </form>

      {lightbox && createPortal(
        <div
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="" className="max-w-full max-h-full object-contain" />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-white flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>,
        document.body,
      )}
    </motion.aside>
  );
}

// ─── NpsModal ───
function NpsModal({ sessionId, participantId, leadId, email, onDone }: any) {
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);

  const emojiMap = ['😞','😞','😕','😕','😐','😐','😐','🙂','😊','🤩','🤩'];
  const descMap = ['Péssimo','Ruim','Ruim','Fraco','Neutro','Neutro','OK','Bom','Ótimo','Incrível','Sensacional'];
  const displayScore = hovered ?? score;

  const submit = async () => {
    if (score === null || sending) return; // bloqueia double-click
    setSending(true);
    try {
      await supabase.functions.invoke('mentoring-actions', {
        body: { action: 'submit_nps', session_id: sessionId, participant_id: participantId, lead_id: leadId, email, score, comment: comment.trim() || null },
      });
    } finally {
      setSending(false);
    }
    onDone();
  };

  return (
    <div className="min-h-screen bg-mesh bg-grain flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', damping: 22, stiffness: 220 }} className="max-w-md w-full card-premium rounded-3xl p-7">
        <div className="text-center mb-7">
          <motion.div key={displayScore ?? 'default'} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', damping: 18 }} className="text-6xl mb-4">
            {displayScore !== null ? emojiMap[displayScore] : '🤔'}
          </motion.div>
          <h1 className="font-display text-2xl font-bold text-white tracking-tight mb-1">
            {displayScore !== null ? descMap[displayScore] : 'Como foi pra você?'}
          </h1>
          <p className="text-zinc-400 text-sm">{displayScore !== null ? `Nota ${displayScore}/10` : 'Do 0 ao 10, o quanto te ajudou?'}</p>
        </div>

        <div className="grid grid-cols-11 gap-1 mb-6">
          {Array.from({ length: 11 }).map((_, i) => {
            const isActive = score !== null && i <= score;
            const isHoveredRange = hovered !== null && i <= hovered;
            return (
              <motion.button key={i} whileHover={{ y: -3, scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={() => setScore(i)} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} className={cn(
                'aspect-square rounded-lg text-xs font-bold transition-colors border',
                score === i ? 'bg-[#FF6B35] border-[#FF6B35] text-white' :
                isActive || isHoveredRange ? 'bg-[#FF6B35]/30 border-[#FF6B35]/50 text-white' :
                'bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700'
              )}>{i}</motion.button>
            );
          })}
        </div>

        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Algum comentário? (opcional)" className="bg-zinc-900/60 border-zinc-800 text-white placeholder:text-zinc-600 resize-none min-h-[90px] mb-5 focus-visible:ring-[#FF6B35]/30 focus-visible:border-[#FF6B35]/50" />

        <motion.button whileTap={{ scale: 0.97 }} onClick={submit} disabled={score === null || sending} className={cn(
          'w-full h-12 rounded-xl font-bold text-white transition-all',
          score !== null ? 'bg-gradient-to-r from-[#FF6B35] to-[#FF4500] brand-glow' : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
        )}>
          {sending ? <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} className="w-5 h-5 rounded-full border-2 border-white/30 border-t-white mx-auto" /> : score === null ? 'Escolha uma nota' : 'Enviar e sair'}
        </motion.button>
      </motion.div>
    </div>
  );
}
