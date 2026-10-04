import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Loader2, AlertCircle, Sparkles, ArrowRight } from 'lucide-react';
import { supabase } from '@/lib/supabase';

const SESSION_KEY = (token: string) => `mentoria_publica_token_${token}`;

function maskPhone(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

type SessionInfo = {
  id: string;
  title: string;
  started_at: string | null;
  live: boolean;
};

export default function MentoringPublicJoin() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<{ title?: string } | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setError('Link inválido'); setLoading(false); return; }
    let cancel = false;
    (async () => {
      try {
        const { data, error: err } = await supabase.functions.invoke('mentoring-public-join', {
          body: { action: 'info', share_token: token },
        });
        if (cancel) return;
        if (err) {
          // edge fn responde 410 quando ended
          const ctx = (err as any).context;
          if (ctx?.ended || (ctx?.title && String(err.message || '').includes('encerrada'))) {
            setEnded({ title: ctx?.title });
          } else {
            setError(String(err.message || 'Não foi possível carregar a mentoria'));
          }
          return;
        }
        if (data?.session) {
          setSession(data.session);
          // pré-preencher se já entrou antes
          try {
            const cached = localStorage.getItem(SESSION_KEY(token));
            if (cached) {
              const { name: n, email: e, phone: p } = JSON.parse(cached);
              if (n) setName(n);
              if (e) setEmail(e);
              if (p) setPhone(maskPhone(p));
            }
          } catch {}
        } else if (data?.ended) {
          setEnded({ title: data.title });
        } else {
          setError('Mentoria não encontrada');
        }
      } catch (e: any) {
        if (!cancel) setError(e?.message || 'Erro inesperado');
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [token]);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!token || !session) return;
    if (name.trim().length < 2) { setFormError('Digite seu nome completo'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFormError('Email inválido'); return; }
    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 10) { setFormError('Whatsapp inválido (com DDD)'); return; }

    setSubmitting(true);
    try {
      const url = new URL(window.location.href);
      const utm_source = url.searchParams.get('utm_source') || 'mentoria_link_publico';
      const utm_campaign = url.searchParams.get('utm_campaign') || '';

      const { data, error: err } = await supabase.functions.invoke('mentoring-public-join', {
        body: {
          action: 'join',
          share_token: token,
          name: name.trim(),
          email: email.trim().toLowerCase(),
          phone: phoneDigits,
          utm_source,
          utm_campaign,
        },
      });
      if (err) throw new Error((err as any).context?.error || err.message || 'Falha ao entrar');
      if (!data?.token) throw new Error('Resposta inválida do servidor');

      // Cache local pra reentradas
      try {
        localStorage.setItem(SESSION_KEY(token), JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), phone: phoneDigits }));
      } catch {}

      // Salva o token LiveKit + meta numa session storage e redireciona pra MentoringRoom
      sessionStorage.setItem(`mentoria_pub_${data.session_id}`, JSON.stringify({
        livekit_token: data.token,
        livekit_url: data.url,
        room_name: data.room_name,
        participant_id: data.participant_id,
        member_name: data.member_name,
        member_email: data.member_email,
        lead_id: data.lead_id,
        session_title: data.session_title,
        session_started_at: data.session_started_at,
      }));

      navigate(`/mentoria/${data.session_id}?pub=1`);
    } catch (e: any) {
      setFormError(e?.message || 'Erro ao entrar');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0c] flex items-center justify-center">
        <Loader2 className="h-8 w-8 text-[#FF6B35] animate-spin" />
      </div>
    );
  }

  if (ended) {
    return (
      <div className="min-h-screen bg-[#0a0a0c] flex items-center justify-center p-4">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="text-center max-w-sm">
          <AlertCircle className="h-14 w-14 text-amber-500 mx-auto mb-4" />
          <h1 className="font-display text-white text-2xl font-bold mb-2">Mentoria já encerrada</h1>
          <p className="text-zinc-400 text-sm">{ended.title || 'Esta sessão foi finalizada.'}</p>
          <p className="text-zinc-600 text-xs mt-4">Aguarde a próxima edição.</p>
        </motion.div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="min-h-screen bg-[#0a0a0c] flex items-center justify-center p-4">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="text-center max-w-sm">
          <AlertCircle className="h-14 w-14 text-red-500 mx-auto mb-4" />
          <h1 className="font-display text-white text-2xl font-bold mb-2">Link inválido</h1>
          <p className="text-zinc-400 text-sm">{error || 'Esta mentoria não foi encontrada.'}</p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0c] flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-zinc-950 border border-zinc-800/60 rounded-3xl p-7 shadow-2xl"
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[#FF6B35]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#FF6B35] animate-pulse" />
            {session.live ? 'Ao vivo agora' : 'Mentoria'}
          </span>
        </div>
        <h1 className="font-display text-white text-2xl font-bold leading-tight">{session.title}</h1>
        <p className="text-zinc-400 text-sm mt-1">Preencha pra entrar na sala.</p>

        <form onSubmit={handleJoin} className="mt-6 space-y-3">
          <div>
            <label className="text-zinc-400 text-[11px] uppercase tracking-wider font-semibold">Nome completo</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Como você quer aparecer"
              maxLength={80}
              className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#FF6B35]/50 focus:ring-2 focus:ring-[#FF6B35]/20"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="text-zinc-400 text-[11px] uppercase tracking-wider font-semibold">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              maxLength={120}
              className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#FF6B35]/50 focus:ring-2 focus:ring-[#FF6B35]/20"
              required
            />
          </div>
          <div>
            <label className="text-zinc-400 text-[11px] uppercase tracking-wider font-semibold">WhatsApp</label>
            <input
              value={phone}
              onChange={(e) => setPhone(maskPhone(e.target.value))}
              placeholder="(11) 99999-9999"
              inputMode="tel"
              maxLength={16}
              className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#FF6B35]/50 focus:ring-2 focus:ring-[#FF6B35]/20"
              required
            />
          </div>

          {formError && (
            <div className="text-red-400 text-xs bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{formError}</div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-gradient-to-r from-[#FF6B35] to-[#FF4500] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:opacity-90 transition disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Sparkles className="h-4 w-4" /> Entrar na mentoria <ArrowRight className="h-4 w-4" /></>}
          </button>

          <p className="text-zinc-600 text-[10px] text-center mt-3">
            Ao entrar, você autoriza o uso dos seus dados para contato sobre próximas mentorias.
          </p>
        </form>
      </motion.div>
    </div>
  );
}
