/**
 * MentoringDetail — Relatório de uma sessão de mentoria
 * Mostra participantes, perguntas, NPS, gravação. Dentro do layout padrão (sidebar preservada).
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft, Users, MessageSquare, Heart, Clock, Video, Play, Loader2,
  Check, Star, Hand, ThumbsUp, Copy, Download, Calendar, Radio, CalendarClock,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Sparkles, Brain, TrendingUp, Lightbulb } from 'lucide-react';

export default function MentoringDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [session, setSession] = useState<any>(null);
  const [participants, setParticipants] = useState<any[]>([]);
  const [questions, setQuestions] = useState<any[]>([]);
  const [nps, setNps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Map lead_id → org info (id + name). Pra direcionar o click pra /clientes/:org_id em vez do lead.
  const [orgByLead, setOrgByLead] = useState<Map<string, { id: string; name: string }>>(new Map());
  // Reagendar (precisa estar ANTES dos early returns pra não violar Rules of Hooks)
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleAt, setRescheduleAt] = useState('');
  const [rescheduling, setRescheduling] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      const [s, p, q, n] = await Promise.all([
        supabase.from('mentoring_sessions').select('*').eq('id', sessionId).maybeSingle(),
        supabase.from('mentoring_participants').select('*').eq('session_id', sessionId).order('entered_at'),
        supabase.from('mentoring_questions').select('*').eq('session_id', sessionId).order('submitted_at'),
        supabase.from('mentoring_nps').select('*').eq('session_id', sessionId).order('submitted_at'),
      ]);
      setSession(s.data);
      setParticipants(p.data || []);
      setQuestions(q.data || []);
      setNps(n.data || []);

      // Resolve organização de cada participante: 2 caminhos (primary_contact OU organization_members)
      const leadIds = Array.from(new Set((p.data || []).map((x: any) => x.lead_id).filter(Boolean))) as string[];
      if (leadIds.length > 0) {
        const map = new Map<string, { id: string; name: string }>();
        const [primaryRes, memberRes] = await Promise.all([
          supabase.from('organizations').select('id, name, primary_contact_id').in('primary_contact_id', leadIds),
          supabase.from('organization_members').select('contact_id, organization:organizations(id, name)').in('contact_id', leadIds).eq('status', 'active'),
        ]);
        primaryRes.data?.forEach((o: any) => { if (o.primary_contact_id) map.set(o.primary_contact_id, { id: o.id, name: o.name }); });
        memberRes.data?.forEach((m: any) => {
          if (m.contact_id && m.organization?.id && !map.has(m.contact_id)) map.set(m.contact_id, { id: m.organization.id, name: m.organization.name });
        });
        setOrgByLead(map);
      }

      setLoading(false);
    })();
  }, [sessionId]);

  if (loading) {
    return (
      <AppLayout>
        <div className="p-6 flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (!session) {
    return (
      <AppLayout>
        <div className="p-6 text-center text-muted-foreground py-20">Sessão não encontrada</div>
      </AppLayout>
    );
  }

  const avgNps = nps.length > 0 ? nps.reduce((s, n) => s + n.score, 0) / nps.length : null;
  const promoters = nps.filter((n) => n.score >= 9).length;
  const detractors = nps.filter((n) => n.score <= 6).length;
  const answeredQuestions = questions.filter((q) => q.status === 'answered').length;
  const totalHandsRaised = participants.filter((p) => p.hand_raised_at).length;
  const duration = session.started_at && session.ended_at
    ? Math.floor((new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 60000)
    : null;

  const copyLink = () => {
    navigator.clipboard.writeText(`https://iap.frankcosta.me/mentoria/${session.id}?token={JWT_DO_ALUNO}`);
    toast({ title: 'Link base copiado' });
  };

  // Reagendar (states declarados no topo do componente — handlers ficam aqui)
  const openReschedule = () => {
    const base = session.scheduled_at ? new Date(session.scheduled_at) : new Date();
    const local = new Date(base.getTime() - base.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    setRescheduleAt(local);
    setRescheduleOpen(true);
  };

  const confirmReschedule = async () => {
    if (!rescheduleAt || rescheduling) return;
    setRescheduling(true);
    try {
      const iso = new Date(rescheduleAt).toISOString();
      const { error } = await supabase
        .from('mentoring_sessions')
        .update({ scheduled_at: iso })
        .eq('id', session.id);
      if (error) throw error;
      setSession({ ...session, scheduled_at: iso });
      toast({ title: '📅 Mentoria reagendada', description: new Date(iso).toLocaleString('pt-BR') });
      setRescheduleOpen(false);
    } catch (e: any) {
      toast({ title: 'Erro ao reagendar', description: e?.message || 'Falhou', variant: 'destructive' });
    } finally {
      setRescheduling(false);
    }
  };

  const copyPublicLink = async () => {
    let token = (session as any).share_token as string | null;
    if (!token) {
      const arr = new Uint8Array(9);
      crypto.getRandomValues(arr);
      const newToken = btoa(String.fromCharCode(...arr)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + Date.now().toString(36).slice(-3);
      const { data, error } = await supabase
        .from('mentoring_sessions')
        .update({ share_token: newToken })
        .eq('id', session.id)
        .select('share_token')
        .single();
      if (error || !data?.share_token) {
        toast({ title: 'Erro', description: error?.message || 'Falha ao gerar link', variant: 'destructive' });
        return;
      }
      token = data.share_token;
      (session as any).share_token = token;
    }
    const link = `${window.location.origin}/m/${token}`;
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: '🔗 Link público copiado!', description: 'Cola onde quiser. Quem clicar entra preenchendo Nome + Email + WhatsApp.' });
    } catch {
      toast({ title: 'Falha ao copiar', description: link, variant: 'destructive' });
    }
  };

  return (
    <AppLayout>
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/mentorias')} className="mb-3 gap-1.5">
            <ArrowLeft className="h-3.5 w-3.5" /> Todas as mentorias
          </Button>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-2xl font-bold tracking-tight">{session.title}</h1>
                <StatusBadge status={session.status} />
              </div>
              {session.description && <p className="text-muted-foreground text-sm">{session.description}</p>}
              <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                {session.scheduled_at && <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> {new Date(session.scheduled_at).toLocaleString('pt-BR')}</span>}
                {duration !== null && <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {duration} min</span>}
              </div>
            </div>
            <div className="flex gap-2">
              {session.status !== 'completed' && (
                <Button onClick={() => navigate(`/mentoria/${session.id}`)} className="gap-1.5">
                  <Play className="h-3.5 w-3.5" /> {session.status === 'active' ? 'Voltar à call' : 'Iniciar'}
                </Button>
              )}
              {session.status === 'scheduled' && (
                <Button variant="outline" onClick={openReschedule} className="gap-1.5">
                  <CalendarClock className="h-3.5 w-3.5" /> Reagendar
                </Button>
              )}
              <Button variant="outline" onClick={copyLink} className="gap-1.5">
                <Copy className="h-3.5 w-3.5" /> Link
              </Button>
              {session.status !== 'completed' && session.status !== 'cancelled' && (
                <Button
                  variant="outline"
                  onClick={copyPublicLink}
                  className="gap-1.5 border-[#FF6B35]/40 text-[#FF6B35] hover:bg-[#FF6B35]/10 hover:text-[#FF6B35]"
                  title="Link único pra divulgar em grupos. Quem clicar preenche Nome + Email + WhatsApp pra entrar."
                >
                  <Radio className="h-3.5 w-3.5" /> Link público
                </Button>
              )}
              {session.recording_url && (
                <Button variant="outline" onClick={() => window.open(session.recording_url, '_blank')} className="gap-1.5">
                  <Video className="h-3.5 w-3.5" /> Gravação
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Métricas em cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Participantes" value={participants.length} icon={<Users className="h-4 w-4" />} />
          <MetricCard label="Mãos levantadas" value={totalHandsRaised} icon={<Hand className="h-4 w-4" />} />
          <MetricCard label="Perguntas" value={`${answeredQuestions}/${questions.length}`} icon={<MessageSquare className="h-4 w-4" />} sub="respondidas / total" />
          <MetricCard
            label="NPS médio"
            value={avgNps !== null ? avgNps.toFixed(1) : '—'}
            icon={<Heart className="h-4 w-4" />}
            sub={nps.length > 0 ? `${nps.length} resposta(s) • ${promoters} promo • ${detractors} detra` : 'sem respostas'}
          />
        </div>

        {/* Análise IA (se disponível) */}
        {session.metadata?.ai_analysis && (
          <AIAnalysisCard analysis={session.metadata.ai_analysis} />
        )}

        {/* Tabs — detalhes */}
        <Tabs defaultValue={session.metadata?.ai_analysis ? 'ai' : 'participants'}>
          <TabsList>
            {session.metadata?.ai_analysis && <TabsTrigger value="ai">Análise IA</TabsTrigger>}
            <TabsTrigger value="participants">Participantes ({participants.length})</TabsTrigger>
            <TabsTrigger value="questions">Perguntas ({questions.length})</TabsTrigger>
            <TabsTrigger value="nps">NPS ({nps.length})</TabsTrigger>
            {session.transcriptions?.length > 0 && <TabsTrigger value="transcript">Transcrição</TabsTrigger>}
          </TabsList>

          {session.metadata?.ai_analysis && (
            <TabsContent value="ai" className="mt-4">
              <AIAnalysisFull analysis={session.metadata.ai_analysis} />
            </TabsContent>
          )}

          {session.transcriptions?.length > 0 && (
            <TabsContent value="transcript" className="mt-4">
              <Card>
                <CardContent className="p-4 space-y-1.5 max-h-[500px] overflow-y-auto font-mono text-xs">
                  {(session.transcriptions as any[]).filter((t: any) => t.is_final).map((t: any, i: number) => (
                    <div key={i} className="flex gap-2">
                      <span className={cn('font-bold shrink-0 w-16', t.speaker === 'Você' ? 'text-[#FF6B35]' : 'text-emerald-600')}>{t.speaker}:</span>
                      <span className="text-foreground/80">{t.text}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          <TabsContent value="participants" className="mt-4 space-y-2">
            {participants.length === 0 ? (
              <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">Ninguém entrou ainda</CardContent></Card>
            ) : (
              participants.map((p) => {
                const org = p.lead_id ? orgByLead.get(p.lead_id) : null;
                const handleClick = () => {
                  if (org) navigate(`/clientes/${org.id}`);
                  else if (p.lead_id) navigate(`/comercial/leads/${p.lead_id}`);
                };
                return (
                <Card key={p.id} className="hover:border-primary/40 transition-colors cursor-pointer" onClick={handleClick}>
                  <CardContent className="py-4 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold truncate">{p.member_name || p.member_email}</span>
                        {org ? (
                          <Badge variant="outline" className="text-[10px]">Cliente · {org.name}</Badge>
                        ) : p.lead_id ? (
                          <Badge variant="outline" className="text-[10px]">Lead no CRM</Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">{p.member_email}</p>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                      {p.questions_count > 0 && <span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" />{p.questions_count}</span>}
                      {p.hand_raised_at && <Hand className="h-3 w-3 text-primary" />}
                      <span>{new Date(p.entered_at).toLocaleTimeString('pt-BR').slice(0, 5)}</span>
                    </div>
                  </CardContent>
                </Card>
                );
              })
            )}
          </TabsContent>

          <TabsContent value="questions" className="mt-4 space-y-2">
            {questions.length === 0 ? (
              <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">Nenhuma pergunta ainda</CardContent></Card>
            ) : (
              questions.map((q) => (
                <Card key={q.id}>
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">{q.member_name || q.member_email}</span>
                          <QuestionStatusBadge status={q.status} />
                          {q.source === 'pre_call' && <Badge variant="outline" className="text-[10px]">Antecipada</Badge>}
                        </div>
                        <p className="text-sm text-foreground mt-2">{q.question}</p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{new Date(q.submitted_at).toLocaleTimeString('pt-BR').slice(0, 5)}</span>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="nps" className="mt-4 space-y-2">
            {nps.length === 0 ? (
              <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">Nenhum NPS enviado ainda</CardContent></Card>
            ) : (
              nps.map((n) => (
                <Card key={n.id}>
                  <CardContent className="py-4">
                    <div className="flex items-start gap-3">
                      <div className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold shrink-0 ${n.score >= 9 ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : n.score >= 7 ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-red-500/15 text-red-600 dark:text-red-400'}`}>
                        {n.score}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm">{n.member_email}</p>
                        {n.comment && <p className="text-sm text-muted-foreground mt-1 italic">"{n.comment}"</p>}
                        <p className="text-xs text-muted-foreground mt-1">{new Date(n.submitted_at).toLocaleString('pt-BR')}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={rescheduleOpen} onOpenChange={setRescheduleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reagendar mentoria</DialogTitle>
            <DialogDescription>{session.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Nova data e hora</Label>
              <Input
                type="datetime-local"
                value={rescheduleAt}
                onChange={(e) => setRescheduleAt(e.target.value)}
                className="mt-1"
              />
              <p className="text-[11px] text-muted-foreground mt-1.5">Horário de Brasília</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRescheduleOpen(false)}>Cancelar</Button>
            <Button onClick={confirmReschedule} disabled={rescheduling || !rescheduleAt} className="gap-1.5">
              {rescheduling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function MetricCard({ label, value, icon, sub }: { label: string; value: any; icon: React.ReactNode; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs uppercase tracking-wider font-semibold mb-1">
          {icon} {label}
        </div>
        <p className="text-3xl font-bold">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') return <Badge className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/20 gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />AO VIVO</Badge>;
  if (status === 'scheduled') return <Badge variant="secondary">Agendada</Badge>;
  if (status === 'completed') return <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400 border-emerald-500/30"><Check className="h-3 w-3 mr-1" />Encerrada</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function QuestionStatusBadge({ status }: { status: string }) {
  if (status === 'answered') return <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 text-[10px]">Respondida</Badge>;
  if (status === 'skipped') return <Badge variant="outline" className="text-[10px]">Pulada</Badge>;
  if (status === 'in_progress') return <Badge className="bg-primary/15 text-primary border-primary/30 text-[10px]">Em andamento</Badge>;
  return <Badge variant="outline" className="text-[10px]">Pendente</Badge>;
}

function AIAnalysisCard({ analysis }: { analysis: any }) {
  return (
    <Card className="border-violet-200 bg-gradient-to-br from-violet-50/50 to-transparent dark:border-violet-900/50 dark:from-violet-950/20">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="h-4 w-4 text-violet-600" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-300">Análise IA da Mentoria</span>
          {analysis.student_engagement && (
            <Badge variant="outline" className="text-[10px] ml-auto">
              Engajamento: {analysis.student_engagement}
            </Badge>
          )}
        </div>
        <p className="text-sm text-foreground leading-relaxed">{analysis.summary}</p>
      </CardContent>
    </Card>
  );
}

function AIAnalysisFull({ analysis }: { analysis: any }) {
  return (
    <div className="space-y-4">
      {analysis.topics?.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Brain className="h-4 w-4" /> Temas abordados</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {analysis.topics.map((t: any, i: number) => (
              <div key={i} className="rounded-lg border p-3">
                <p className="font-semibold text-sm">{t.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {analysis.key_insights?.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Lightbulb className="h-4 w-4 text-amber-500" /> Insights-chave</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {analysis.key_insights.map((s: string, i: number) => (
                <li key={i} className="flex gap-2"><span className="text-amber-500">•</span><span>{s}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {analysis.highlights?.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Star className="h-4 w-4 text-amber-500" /> Momentos marcantes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {analysis.highlights.map((h: any, i: number) => (
              <div key={i} className="rounded-lg border-l-2 border-amber-500 bg-amber-50/40 dark:bg-amber-950/20 pl-3 py-1.5">
                <p className="text-[10px] font-mono text-muted-foreground">{h.timestamp_approx}</p>
                <p className="text-sm italic">"{h.quote}"</p>
                {h.why && <p className="text-xs text-muted-foreground mt-1">{h.why}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {analysis.next_mentoring_ideas?.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="h-4 w-4 text-emerald-500" /> Ideias pra próxima mentoria</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {analysis.next_mentoring_ideas.map((idea: string, i: number) => (
                <li key={i} className="flex gap-2"><span className="text-emerald-500">→</span><span>{idea}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
