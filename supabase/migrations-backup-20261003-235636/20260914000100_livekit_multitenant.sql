-- LiveKit + mentorias, integrado ao schema existente do CRM.
-- Não recria public.meetings e não abre policies globais.

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS livekit_room_name text,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS recording_url text,
  ADD COLUMN IF NOT EXISTS recording_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS meetings_livekit_room_name_uidx
  ON public.meetings (livekit_room_name) WHERE livekit_room_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.mentoring_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  title text NOT NULL,
  description text,
  scheduled_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  livekit_room_name text NOT NULL UNIQUE,
  share_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')),
  recording_url text,
  recording_status text NOT NULL DEFAULT 'pending',
  transcriptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mentoring_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  session_id uuid NOT NULL REFERENCES public.mentoring_sessions(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  member_email text NOT NULL,
  member_name text NOT NULL,
  member_phone text,
  member_external_id text,
  entered_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  hand_raised_at timestamptz,
  called_at timestamptz,
  questions_count integer NOT NULL DEFAULT 0,
  engagement_score numeric NOT NULL DEFAULT 0,
  via_public_link boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, member_email)
);

CREATE TABLE IF NOT EXISTS public.mentoring_hand_raises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  session_id uuid NOT NULL REFERENCES public.mentoring_sessions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES public.mentoring_participants(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  member_email text,
  member_name text,
  raised_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mentoring_one_open_raise_per_participant
  ON public.mentoring_hand_raises (participant_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS public.mentoring_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  session_id uuid NOT NULL REFERENCES public.mentoring_sessions(id) ON DELETE CASCADE,
  participant_id uuid REFERENCES public.mentoring_participants(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  member_email text,
  member_name text,
  question text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'skipped')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  answer text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mentoring_sessions_tenant_idx ON public.mentoring_sessions (tenant_id, status);
CREATE INDEX IF NOT EXISTS mentoring_participants_session_idx ON public.mentoring_participants (tenant_id, session_id);
CREATE INDEX IF NOT EXISTS mentoring_questions_session_idx ON public.mentoring_questions (tenant_id, session_id, status);

ALTER TABLE public.mentoring_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mentoring_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mentoring_hand_raises ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mentoring_questions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['mentoring_sessions','mentoring_participants','mentoring_hand_raises','mentoring_questions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_tenant_select', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_tenant_insert', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_tenant_update', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_tenant_delete', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (tenant_id = public.get_tenant_id())', table_name || '_tenant_select', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (tenant_id = public.get_tenant_id())', table_name || '_tenant_insert', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (tenant_id = public.get_tenant_id()) WITH CHECK (tenant_id = public.get_tenant_id())', table_name || '_tenant_update', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (tenant_id = public.get_tenant_id())', table_name || '_tenant_delete', table_name);
  END LOOP;
END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('mentoring-chat-media', 'mentoring-chat-media', false, 10485760, ARRAY['image/jpeg','image/png','image/webp','application/pdf','text/plain'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Sem policy genérica no storage: anexos permanecem bloqueados até o caminho
-- incluir tenant/session e existir uma emissão de signed URL com autorização.
DROP POLICY IF EXISTS mentoring_media_authenticated_read ON storage.objects;
DROP POLICY IF EXISTS mentoring_media_authenticated_insert ON storage.objects;

CREATE OR REPLACE FUNCTION public.get_mentoring_enriched_participants(p_session_id uuid)
RETURNS SETOF public.mentoring_participants
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT p.* FROM public.mentoring_participants p
  WHERE p.session_id = p_session_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_mentoring_enriched_participants(uuid) TO authenticated, service_role;
