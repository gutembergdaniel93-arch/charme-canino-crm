import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

async function getLeadDossier(leadId: string) {
  const { data: lead } = await supabase.from('leads').select('*, instagram_profile:instagram_profile_id(stored_profile_picture_url, profile_picture_url_hd, username)').eq('id', leadId).maybeSingle();
  if (!lead) return null;
  const { data: org } = await supabase.from('organizations').select('id, name, created_at').eq('primary_contact_id', leadId).maybeSingle();
  let healthData: any = null, engagement: any = null, engagementMetrics: any = null, objectives: any[] = [], calls: any[] = [], lessons: any[] = [];
  if (org?.id) {
    const [hRes, eRes, mRes, oRes, lRes] = await Promise.all([
      supabase.from('cs_health_current').select('*').eq('organization_id', org.id).maybeSingle(),
      supabase.from('member_engagement_snapshots').select('*').eq('organization_id', org.id).order('snapshot_hour', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('cs_engagement_metrics').select('*').eq('organization_id', org.id).maybeSingle(),
      supabase.from('cs_objectives').select('description, status, deadline, completed_at, notes').eq('organization_id', org.id).order('created_at', { ascending: false }),
      supabase.from('member_lessons_progress').select('lesson_title, completed, seconds_watched, started_at, completed_at, last_watched_at').eq('lead_id', leadId).order('last_watched_at', { ascending: false }).limit(50),
    ]);
    healthData = hRes.data; engagement = eRes.data; engagementMetrics = mRes.data; objectives = oRes.data || []; lessons = lRes.data || [];
  }
  if (lead.email) {
    const { data: callsData } = await supabase.from('call_session_attendance').select('joined_at, duration_seconds, session:session_id(type, title, starts_at, duration_minutes)').eq('zoom_user_email', lead.email).order('joined_at', { ascending: false }).limit(20);
    calls = (callsData || []).map((c: any) => ({ title: c.session?.title || '—', type: c.session?.type, starts_at: c.session?.starts_at, duration_seconds: c.duration_seconds, joined_at: c.joined_at }));
  }
  const [{ data: deals }, { data: notes }, { data: nps }, { data: whatsappMsgs }, { count: mentoringsCount }] = await Promise.all([
    supabase.from('deals').select('id, title, status, negotiated_price, total_paid, created_at').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(5),
    supabase.from('sales_notes').select('content, note_type, created_at').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(5),
    supabase.from('mentoring_nps').select('score, comment, submitted_at').eq('lead_id', leadId).order('submitted_at', { ascending: false }).limit(1),
    supabase.from('whatsapp_messages').select('content, is_from_me, sent_at, message_type').eq('lead_id', leadId).order('sent_at', { ascending: false }).limit(40),
    supabase.from('mentoring_participants').select('id', { count: 'exact', head: true }).eq('lead_id', leadId),
  ]);
  const daysAsClient = org?.created_at ? Math.floor((Date.now() - new Date(org.created_at).getTime()) / 86400000) : null;
  const avatar = lead.instagram_profile?.stored_profile_picture_url || lead.instagram_profile?.profile_picture_url_hd || lead.photo_url || null;
  return { lead: { ...lead, avatar }, org, days_as_client: daysAsClient, health: healthData, engagement, engagement_metrics: engagementMetrics, objectives, calls, lessons, deals: deals || [], notes: notes || [], last_nps: nps?.[0] || null, whatsapp_messages: (whatsappMsgs || []).reverse(), stats: { mentorings_participated: mentoringsCount || 0, lessons_total: lessons.length, lessons_completed: lessons.filter((l: any) => l.completed).length } };
}

async function triggerPostEndPipeline(sessionId: string) {
  // Aguarda analyze-mentoring-session que internamente faz sync pro PAIN
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` };
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/analyze-mentoring-session`, { method: 'POST', headers, body: JSON.stringify({ session_id: sessionId }) });
    const data = await res.json().catch(() => null);
    console.log(`[end_session] analyze result: ${res.status}`, data?.success ? 'ok' : data?.error);
  } catch (err) {
    console.error('[end_session] analyze falhou:', err);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { action, ...payload } = await req.json();
    const authorization = req.headers.get('Authorization') || '';
    const scopedClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const privilegedActions = new Set([
      'get_lead_dossier', 'answer_question', 'skip_question', 'unanswer_question',
      'start_session', 'end_session',
    ]);
    if (privilegedActions.has(action)) {
      const { data: { user } } = await scopedClient.auth.getUser();
      if (!user) {
        return new Response(JSON.stringify({ error: 'authentication required' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const resourceQuery = action === 'get_lead_dossier'
        ? scopedClient.from('leads').select('id').eq('id', payload.lead_id).maybeSingle()
        : scopedClient.from('mentoring_sessions').select('id').eq('id', payload.session_id).maybeSingle();
      const { data: allowedResource } = await resourceQuery;
      if (!allowedResource) {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (action === 'get_lead_dossier') {
      const { lead_id } = payload;
      if (!lead_id) return new Response(JSON.stringify({ error: 'lead_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const dossier = await getLeadDossier(lead_id);
      return new Response(JSON.stringify({ dossier }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'get_session_data') {
      const { session_id } = payload;
      if (!session_id) return new Response(JSON.stringify({ error: 'session_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const [{ data: participants }, { data: questions }, { data: handHistory }] = await Promise.all([
        supabase.rpc('get_mentoring_enriched_participants', { p_session_id: session_id }),
        supabase.from('mentoring_questions').select('*').eq('session_id', session_id).order('submitted_at', { ascending: true }),
        supabase.from('mentoring_hand_raises').select('*').eq('session_id', session_id).order('raised_at', { ascending: false }).limit(50),
      ]);
      const active = (participants || []).filter((p: any) => !p.left_at);
      return new Response(JSON.stringify({ participants: active, questions: questions || [], hand_history: handHistory || [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'join_session') {
      const { session_id, email, name, external_id, lead_id } = payload;
      const { data: participant, error } = await supabase.from('mentoring_participants').upsert({ session_id, member_email: email, member_name: name, member_external_id: external_id, lead_id, entered_at: new Date().toISOString(), left_at: null }, { onConflict: 'session_id,member_email' }).select().single();
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ participant }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'leave_session') {
      const { participant_id } = payload;
      if (participant_id) await supabase.from('mentoring_participants').update({ left_at: new Date().toISOString() }).eq('id', participant_id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'raise_hand') {
      const { participant_id } = payload;
      const { data: p } = await supabase.from('mentoring_participants').update({ hand_raised_at: new Date().toISOString() }).eq('id', participant_id).select().single();
      if (p) {
        const { data: existing } = await supabase
          .from('mentoring_hand_raises')
          .select('id')
          .eq('participant_id', p.id)
          .is('resolved_at', null)
          .limit(1)
          .maybeSingle();
        if (!existing) {
          const { error: insertErr } = await supabase.from('mentoring_hand_raises').insert({ session_id: p.session_id, participant_id: p.id, lead_id: p.lead_id, member_email: p.member_email, member_name: p.member_name });
          if (insertErr && !String(insertErr.message).toLowerCase().includes('duplicate')) console.error('[raise_hand] insert falhou:', insertErr);
        }
      }
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'lower_hand') {
      const { participant_id, resolution = 'self_lowered' } = payload;
      await supabase.from('mentoring_participants').update({ hand_raised_at: null }).eq('id', participant_id);
      const { data: lastRaise } = await supabase.from('mentoring_hand_raises').select('id').eq('participant_id', participant_id).is('resolved_at', null).order('raised_at', { ascending: false }).limit(1).maybeSingle();
      if (lastRaise) await supabase.from('mentoring_hand_raises').update({ resolved_at: new Date().toISOString(), resolution }).eq('id', lastRaise.id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'submit_question') {
      const { session_id, participant_id, lead_id, email, name, question, source = 'during_call' } = payload;
      const { data } = await supabase.from('mentoring_questions').insert({ session_id, participant_id, lead_id, member_email: email, member_name: name, question, source }).select().single();
      if (participant_id) {
        const { error: incrementError } = await supabase.rpc('increment_participant_questions', { p_participant_id: participant_id });
        if (incrementError) console.warn('[submit_question] contador não atualizado:', incrementError.message);
      }
      return new Response(JSON.stringify({ question: data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (action === 'answer_question') {
      await supabase.from('mentoring_questions').update({ status: 'answered', answered_at: new Date().toISOString() }).eq('id', payload.question_id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (action === 'skip_question') {
      await supabase.from('mentoring_questions').update({ status: 'skipped', skipped_at: new Date().toISOString() }).eq('id', payload.question_id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (action === 'unanswer_question') {
      await supabase.from('mentoring_questions').update({ status: 'pending', answered_at: null, skipped_at: null }).eq('id', payload.question_id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (action === 'submit_nps') {
      const { session_id, participant_id, lead_id, email, score, comment } = payload;
      if (participant_id) {
        const { data: existing } = await supabase.from('mentoring_nps').select('id').eq('participant_id', participant_id).limit(1).maybeSingle();
        if (existing) {
          const { data: updated } = await supabase.from('mentoring_nps').update({ score, comment, submitted_at: new Date().toISOString() }).eq('id', existing.id).select().single();
          return new Response(JSON.stringify({ nps: updated, updated: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
      const { data, error } = await supabase.from('mentoring_nps').insert({ session_id, participant_id, lead_id, member_email: email, score, comment }).select().single();
      if (error && String(error.message).toLowerCase().includes('duplicate')) {
        const { data: u } = await supabase.from('mentoring_nps').update({ score, comment, submitted_at: new Date().toISOString() }).eq('participant_id', participant_id).select().maybeSingle();
        return new Response(JSON.stringify({ nps: u, updated: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ nps: data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (action === 'start_session') {
      await supabase.from('mentoring_sessions').update({ status: 'active', started_at: new Date().toISOString() }).eq('id', payload.session_id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (action === 'end_session') {
      await supabase.from('mentoring_sessions').update({ status: 'completed', ended_at: new Date().toISOString() }).eq('id', payload.session_id);
      // Aguarda análise IA + sync pro PAIN (analyze-mentoring-session faz tudo)
      await triggerPostEndPipeline(payload.session_id);
      return new Response(JSON.stringify({ success: true, post_end_triggered: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
