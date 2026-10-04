# Acelerador LiveKit — Substituindo Google Meet no seu CRM

> Este documento é um guia completo pra implementar uma sala própria de videochamada dentro do seu CRM usando **LiveKit Cloud** como backend, **Cloudflare R2** como storage de gravações, **Soniox** (opcional) pra transcrição em tempo real, e **Supabase** como backend e banco. A ideia é **substituir o Google Meet** em todas as chamadas comerciais/CS do seu CRM, ganhando: gravação automática, transcrição em tempo real, análise IA pós-call, painel com contexto do lead ao lado, chat privado entre host e observer, e controle total dos dados.
>
> **Este guia é AI-friendly**: joga ele na sua IA (Cursor, Copilot, Claude, GPT) e ela consegue implementar ponta a ponta no seu CRM, adaptando tabelas e caminhos conforme sua aplicação.

---

## Índice

1. [Visão geral da arquitetura](#1-visão-geral-da-arquitetura)
2. [Por que Cloudflare R2 (e não Supabase Storage)](#2-por-que-cloudflare-r2-e-não-supabase-storage)
3. [Pré-requisitos — contas a criar](#3-pré-requisitos--contas-a-criar)
4. [Credenciais e secrets do Supabase](#4-credenciais-e-secrets-do-supabase)
5. [Schema do banco (SQL)](#5-schema-do-banco-sql)
6. [Edge function `livekit-token`](#6-edge-function-livekit-token)
7. [Edge function `livekit-webhook`](#7-edge-function-livekit-webhook)
8. [Edge function `livekit-end-room`](#8-edge-function-livekit-end-room)
9. [Edge function `send-meeting-email` (opcional)](#9-edge-function-send-meeting-email-opcional)
10. [Frontend — página da sala `/meet/:roomId`](#10-frontend--página-da-sala-meetroomid)
11. [Frontend — hook `useLiveKit` e helpers](#11-frontend--hook-uselivekit-e-helpers)
12. [Integração com transcrição Soniox (opcional)](#12-integração-com-transcrição-soniox-opcional)
13. [Gotchas e aprendizados](#13-gotchas-e-aprendizados)
14. [Testes end-to-end](#14-testes-end-to-end)
15. [Custos mensais estimados](#15-custos-mensais-estimados)
16. [Checklist final](#16-checklist-final)
17. [**Melhorias Avançadas (Jun-Jul 2026)** — DataChannel transcription, recovery AssemblyAI, auto-restart egress, áudio da tela, overlay Zoom-style, Document PiP, modo Galeria, speaker diarization, chat persistente](#17-melhorias-avançadas-jun-jul-2026)
18. [**Sistema de Mentoria em Grupo** — sala pública com share_token, fila de mão levantada, perguntas antecipadas, handoff CS → Mentor, chat com anexos, modo Palco/Galeria, análise IA pós-mentoria](#18-sistema-de-mentoria-em-grupo)

---

## 1. Visão geral da arquitetura

Fluxo de uma reunião completa:

```
1. Usuário cria reunião no CRM → escolhe tipo "Sala Própria"
2. Frontend gera roomName único + meeting_link = https://seudominio.com/meet/<roomName>
3. Reunião cadastrada em company_activities (ou equivalente no seu CRM)
4. Host abre o link → página MeetRoom
   → pede token via edge function livekit-token
   → conecta no LiveKit Cloud (WebRTC)
5. LiveKit dispara webhook `participant_joined` → backend inicia Egress (gravação em MP4)
6. Reunião rola: vídeo, áudio, transcrição em tempo real (Soniox), chat observer
7. Host clica "Sair" → edge function livekit-end-room → DeleteRoom (kicka todos)
8. LiveKit dispara webhook `egress_ended` → salva URL do MP4 no R2 em meetings.recording_url
9. Backend dispara análise IA pós-call (opcional)
10. Timeline do lead mostra o card da reunião com link da gravação
```

**Componentes:**

| Camada | Responsabilidade |
|---|---|
| **LiveKit Cloud** | Servidor WebRTC SFU — 1 sala aguenta 100+ participantes |
| **Cloudflare R2** | Storage S3-compatible pras gravações (sem egress fees) |
| **Supabase Edge Functions** | Token generation, webhooks, orchestration |
| **Supabase DB** | `meetings` (sessões), `company_activities` (tasks) |
| **Frontend (React/Next)** | Página `/meet/:roomId` com PreJoin, VideoConference, recovery |
| **Soniox** (opcional) | STT dual-channel em tempo real |

---

## 2. Por que Cloudflare R2 (e não Supabase Storage)

**Regra de ouro:** use **Cloudflare R2** pra gravações de vídeo. Aqui o por quê:

### Limitações do Supabase Storage

- Upload multipart limitado a **6MB** em algumas rotas → uploads de 50-500MB (típico em calls de 30min-1h) **falham silenciosamente**
- Egress pago por GB ($0.09/GB a partir de 250GB/mês) — sai caro pra vídeos com muita visualização

### Por que R2 ganha

- **Zero egress fees** — assiste quantas vezes quiser sem pagar
- **10GB grátis** incluso (dá pra gravar ~50 calls de 30min)
- **S3-compatible** — LiveKit Egress integra nativo
- **URLs públicas** via `pub-xxx.r2.dev` (sem assinar URL)
- Barato: $0.015/GB depois do free tier

### Configuração mínima do R2

1. Criar bucket `meeting-recordings`
2. Marcar bucket como **Público** (Settings → Public Access → Enabled)
3. Gerar **API Token** com permissão **Object Read & Write** pro bucket
4. Copiar **Endpoint S3** do seu bucket (formato `https://<account-id>.r2.cloudflarestorage.com`)
5. Copiar **URL Pública** do bucket (formato `https://pub-xxx.r2.dev`)
6. Configurar **CORS** pra permitir seu domínio do CRM (necessário se for usar WebAudio)

**CORS policy do R2** (opcional, só se frontend for processar áudio via WebAudio):

```json
[
  {
    "AllowedOrigins": ["https://seudominio.com", "http://localhost:3000"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## 3. Pré-requisitos — contas a criar

### 3.1 LiveKit Cloud

1. Criar conta em https://cloud.livekit.io
2. Plano **Free tier** (5.000 min/mês) pra começar. Upgrade pro **Ship ($50/mês, 150.000 min)** quando escalar.
3. Criar um novo projeto
4. Anotar:
   - **URL do WebSocket:** `wss://seu-projeto-xxxxx.livekit.cloud`
   - **API Key:** (clicar em "API Keys")
   - **API Secret:** (clicar em "API Keys")

### 3.2 Cloudflare R2

1. Criar conta Cloudflare em https://dash.cloudflare.com
2. Ativar **R2 Object Storage** (precisa de cartão, mas free tier generoso)
3. Criar bucket `meeting-recordings`
4. **Settings** do bucket → **Public Access** → enable
5. Anotar a **URL pública** (ex: `https://pub-9ad9609ce50e4c97b930a99bac90c285.r2.dev`)
6. Criar **API Token** em **Manage R2 API Tokens**:
   - Permissão: **Object Read & Write**
   - Specify bucket: `meeting-recordings`
7. Anotar `Access Key ID`, `Secret Access Key`, `Endpoint`

### 3.3 Configurar webhook no LiveKit

1. No dashboard LiveKit → **Settings → Webhooks**
2. Adicionar webhook com URL:
   ```
   https://<seu-projeto>.supabase.co/functions/v1/livekit-webhook
   ```
3. Eventos: marcar **todos** (ou ao menos `participant_joined`, `room_finished`, `egress_started`, `egress_ended`, `egress_updated`)

### 3.4 Soniox (opcional — só se quiser transcrição em tempo real)

1. Criar conta em https://soniox.com
2. Gerar API Key
3. Anotar

---

## 4. Credenciais e secrets do Supabase

Setar via CLI ou Dashboard:

```bash
npx supabase secrets set \
  LIVEKIT_API_KEY=APIxxxx \
  LIVEKIT_API_SECRET=secretxxxx \
  LIVEKIT_URL=wss://seu-projeto.livekit.cloud \
  S3_ACCESS_KEY=R2accesskey \
  S3_SECRET_KEY=R2secret \
  S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com \
  S3_BUCKET=meeting-recordings \
  S3_REGION=auto \
  S3_PUBLIC_URL=https://pub-xxx.r2.dev \
  SONIOX_API_KEY=opcional \
  --project-ref SEU_PROJECT_REF
```

---

## 5. Schema do banco (SQL)

Execute no SQL Editor do Supabase. **Adapte os nomes de tabela ao seu CRM** (se já tiver `meetings`, `activities`, etc, pule a criação e só adicione as colunas novas).

```sql
-- Tabela principal de reuniões (adicione campos ao que você já tem)
CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  lead_id UUID REFERENCES leads(id),
  organization_id UUID REFERENCES organizations(id),
  activity_id UUID,
  meeting_type TEXT DEFAULT 'sales_call',
  status TEXT DEFAULT 'active' CHECK (status IN ('active','completed','no_show','cancelled')),
  meeting_link TEXT,
  livekit_room_name TEXT UNIQUE,
  recording_url TEXT,
  recording_status TEXT CHECK (recording_status IN ('pending','recording','completed','failed')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_by UUID,
  participants JSONB DEFAULT '[]'::jsonb,
  transcriptions JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meetings_room ON meetings(livekit_room_name);
CREATE INDEX IF NOT EXISTS idx_meetings_lead ON meetings(lead_id);
CREATE INDEX IF NOT EXISTS idx_meetings_activity ON meetings(activity_id);

-- Se já tiver a tabela, adicione só as colunas novas:
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS livekit_room_name TEXT UNIQUE;
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_url TEXT;
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_status TEXT;
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS activity_id UUID;

-- RLS
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_meetings" ON meetings
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_write_meetings" ON meetings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Se você tem company_activities (tasks), garanta o meeting_link:
-- ALTER TABLE company_activities ADD COLUMN IF NOT EXISTS meeting_link TEXT;
```

---

## 6. Edge function `livekit-token`

Gera JWT pra entrar na sala. Suporta 3 roles: **host** (pode publicar, gerenciar sala, gravar), **guest** (publica, participa), **observer** (invisível, escuta+envia DataChannel, nenhum vídeo/áudio).

**Arquivo:** `supabase/functions/livekit-token/index.ts`

```typescript
import { AccessToken } from 'https://esm.sh/livekit-server-sdk@2.7.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const API_KEY = Deno.env.get('LIVEKIT_API_KEY')!;
const API_SECRET = Deno.env.get('LIVEKIT_API_SECRET')!;
const LIVEKIT_URL = Deno.env.get('LIVEKIT_URL')!;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { roomName, participantName, role, metadata } = await req.json();

    if (!roomName || !participantName) {
      return new Response(JSON.stringify({ error: 'roomName e participantName são obrigatórios' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const identity = `${role || 'guest'}-${participantName}-${Date.now()}`;
    const at = new AccessToken(API_KEY, API_SECRET, {
      identity,
      name: participantName,
      metadata: JSON.stringify(metadata || {}),
    });

    // Permissões por role
    if (role === 'host') {
      at.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        roomAdmin: true,
        roomRecord: true,
      });
    } else if (role === 'observer') {
      at.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: false,
        canSubscribe: true,
        canPublishData: true,
        hidden: true, // invisível pros outros participantes
      });
    } else {
      // guest
      at.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
    }

    const token = await at.toJwt();

    return new Response(JSON.stringify({ token, url: LIVEKIT_URL }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
```

**Deploy:**
```bash
npx supabase functions deploy livekit-token --no-verify-jwt --project-ref SEU_REF
```

---

## 7. Edge function `livekit-webhook`

Recebe eventos do LiveKit. **Ponto crítico:** o Egress só inicia quando tem participante na sala (não na criação da sala vazia). Por isso o trigger é `participant_joined`, não `room_started`.

**Arquivo:** `supabase/functions/livekit-webhook/index.ts`

```typescript
import { createClient } from 'npm:@supabase/supabase-js@2';
import { WebhookReceiver, EgressClient, EncodedFileType, EncodedFileOutput } from 'https://esm.sh/livekit-server-sdk@2.7.0';

const API_KEY = Deno.env.get('LIVEKIT_API_KEY')!;
const API_SECRET = Deno.env.get('LIVEKIT_API_SECRET')!;
const LIVEKIT_URL = Deno.env.get('LIVEKIT_URL')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const S3_ACCESS_KEY = Deno.env.get('S3_ACCESS_KEY')!;
const S3_SECRET_KEY = Deno.env.get('S3_SECRET_KEY')!;
const S3_ENDPOINT = Deno.env.get('S3_ENDPOINT')!;
const S3_BUCKET = Deno.env.get('S3_BUCKET') || 'meeting-recordings';
const S3_PUBLIC_URL = Deno.env.get('S3_PUBLIC_URL')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const receiver = new WebhookReceiver(API_KEY, API_SECRET);
const egressClient = new EgressClient(LIVEKIT_URL.replace('wss://', 'https://'), API_KEY, API_SECRET);

Deno.serve(async (req: Request) => {
  const body = await req.text();
  const auth = req.headers.get('Authorization') || '';

  let event: any;
  try {
    event = await receiver.receive(body, auth);
  } catch (err: any) {
    return new Response('Invalid signature', { status: 401 });
  }

  const roomName = event.room?.name;
  console.log(`[webhook] event: ${event.event}, room: ${roomName}`);

  try {
    if (event.event === 'participant_joined' && roomName) {
      // Inicia Egress quando o primeiro participante entrar (não na criação da sala)
      const { data: meeting } = await supabase
        .from('meetings')
        .select('id, recording_status')
        .eq('livekit_room_name', roomName)
        .maybeSingle();

      if (meeting && meeting.recording_status !== 'recording' && meeting.recording_status !== 'completed') {
        const filename = `${roomName}-${Date.now()}.mp4`;

        const output = new EncodedFileOutput({
          fileType: EncodedFileType.MP4,
          filepath: filename,
          output: {
            case: 's3',
            value: {
              accessKey: S3_ACCESS_KEY,
              secret: S3_SECRET_KEY,
              endpoint: S3_ENDPOINT,
              bucket: S3_BUCKET,
              region: 'auto',
              forcePathStyle: true,
            },
          },
        });

        try {
          await egressClient.startRoomCompositeEgress(roomName, { file: output }, {
            layout: 'grid',
          });
          await supabase.from('meetings').update({
            recording_status: 'recording',
            started_at: new Date().toISOString(),
          }).eq('id', meeting.id);
          console.log(`[webhook] Egress iniciado: ${filename}`);
        } catch (err: any) {
          console.error(`[webhook] Egress falhou:`, err.message);
          await supabase.from('meetings').update({ recording_status: 'failed' }).eq('id', meeting.id);
        }
      }
    }

    if (event.event === 'egress_ended' && event.egressInfo) {
      const file = event.egressInfo.fileResults?.[0] || event.egressInfo.file;
      const filename = file?.filename;
      const roomNameFromEgress = event.egressInfo.roomName;

      if (filename && roomNameFromEgress) {
        const publicUrl = `${S3_PUBLIC_URL}/${filename}`;
        await supabase.from('meetings').update({
          recording_url: publicUrl,
          recording_status: 'completed',
        }).eq('livekit_room_name', roomNameFromEgress);
        console.log(`[webhook] Gravação salva: ${publicUrl}`);
      }
    }

    if (event.event === 'room_finished' && roomName) {
      await supabase.from('meetings').update({
        status: 'completed',
        ended_at: new Date().toISOString(),
      }).eq('livekit_room_name', roomName);
    }
  } catch (err: any) {
    console.error(`[webhook] Error processing event:`, err.message);
  }

  return new Response('OK', { status: 200 });
});
```

**Deploy:**
```bash
npx supabase functions deploy livekit-webhook --no-verify-jwt --project-ref SEU_REF
```

Configurar URL no dashboard LiveKit: `https://SEU_REF.supabase.co/functions/v1/livekit-webhook`

---

## 8. Edge function `livekit-end-room`

Quando o host encerra, essa função deleta a sala no servidor (kicka todo mundo + finaliza Egress). Sem isso, o lead fica sozinho na sala mesmo depois do host sair.

**Arquivo:** `supabase/functions/livekit-end-room/index.ts`

```typescript
import { RoomServiceClient } from 'https://esm.sh/livekit-server-sdk@2.7.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const API_KEY = Deno.env.get('LIVEKIT_API_KEY')!;
const API_SECRET = Deno.env.get('LIVEKIT_API_SECRET')!;
const LIVEKIT_URL = Deno.env.get('LIVEKIT_URL')!.replace('wss://', 'https://');

const rs = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { room_name } = await req.json();
    if (!room_name) return new Response(JSON.stringify({ error: 'room_name required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

    await rs.deleteRoom(room_name);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
```

Deploy idêntico às anteriores.

---

## 9. Edge function `send-meeting-email` (opcional)

Envia email de confirmação/lembrete/reagendamento com anexo `.ics` (compatível com Google/Outlook/Apple Calendar).

**Arquivo:** `supabase/functions/send-meeting-email/index.ts`

```typescript
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const FROM_EMAIL = Deno.env.get('MEETING_FROM_EMAIL') || 'noreply@seudominio.com';

function formatICSDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function buildICS(params: {
  uid: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  url: string;
  attendeeEmail: string;
  attendeeName: string;
  organizerEmail: string;
  organizerName: string;
}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SeuCRM//Meeting//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${params.uid}`,
    `DTSTAMP:${formatICSDate(new Date().toISOString())}`,
    `DTSTART:${formatICSDate(params.start)}`,
    `DTEND:${formatICSDate(params.end)}`,
    `SUMMARY:${params.summary}`,
    `DESCRIPTION:${params.description.replace(/\n/g, '\\n')}`,
    `LOCATION:${params.url}`,
    `URL:${params.url}`,
    `ORGANIZER;CN=${params.organizerName}:mailto:${params.organizerEmail}`,
    `ATTENDEE;CN=${params.attendeeName};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${params.attendeeEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const payload = await req.json();
    const {
      type, // 'scheduled' | 'reminder' | 'rescheduled' | 'no_show'
      to,
      leadName,
      meetingTitle,
      startAt,
      endAt,
      meetLink,
      hostName,
      hostEmail,
    } = payload;

    const firstName = leadName?.split(' ')[0] || '';

    let subject = '';
    let html = '';

    if (type === 'scheduled') {
      subject = `✅ Reunião confirmada — ${meetingTitle}`;
      html = `
        <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto;">
          <h2>Olá ${firstName}, reunião confirmada!</h2>
          <p>Sua reunião está agendada para <strong>${new Date(startAt).toLocaleString('pt-BR')}</strong>.</p>
          <div style="margin: 24px 0;">
            <a href="${meetLink}" style="background: #10b981; color: white; padding: 14px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
              🎥 Entrar na reunião
            </a>
          </div>
          <p style="font-size: 13px; color: #666;">
            Adicionar ao calendário:
            <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(meetingTitle)}&dates=${formatICSDate(startAt)}/${formatICSDate(endAt)}&location=${encodeURIComponent(meetLink)}">Google</a> •
            <a href="https://outlook.office.com/calendar/deeplink/compose?subject=${encodeURIComponent(meetingTitle)}&startdt=${startAt}&enddt=${endAt}&location=${encodeURIComponent(meetLink)}">Outlook</a>
          </p>
          <p style="margin-top: 32px; font-size: 12px; color: #999;">
            Se o botão não funcionar, acesse: <a href="${meetLink}">${meetLink}</a>
          </p>
        </div>
      `;
    } else if (type === 'rescheduled') {
      subject = `🔄 Reunião remarcada — ${meetingTitle}`;
      html = `<h2>${firstName}, sua reunião foi remarcada</h2><p>Nova data: <strong>${new Date(startAt).toLocaleString('pt-BR')}</strong></p><a href="${meetLink}">Entrar na nova reunião</a>`;
    } else if (type === 'no_show') {
      subject = `Sentimos sua falta, ${firstName}`;
      html = `<h2>Olá ${firstName}</h2><p>Notamos que você não conseguiu participar. Quer remarcar?</p><p><a href="${meetLink}">Agendar novo horário</a></p>`;
    } else {
      subject = `Lembrete: ${meetingTitle}`;
      html = `<h2>Lembrete de reunião</h2><p>Sua reunião começa em 15 minutos: <strong>${new Date(startAt).toLocaleString('pt-BR')}</strong></p><a href="${meetLink}">Entrar na reunião</a>`;
    }

    const ics = buildICS({
      uid: `${Date.now()}@seudominio.com`,
      summary: meetingTitle,
      description: `Link: ${meetLink}`,
      start: startAt,
      end: endAt,
      url: meetLink,
      attendeeEmail: to,
      attendeeName: leadName,
      organizerEmail: hostEmail,
      organizerName: hostName,
    });

    const icsBase64 = btoa(ics);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to,
        subject,
        html,
        attachments: [{ filename: 'invite.ics', content: icsBase64 }],
      }),
    });

    const result = await res.json();
    return new Response(JSON.stringify({ success: true, result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
```

---

## 10. Frontend — página da sala `/meet/:roomId`

Essa é a tela onde host, guest e observer entram.

**Dependências:**

```bash
npm install livekit-client @livekit/components-react @livekit/components-styles
```

**Arquivo:** `src/pages/MeetRoom.tsx`

```tsx
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  LiveKitRoom,
  VideoConference,
  PreJoin,
  useConnectionState,
  useParticipants,
  LocalUserChoices,
} from '@livekit/components-react';
import { ConnectionState, Room, RoomEvent } from 'livekit-client';
import '@livekit/components-styles';
import { supabase } from '@/lib/supabase'; // ajuste pro seu client

interface ConnectionData {
  token: string;
  url: string;
}

export default function MeetRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();

  const role = (searchParams.get('role') || 'guest') as 'host' | 'guest' | 'observer';
  const defaultName = searchParams.get('name') || '';
  const leadId = searchParams.get('lead_id') || undefined;
  const orgId = searchParams.get('org_id') || undefined;
  const returnUrl = searchParams.get('return') || '/';

  const isHost = role === 'host';
  const isObserver = role === 'observer';

  const [preJoinChoices, setPreJoinChoices] = useState<LocalUserChoices | null>(null);
  const [connectionData, setConnectionData] = useState<ConnectionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ended, setEnded] = useState(false);
  const [meetingDbId, setMeetingDbId] = useState<string | null>(null);

  // Observer pula PreJoin automaticamente (precisa vir ANTES dos returns)
  useEffect(() => {
    if (isObserver && !preJoinChoices && roomId) {
      (async () => {
        const { token, url } = await getLiveKitToken({
          roomName: roomId,
          participantName: defaultName || 'Observador',
          role: 'observer',
          metadata: { lead_id: leadId, org_id: orgId },
        });
        setPreJoinChoices({
          username: defaultName || 'Observador',
          videoEnabled: false,
          audioEnabled: false,
        } as any);
        setConnectionData({ token, url });
      })();
    }
  }, [isObserver, roomId, preJoinChoices]);

  const handlePreJoin = async (choices: LocalUserChoices) => {
    if (!roomId) return;
    setPreJoinChoices(choices);
    setLoading(true);
    setError(null);

    try {
      // Cria/atualiza meeting no banco
      const { data: existing } = await supabase
        .from('meetings')
        .select('id')
        .eq('livekit_room_name', roomId)
        .maybeSingle();

      if (existing) {
        setMeetingDbId(existing.id);
      } else {
        // Busca activity vinculada (caso meeting foi criada via task no CRM)
        const { data: act } = await supabase
          .from('company_activities')
          .select('id, lead_id, organization_id')
          .like('meeting_link', `%${roomId}%`)
          .maybeSingle();

        const { data: newMeet } = await supabase.from('meetings').insert({
          title: `Reunião ${roomId}`,
          lead_id: leadId || act?.lead_id || null,
          organization_id: orgId || act?.organization_id || null,
          activity_id: act?.id || null,
          meeting_type: 'sales_call',
          status: 'active',
          livekit_room_name: roomId,
          recording_status: 'pending',
          meeting_link: window.location.origin + '/meet/' + roomId,
        }).select('id').single();

        if (newMeet) setMeetingDbId(newMeet.id);

        // Marca task como "em andamento"
        if (act?.id) {
          await supabase.from('company_activities')
            .update({ status: 'in_progress' })
            .eq('id', act.id);
        }
      }

      const { token, url } = await getLiveKitToken({
        roomName: roomId,
        participantName: choices.username || defaultName || 'Participante',
        role,
        metadata: { lead_id: leadId, org_id: orgId },
      });

      setConnectionData({ token, url });
      setLoading(false);
    } catch (err: any) {
      setError(err.message || 'Erro ao conectar');
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!isHost) {
      setConnectionData(null);
      setEnded(true);
      return;
    }

    // Host encerra a sala pra todos
    if (roomId) {
      supabase.functions.invoke('livekit-end-room', { body: { room_name: roomId } }).catch(() => {});
    }

    setConnectionData(null);
    setEnded(true);
  };

  // ========== Renders ==========

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-900 text-white flex items-center justify-center p-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl mb-4">Erro</h1>
          <p className="text-zinc-400">{error}</p>
          <a href={returnUrl} className="mt-4 inline-block text-emerald-400">Voltar</a>
        </div>
      </div>
    );
  }

  if (ended) {
    return (
      <div className="min-h-screen bg-zinc-900 text-white flex items-center justify-center p-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl mb-4">Reunião encerrada</h1>
          <p className="text-zinc-400 mb-6">Obrigado pela participação</p>
          <a href={returnUrl} className="bg-emerald-600 text-white px-6 py-3 rounded-lg">Voltar</a>
        </div>
      </div>
    );
  }

  if (!preJoinChoices) {
    return (
      <div className="min-h-screen bg-zinc-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-zinc-800 rounded-xl p-6">
          <h1 className="text-white text-2xl mb-4 text-center">Entrando na reunião</h1>
          <PreJoin
            defaults={{ username: defaultName, videoEnabled: true, audioEnabled: true }}
            onSubmit={handlePreJoin}
            data-lk-theme="default"
            userLabel="Seu nome"
            joinLabel="Entrar na sala"
            micLabel="Microfone"
            camLabel="Câmera"
          />
        </div>
      </div>
    );
  }

  if (!connectionData) {
    return (
      <div className="min-h-screen bg-zinc-900 text-white flex items-center justify-center">
        <p>Conectando...</p>
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={connectionData.token}
      serverUrl={connectionData.url}
      video={preJoinChoices?.videoEnabled && !isObserver}
      audio={preJoinChoices?.audioEnabled && !isObserver}
      connect={true}
      onDisconnected={handleDisconnect}
      data-lk-theme="default"
      style={{ height: '100vh' }}
    >
      <VideoConference />
    </LiveKitRoom>
  );
}

async function getLiveKitToken(params: {
  roomName: string;
  participantName: string;
  role: 'host' | 'guest' | 'observer';
  metadata?: any;
}) {
  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: params,
  });
  if (error || !data?.token) throw new Error(error?.message || 'Falha ao gerar token');
  return data;
}
```

Adicione a rota no seu router:

```tsx
<Route path="/meet/:roomId" element={<MeetRoom />} />
```

---

## 11. Frontend — helpers `generateRoomName` e `getMeetUrl`

**Arquivo:** `src/lib/livekit.ts`

```typescript
export function generateRoomName(): string {
  return `meeting-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getMeetUrl(roomName: string, opts?: { role?: 'host' | 'guest' | 'observer'; leadId?: string; orgId?: string; name?: string }) {
  // SEMPRE usar URL de produção (mesmo em dev) — se não, o lead recebe localhost
  const baseUrl = 'https://seudominio.com';
  const params = new URLSearchParams();
  if (opts?.role) params.set('role', opts.role);
  if (opts?.leadId) params.set('lead_id', opts.leadId);
  if (opts?.orgId) params.set('org_id', opts.orgId);
  if (opts?.name) params.set('name', opts.name);
  const qs = params.toString();
  return `${baseUrl}/meet/${roomName}${qs ? '?' + qs : ''}`;
}
```

---

## 12. Integração com transcrição Soniox (opcional)

Pra ter transcrição dual-speaker (Vendedor/Lead) em tempo real durante a call, integre Soniox ao stream de áudio do LiveKit.

**Conceito:**
1. Pegue os `MediaStreamTrack` de áudio do **mic local** (host) + dos **participantes remotos** (lead)
2. Converta pra PCM 16kHz
3. Mande via WebSocket pro Soniox (`wss://stt-rt.soniox.com/transcribe-websocket`)
4. Soniox devolve transcrição em tempo real com speaker labels

**Arquivo:** `src/hooks/useLiveKitTranscription.ts`

```typescript
import { useEffect, useRef } from 'react';
import { useLocalParticipant, useParticipants, useTracks } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useSoniox } from './useSoniox'; // hook existente do Soniox que aceita externalStreams

export function useLiveKitTranscription(meetingId: string | null) {
  const { localParticipant } = useLocalParticipant();
  const tracks = useTracks([Track.Source.Microphone]);
  const streamsRef = useRef<MediaStream[]>([]);

  // Coleta todos os streams de áudio (local + remoto)
  useEffect(() => {
    const streams: MediaStream[] = [];
    tracks.forEach((t) => {
      if (t.publication.track?.mediaStream) {
        streams.push(t.publication.track.mediaStream);
      }
    });
    streamsRef.current = streams;
  }, [tracks]);

  // Passa pro useSoniox (que conecta WebSocket + processa PCM)
  const soniox = useSoniox({ externalStreams: streamsRef });

  // Auto-save a cada 10s
  useEffect(() => {
    if (!meetingId || !soniox.transcriptions.length) return;
    const timer = setInterval(() => {
      supabase.from('meetings').update({
        transcriptions: soniox.transcriptions,
      }).eq('id', meetingId);
    }, 10000);
    return () => clearInterval(timer);
  }, [meetingId, soniox.transcriptions]);

  return soniox;
}
```

**Dica:** use `ref` pra passar os streams pro hook do Soniox, senão tem closure stale (os streams começam vazios e chegam depois).

---

## 13. Gotchas e aprendizados

Lista dos problemas que você vai encontrar e como resolver:

### 1. Supabase Storage multipart tem limite de 6MB
**Sintoma:** uploads da gravação falham silenciosamente.
**Fix:** use Cloudflare R2.

### 2. Egress começa só com participante, não sala vazia
**Sintoma:** se você tentar iniciar Egress em `room_started`, fica em `EGRESS_STARTING` pra sempre.
**Fix:** dispare Egress em `participant_joined`.

### 3. Hooks React antes de returns condicionais
**Sintoma:** erro "Rendered fewer hooks than expected".
**Fix:** todos os `useEffect` vêm **antes** de qualquer `return` do componente.

### 4. Closure stale em transcrição
**Sintoma:** hook do Soniox recebe streams null (capturados no primeiro render).
**Fix:** passe via `ref` em vez de state direto.

### 5. MP4 do LiveKit não toca em mobile
**Sintoma:** desktop funciona, iOS/Android dá `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4).
**Causa:** moov atom no fim do arquivo (não faststart).
**Fix:** pós-processa com ffmpeg: `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`. Ou configure LiveKit Egress pra gerar faststart direto.

### 6. iOS Safari bloqueia autoplay sem gesture
**Sintoma:** vídeo mostra frame preto, não toca.
**Fix:** use `muted autoPlay playsInline` + mostra botão "Ativar som" pra user dar o gesture de unmute.

**Comportamento progressivo (DemoRoom):**
- **Mobile/Touch (iOS, Android):** autoplay com som SEMPRE bloqueado pós-refresh → começa `muted=true` e exibe overlay "Tocar com som" (gesture obrigatório).
- **Desktop:** tenta autoplay com som direto. Se o browser rejeitar (`v.play()` reject), fallback automático: muta o vídeo + exibe overlay. Quando MEI (Media Engagement Index) do domínio é alto, autoplay com som passa silencioso e o overlay nem aparece.
- Detecção: `('ontouchstart' in window) || (navigator.maxTouchPoints > 0)`.
- O checklist "Ativar som" no PreJoin foi removido — o clique em "Entrar na reunião" já é gesture suficiente pra primar o áudio da saudação IA.

### 7. CORS no R2 bloqueia WebAudio
**Sintoma:** se você tentar usar `createMediaElementSource` de áudio do R2.dev, falha silencioso.
**Fix:** configure CORS no bucket R2 (veja seção 2) OU proxy via edge function com `Access-Control-Allow-Origin: *`.

### 8. Link em localhost
**Sintoma:** lead recebe link `http://localhost:3000/meet/...` e não consegue acessar.
**Fix:** o helper `getMeetUrl` sempre retorna domínio de produção, mesmo em dev.

### 9. Observer hidden
**Sintoma:** observer deveria ser invisível mas participante aparece no grid.
**Fix:** setar `hidden: true` + `canPublish: false` nos grants do token.

### 10. DataChannel entre host e observer
**Sintoma:** mensagem do observer vai pro lead tb.
**Fix:** use `publishData` com `destinationIdentities` filtrando só identities que começam com `host-` ou `observer-`.

### 11. Deduplicação timeline do lead
**Sintoma:** aparece 2 cards pra mesma reunião (a task + a meeting).
**Fix:** se `meeting.activity_id` tá setado, pula a task no hook de timeline.

### 12. React Query cache desatualizado
**Sintoma:** UI não atualiza depois de encerrar reunião.
**Fix:** sempre `queryClient.invalidateQueries` nos branches do modal de encerramento.

### 13. Meeting com lead_id null
**Sintoma:** reunião não aparece na timeline do lead.
**Causa:** URL `/meet/XYZ` foi aberta sem `?lead_id=...`.
**Fix:** no `handlePreJoin`, busca `activity.lead_id` como fallback via `meeting_link` matching (código já tá no exemplo da seção 10).

---

## 14. Testes end-to-end

Script de teste mínimo pra validar tudo:

```bash
# 1. Setup
npx supabase secrets set LIVEKIT_API_KEY=xxx LIVEKIT_API_SECRET=yyy ...
npx supabase functions deploy livekit-token
npx supabase functions deploy livekit-webhook
npx supabase functions deploy livekit-end-room
```

**No app:**
1. Logar como usuário admin
2. Criar reunião com um lead (gerar roomName via `generateRoomName`)
3. Abrir `/meet/<roomName>?role=host&lead_id=xxx` em uma aba
4. Copiar o link, abrir `/meet/<roomName>?role=guest&name=Teste` em outra aba (ou celular) — simula o lead
5. Entrar em ambas (host + guest)
6. **Verificar:**
   - Sala conecta WebRTC
   - Em segundos, webhook `participant_joined` dispara Egress
   - `meetings.recording_status` vai pra `recording`
7. Falar um pouco (aparece transcrição real-time se Soniox ativo)
8. Host clica "Sair" → `livekit-end-room` → guest é kicked
9. Aguardar webhook `egress_ended` (1-2min pra terminar de processar)
10. `meetings.recording_url` deve ter URL pública do R2
11. Tocar o MP4 em navegador desktop e mobile — deve tocar em ambos

---

## 15. Custos mensais estimados

Pra uso típico (20-30 reuniões/dia, 30min cada):

| Item | Custo | Nota |
|---|---|---|
| **LiveKit Cloud Ship** | $50/mês | 150.000 min inclusos |
| **Cloudflare R2** | $0-5/mês | Free tier cobre até 10GB storage + zero egress |
| **Supabase Pro** | $25/mês (já tem) | Edge functions, DB |
| **Soniox** | ~$0.10/min | Só se usar transcrição |
| **Resend** (email) | $20/mês | 50k emails |
| **Total extra típico** | **$50-75/mês** | Sem Soniox |

---

## 16. Checklist final

Antes de colocar em produção, confira:

- [ ] Conta LiveKit Cloud criada + project ativo
- [ ] API Key e Secret salvos nos secrets do Supabase
- [ ] Bucket R2 criado e marcado como público
- [ ] Credenciais R2 salvas nos secrets do Supabase
- [ ] Edge functions `livekit-token`, `livekit-webhook`, `livekit-end-room` deployadas (`--no-verify-jwt`)
- [ ] Webhook URL configurada no dashboard LiveKit apontando pra `livekit-webhook`
- [ ] Eventos do webhook marcados: `participant_joined`, `room_finished`, `egress_ended`
- [ ] Tabela `meetings` criada com todas as colunas LiveKit
- [ ] Rota `/meet/:roomId` registrada no router do frontend
- [ ] Teste local de ponta a ponta funcionando (host + guest em abas diferentes)
- [ ] Teste mobile passando (iOS + Android)
- [ ] CSP/Permissions-Policy do seu host liberam `camera`, `microphone`, `display-capture`
- [ ] CORS do R2 configurado se for usar WebAudio
- [ ] Link usando domínio de produção (nunca localhost em prod)
- [ ] Teste com lead real — ele consegue entrar via link só com o nome

---

## Próximos passos (extensões)

Depois que o LiveKit tá rodando, dá pra adicionar:

- **Análise IA pós-call** — edge function que chama Gemini/OpenAI com a transcrição e gera resumo, pontos fortes/fracos, tarefas sugeridas
- **Painel de contexto do lead** ao lado da call (timeline, deals, notas)
- **Chat privado entre host e observer** via DataChannel (`topic: 'coach-chat'` com filtro de destination identities)
- **Badge "AO VIVO" em tarefas** — polling na tabela `meetings` filtrando por `livekit_room_name`
- **Banner de recovery** — detecta se o usuário deixou uma call rolando e volta pra ela
- **Emails de reagendamento/no-show** via `send-meeting-email`

---

## 17. Melhorias Avançadas (Jun-Jul 2026)

Depois de rodar em produção por meses com centenas de calls e mentorias com 30+ alunos simultâneos, evoluímos o setup base pra resolver bugs sutis e adicionar features Zoom-style. Todas as melhorias abaixo foram testadas com carga real. **Todas plug-and-play — dá pra adicionar uma por uma sem quebrar nada.**

### 17.1 Transcrição resiliente via DataChannel (fix bug LiveKit #3477)

**Problema real:** em 21/05/2026 o LiveKit Cloud reciclou réplicas com versão nova do agent e o evento nativo `TranscriptionReceived` começou a retornar `participant_identity` errado (vinha o identity do AGENT em vez do participante que falou). Todas as transcrições começaram a mostrar "Você" pra todo mundo.

**Fix definitivo:** o agent publica via `publish_data` com identity explícita no payload; o frontend escuta ambos os canais (DataChannel + evento nativo) e deduplica.

**Agent Python (`livekit-agent/main.py`):**

```python
DATA_TOPIC = "cs-transcription"

async def _publish_segment(ctx, participant_identity, track_sid, segment_id, text, is_final):
    payload = {
        "type": "transcription",
        "participant_identity": participant_identity,
        "track_sid": track_sid,
        "segment_id": segment_id,
        "text": text,
        "is_final": is_final,
    }
    data_bytes = json.dumps(payload).encode("utf-8")

    # Caminho PRINCIPAL: DataChannel reliable com topic
    for attempt in range(3):
        try:
            await ctx.room.local_participant.publish_data(
                data_bytes, reliable=True, topic=DATA_TOPIC,
            )
            break
        except Exception as e:
            if attempt == 2:
                logger.error(f"publish_data falhou 3x ({participant_identity}): {e}")
            else:
                await asyncio.sleep(0.3 * (attempt + 1))

    # Caminho SECUNDÁRIO (best-effort): transcrição nativa, ignora bug #3477
    try:
        segment = rtc.TranscriptionSegment(
            id=segment_id, text=text, start_time=0, end_time=0,
            language="pt-BR", final=is_final,
        )
        transcription = rtc.Transcription(
            participant_identity=participant_identity, track_sid=track_sid, segments=[segment],
        )
        await ctx.room.local_participant.publish_transcription(transcription)
    except Exception:
        pass  # DataChannel é a fonte da verdade
```

**Frontend hook (`useLiveKitTranscriptionV2.ts`):**

```ts
const DATA_TOPIC = 'cs-transcription';

// Parseia nome legível do identity: host-Frank Costa-1783... → "Frank Costa"
function parseSpeakerName(identity: string): string {
  const m = identity.match(/^(?:host|guest)-(.+)-\d+$/);
  return m?.[1]?.trim() || identity;
}

// Dentro do useEffect que escuta o room:
const localIdentity = room.localParticipant.identity;
const seenSegments = new Set<string>();

const appendOrUpdate = (speakerIdentity, segmentId, text, isFinal) => {
  const dedupKey = `${segmentId}:${isFinal ? 'F' : 'I'}`;
  if (seenSegments.has(dedupKey)) return;
  if (isFinal) seenSegments.add(dedupKey);

  const speaker = speakerIdentity === localIdentity
    ? 'Você'
    : parseSpeakerName(speakerIdentity);

  setTranscriptions((prev) => {
    const existing = prev.findIndex((t) => t.segment_id === segmentId);
    const entry = { speaker, text, is_final: isFinal, timestamp: Date.now(), segment_id: segmentId };
    if (existing >= 0) { const next = [...prev]; next[existing] = entry; return next; }
    return [...prev, entry];
  });
};

// PRINCIPAL: DataChannel cs-transcription
const handleData = (payload, _p, _k, topic) => {
  if (topic !== DATA_TOPIC) return;
  const msg = JSON.parse(new TextDecoder().decode(payload));
  if (msg.type !== 'transcription' || !msg.text?.trim()) return;
  appendOrUpdate(msg.participant_identity, msg.segment_id, msg.text, msg.is_final);
};

// FALLBACK: TranscriptionReceived nativo (pode vir com identity errada — bug #3477)
const handleTranscription = (segments, participant) => {
  for (const seg of segments) {
    if (seg.text?.trim()) appendOrUpdate(participant?.identity || localIdentity, seg.id, seg.text, seg.final);
  }
};

room.on(RoomEvent.DataReceived, handleData);
room.on(RoomEvent.TranscriptionReceived, handleTranscription);
```

**`livekit-agent/requirements.txt` — PINE SEMPRE:**

```
livekit-agents==1.5.8
livekit-plugins-deepgram==1.5.8
livekit-plugins-silero==1.5.8
python-dotenv==1.0.1
```

**NUNCA use `>=1.2.0`** — o LiveKit Cloud reciclou réplicas 3 vezes em 2 meses e cada vez puxou versão nova que reintroduziu o bug. Pinar `==` é o único jeito de proteger. Rodar `lk agent deploy` só quando você mudar a versão intencionalmente.

### 17.2 Recovery de gravação via AssemblyAI

**Problema:** o egress do LiveKit Cloud tem limite de duração (~4h por sessão). Em mentorias longas, o egress corta no meio (`EGRESS_LIMIT_REACHED`) e gera 2+ arquivos MP4 separados no R2. Também, se algo der errado com o push do egress ou a sala for reutilizada, o `metadata.recording_segments` fica com refs órfãs.

**Fluxo de recovery:**

1. Detecta problema: `recording_status = 'push_failed'` ou vídeo não abre no player
2. Lista egresses da sala: `lk egress list --room <name>`
3. Identifica os `EGRESS_COMPLETE` e `EGRESS_LIMIT_REACHED` do dia da call
4. Baixa arquivos do R2, concatena via ffmpeg (`-c copy` sem re-encode)
5. Sobe unificado + atualiza `recording_url` no banco

**Se não tem os arquivos originais:** submete o áudio pro AssemblyAI (batch API) e reconstrói a transcrição.

```bash
# Recovery de transcrição via AssemblyAI batch
TID=$(curl -s -X POST "https://api.assemblyai.com/v2/transcript" \
  -H "authorization: $ASSEMBLY_KEY" \
  -H "content-type: application/json" \
  -d '{"audio_url":"<R2_URL>","speaker_labels":true,"language_code":"pt"}' \
  | jq -r '.id')

# Depois: poll até status=completed
curl -s -H "authorization: $ASSEMBLY_KEY" \
  "https://api.assemblyai.com/v2/transcript/$TID"
```

**Edge function `recover-meeting-transcription` (opcional):** recebe `meeting_id` + `transcript_id`, converte utterances do AssemblyAI pro formato `{ speaker, text, is_final, timestamp }` e faz UPDATE em `meetings.transcriptions`.

### 17.3 Auto-restart de egress em salas longas

**Problema:** LiveKit egress cai em ~4h por design (`EGRESS_LIMIT_REACHED`). Mentoria de 4h+ vai perder o resto.

**Fix no webhook:** o handler `egress_ended` detecta `error = 'Session limit reached'` e reinicia um novo egress imediatamente se a sala ainda tem participantes.

```ts
// supabase/functions/livekit-webhook/index.ts
if (event === 'egress_ended') {
  const err = payload.egressInfo?.error;
  if (err?.includes('Session limit reached') || err?.includes('Egress limit')) {
    // Sala ainda tem gente?
    const participants = await roomService.listParticipants({ room: roomName });
    if (participants.length > 0) {
      const filename = `${roomName}-${Date.now()}.mp4`;
      await egressClient.startRoomCompositeEgress(roomName, {
        fileType: EncodedFileType.MP4,
        filepath: filename,
        s3: { /* R2 creds */ },
      });
      // Adiciona filename ao metadata.recording_segments do meeting
      await appendSegment(meetingId, filename);
    }
  }
}
```

**Modal worker `recording-concat/main.py` (opcional):** roda no room_finished, baixa todos os segments do R2, faz `ffmpeg concat -c copy` (sem re-encode, rápido) e sobe o unificado.

### 17.4 Áudio da tela junto com o vídeo

**Problema:** o `VideoConference` default do LiveKit chama `setScreenShareEnabled(true)` sem opções. Chrome exige `{ audio: true, systemAudio: 'include' }` pra mostrar o checkbox "Compartilhar áudio da guia" — sem essa opção, música/voz da tela nunca vai.

**Fix via monkey-patch (mais limpo do que reimplementar toolbar):**

```tsx
// src/components/meeting/CallScreenShareEnhancer.tsx
useEffect(() => {
  if (!localParticipant) return;
  const lp: any = localParticipant;
  const original = lp.setScreenShareEnabled?.bind(lp);
  if (typeof original !== 'function') return;

  lp.setScreenShareEnabled = async (enabled, captureOptions, publishOptions) => {
    if (enabled) {
      const opts = { audio: true, systemAudio: 'include', ...(captureOptions || {}) };
      return original(true, opts, publishOptions);
    }
    return original(enabled, captureOptions, publishOptions);
  };

  return () => { lp.setScreenShareEnabled = original; };
}, [localParticipant]);
```

**Só funciona no Chrome/Edge** compartilhando uma **aba** ou **janela específica**. Firefox/Safari não suportam áudio de tela (limitação do navegador).

### 17.5 Overlay Zoom-style: câmeras flutuando durante share

**Problema:** quando alguém compartilha tela, a tela grande esconde as câmeras dos outros. Você não vê reações da audiência.

**Fix:** overlay flutuante no canto superior direito com até 5 thumbnails. Quem tá falando vai pro topo com borda laranja.

```tsx
function ScreenShareCameraOverlay({ cameras }) {
  const MAX = 5;
  const sorted = [...cameras].sort((a, b) => (b.participant.isSpeaking ? 1 : 0) - (a.participant.isSpeaking ? 1 : 0));
  const visible = sorted.slice(0, MAX);
  const overflow = cameras.length - visible.length;

  return (
    <div className="absolute top-4 right-4 z-30 flex flex-col gap-2 max-h-[calc(100%-2rem)] pointer-events-none">
      {visible.map((t) => (
        <div
          key={t.participant.identity}
          className={cn(
            'relative w-40 aspect-video rounded-xl overflow-hidden border-2 shadow-2xl',
            t.participant.isSpeaking ? 'border-orange-500 shadow-orange-500/50' : 'border-black/40',
          )}
        >
          <ParticipantTile trackRef={t} disableSpeakingIndicator className="!border-0 !rounded-xl" />
        </div>
      ))}
      {overflow > 0 && (
        <div className="w-40 aspect-video rounded-xl bg-zinc-900/95 flex items-center justify-center">
          <span className="text-white font-bold">+{overflow}</span>
        </div>
      )}
    </div>
  );
}

// Uso: renderiza junto do <VideoConference>
{isScreenSharing && remoteCameras.length > 0 && (
  <ScreenShareCameraOverlay cameras={remoteCameras} />
)}
```

### 17.6 Document Picture-in-Picture (Chrome/Edge)

**Feature killer:** quando VOCÊ compartilha tela, abre uma **janela do sistema operacional** flutuando por cima de qualquer app (PowerPoint, Loom, PDF, IDE). Nela, câmeras dos participantes ao vivo. Você vê reações enquanto apresenta em outro app.

Usa a **Document Picture-in-Picture API** do Chrome 116+ (não confundir com Video PiP que só mostra 1 vídeo). Firefox/Safari não implementam — degrada silenciosamente.

```tsx
const [pipWindow, setPipWindow] = useState<Window | null>(null);
const localIsSharing = localParticipant?.isScreenShareEnabled;

useEffect(() => {
  const supportsPip = 'documentPictureInPicture' in window;
  if (!localIsSharing || !supportsPip) {
    if (pipWindow) { pipWindow.close(); setPipWindow(null); }
    return;
  }
  if (pipWindow) return;

  (async () => {
    const pip = await (window as any).documentPictureInPicture.requestWindow({
      width: 340, height: 480,
    });

    // Copia stylesheets pra dentro (Tailwind etc.)
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const rules = Array.from((sheet as any).cssRules).map((r: any) => r.cssText).join('\n');
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

    pip.document.body.style.margin = '0';
    pip.document.body.style.background = '#09090b';
    pip.addEventListener('pagehide', () => setPipWindow(null));
    setPipWindow(pip);
  })();
}, [localIsSharing]);

// No render:
{pipWindow && createPortal(
  <PipCameraGrid cameraTracks={remoteCameras} />,
  pipWindow.document.body,
)}
```

`<PipCameraGrid>` é um componente simples com grid CSS que renderiza `<ParticipantTile>` dos remotos. Como as tracks já estão attachadas no room, os `<video>` continuam renderizando mesmo em outro Document.

### 17.7 Componente plug-and-play

Os fixes 17.4, 17.5 e 17.6 são independentes mas juntos formam um "modo apresentação premium". Encapsulei tudo num componente único:

```tsx
// src/components/meeting/CallScreenShareEnhancer.tsx
export function CallScreenShareEnhancer() {
  // 1. Monkey-patch de setScreenShareEnabled
  // 2. Overlay Zoom-style
  // 3. Document PiP
  // (código completo nos snippets acima)
}
```

**Uso no MeetRoom (3 papéis: host, guest, observer):**

```tsx
<VideoConference chatMessageFormatter={formatChatMessageLinks} />
<CallScreenShareEnhancer />
```

Zero acoplamento com o resto do MeetRoom. Se você usa `<LiveKitRoom>` custom em vez de `<VideoConference>`, funciona igual.

### 17.8 Auto-open picker após aprovação de share (fluxo Aluno → Host)

**Contexto:** em mentorias com muitos alunos, você (host) precisa aprovar quando um aluno quer compartilhar tela. Fluxo antigo tinha 2 cliques do aluno: pediu → esperou → clicou de novo.

**Fix:** após o host aprovar via `share_approved` no DataChannel, o aluno recebe e **automaticamente** abre o picker do browser (sem clique adicional).

```tsx
const handler = async (payload: Uint8Array) => {
  const msg = JSON.parse(new TextDecoder().decode(payload));
  if (msg.type === 'share_approved') {
    setShareStatus('approved');
    try {
      await localParticipant.setScreenShareEnabled(true, {
        audio: true, systemAudio: 'include',
      } as any);
      setShareOn(true);
      setShareStatus('idle');
    } catch (err) {
      // Safari/Firefox mais restritos exigem gesture — cai aqui e usuário clica 1x
      console.warn('[share] auto-open picker falhou (browser exige gesture):', err);
    }
  } else if (msg.type === 'share_denied') {
    setShareStatus('denied');
    setTimeout(() => setShareStatus('idle'), 3000);
  }
};
room.on(RoomEvent.DataReceived, handler);
```

### 17.9 Botão "levantar mão" na toolbar (não em cima do rosto)

**Problema no MentoringRoom:** o botão de levantar mão flutuava em `bottom-24 left-1/2 -translate-x-1/2` — bem em cima do rosto do usuário no vídeo.

**Fix:** mover pra `bottom-4 right-4` (mesma altura da toolbar do LiveKit, no canto direito). No mobile, texto some e fica só o ícone:

```tsx
<button
  onClick={toggleHand}
  className={cn(
    'absolute bottom-4 right-4 z-50 h-11 px-4 rounded-full flex items-center gap-2',
    'shadow-lg backdrop-blur transition-all',
    myHand
      ? 'bg-amber-500 text-zinc-900'
      : 'bg-zinc-800/90 text-white border border-zinc-700',
  )}
>
  <Hand className={cn('h-4 w-4', myHand && 'animate-pulse')} />
  <span className="hidden md:inline">{myHand ? 'Baixar a mão' : 'Levantar a mão'}</span>
</button>
```

Painel de "quem levantou a mão" vai pro canto superior direito (`top-16 right-4`) — longe do fluxo do vídeo.

### 17.10 Modo Galeria (Zoom-style grid)

**Problema no modo Palco default:** host grande + 1 aluno secundário. Em oficinas com 20 alunos, você não vê ninguém.

**Fix:** toggle Palco/Galeria no canto superior esquerdo. Modo Galeria renderiza grid adaptativo com TODAS as câmeras iguais:

```tsx
// Grid adaptativo baseado em nº de câmeras
const cols = N <= 1 ? 1 : N <= 2 ? 2 : N <= 4 ? 2 : N <= 6 ? 3 : N <= 9 ? 3 : N <= 12 ? 4 : N <= 16 ? 4 : 5;

const [viewMode, setViewMode] = useState<'palco' | 'galeria'>(
  () => (localStorage.getItem('mentoring-view-mode') as any) || 'palco'
);
useEffect(() => {
  localStorage.setItem('mentoring-view-mode', viewMode);
}, [viewMode]);

// Screen share sempre tem prioridade — em share ativo, ignora modo galeria
const galleryMode = viewMode === 'galeria' && !isScreenSharing;

if (galleryMode) {
  return <GalleryGrid cameraTracks={cameraTracks} />;
}
// senão renderiza modo Palco tradicional
```

### 17.11 Speaker diarization robusto

**Problema:** sistema binário "Você"/"Lead" fica ruim quando tem 3+ pessoas na mesma call (CS + Frank + cliente).

**Fix:** extrair nome real do identity via regex:

```ts
// Identity format: host-Nome Completo-1783166638459
function parseSpeakerName(identity: string): string {
  if (!identity) return 'Participante';
  const m = identity.match(/^(?:host|guest)-(.+)-\d+$/);
  return m?.[1]?.trim() || identity;
}

const speaker = speakerIdentity === localIdentity
  ? 'Você'
  : parseSpeakerName(speakerIdentity);
```

Resultado na transcrição:
- **"Você"** quando é o próprio user local
- **"Simone Chaves"** quando é outro host
- **"Adel Nayef"** quando é o guest

Isso melhora análise IA pós-call — a LLM entende quem falou.

### 17.12 Chat / eventos / handoffs — persistir

**Regra descoberta na prática:** tudo que passa pelo DataChannel é EFÊMERO. Se você quiser recuperar depois (analytics, análise IA, timeline do cliente), precisa persistir no banco.

- **Chat da sala:** não persiste — se você quiser, cria tabela `meeting_chat_messages(meeting_id, from_email, text, media_url, sent_at)` e faz INSERT no DataReceived handler
- **Levantou mão:** tabela `meeting_hand_raises` com timestamps
- **Handoffs CS → Mentor:** tabela normal (`company_activities` com `task_type='mentoring_handoff'`)
- **Presença:** tabela `meeting_participants` com `entered_at`, `left_at`

**No lado do cliente (timeline do lead):** hook `useClientTimeline.ts` puxa esses eventos e mostra 🎓 Compareceu, 🙋 Levantou mão, 🎤 Subiu ao palco, ❓ Fez pergunta.

### 17.13 Regras invioláveis (aprendidas na dor)

1. **NUNCA `>=` em requirements do agent Python** — SEMPRE `==` versão específica. Cada reciclagem de réplica do LiveKit Cloud puxou versão nova e reintroduziu bugs
2. **Room name único por sessão** — não reutilize `room_name` entre reuniões diferentes. Se reutilizar, o `metadata.recording_segments` acumula refs órfãs de outras datas
3. **`recording_url` do banco tem que ser reprocessado após concat** — o valor default aponta pro 1º segment; depois de concatenar, aponta pro unificado
4. **Chat via DataChannel é EFÊMERO** — se importa, persiste
5. **Screen share sempre tem prioridade sobre view mode** — modo Palco/Galeria/etc só se aplica quando `!isScreenSharing`
6. **Áudio da tela só funciona no Chrome/Edge** — Safari/Firefox nunca vão suportar; documente isso pros usuários
7. **Document PiP só Chrome/Edge** — mesma coisa

---

## 18. Sistema de Mentoria em Grupo

Enquanto a call de vendas (seções 1-16) é uma sala 1:1 ou 1:poucos (`/meet/:roomId`) com foco em análise BANT / ata / dossiê do lead, a **Mentoria em Grupo** (`/mentoria/:sessionId` ou público `/m/:share_token`) é uma sala de **1 host para 30+ alunos** com dinâmicas diferentes:

- **Link público** que qualquer aluno abre sem login
- **Fila de mão levantada** com dossiê + histórico
- **Chat com anexos** (imagens, arquivos)
- **Handoff CS → Mentor** ("CS pediu pra apresentar cliente X")
- **Palco** (host + 1 aluno em split view)
- **Modo Galeria** pra ver todos ao mesmo tempo
- **Análise IA pós-mentoria** com tópicos, engajamento e sync com sistema externo (LMS/PAIN)

Tudo abaixo é **incremental** ao que já foi implementado nas seções 1-17. Reusa o mesmo `livekit-webhook`, `livekit-token`, R2, Deepgram etc.

### 18.1 Tabelas adicionais no banco

```sql
-- Sessão de mentoria (agenda + gravação + análise)
CREATE TABLE mentoring_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  livekit_room_name TEXT UNIQUE NOT NULL,
  share_token TEXT UNIQUE,  -- pra link público /m/:token
  status TEXT DEFAULT 'scheduled',  -- scheduled | live | completed
  recording_url TEXT,
  recording_status TEXT DEFAULT 'pending',
  transcriptions JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,  -- análise IA + recording_segments[]
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Participação por aluno (presença + engajamento)
CREATE TABLE mentoring_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES mentoring_sessions(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id),  -- ou seu equivalente
  member_email TEXT NOT NULL,
  member_name TEXT,
  member_phone TEXT,
  member_external_id TEXT,
  entered_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  hand_raised_at TIMESTAMPTZ,
  called_at TIMESTAMPTZ,  -- quando foi convidado ao palco
  questions_count INT DEFAULT 0,
  engagement_score INT,
  via_public_link BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Histórico de mãos levantadas (auditoria + fila)
CREATE TABLE mentoring_hand_raises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES mentoring_sessions(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES mentoring_participants(id) ON DELETE CASCADE,
  lead_id UUID,
  member_email TEXT,
  member_name TEXT,
  raised_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT  -- answered | skipped | lowered
);

-- Perguntas escritas (podem ser pre_call = antes da mentoria começar)
CREATE TABLE mentoring_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES mentoring_sessions(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES mentoring_participants(id),
  lead_id UUID,
  member_email TEXT,
  member_name TEXT,
  question TEXT NOT NULL,
  source TEXT DEFAULT 'during_call',  -- during_call | pre_call
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  skipped_at TIMESTAMPTZ,
  priority INT DEFAULT 0,
  status TEXT DEFAULT 'pending',  -- pending | answered | skipped
  metadata JSONB
);

CREATE INDEX ON mentoring_participants(session_id, lead_id);
CREATE INDEX ON mentoring_hand_raises(session_id, raised_at);
CREATE INDEX ON mentoring_questions(session_id, status);

-- Bucket de Storage pra anexos do chat (imagens/arquivos)
-- Criar no dashboard Supabase: bucket "mentoring-chat-media" (público read)
```

### 18.2 Link público sem login (`/m/:share_token`)

Aluno abre um link tipo `https://seusite.com/m/abc123xyz` — sem login. Página coleta nome + email + telefone, cria `mentoring_participant` e gera token LiveKit.

```tsx
// src/pages/MentoringPublicJoin.tsx
export default function MentoringPublicJoin() {
  const { token: shareToken } = useParams();
  const [session, setSession] = useState(null);
  const [formData, setFormData] = useState({ name: '', email: '', phone: '' });

  useEffect(() => {
    (async () => {
      // Busca info da sessão via share_token (edge function pública)
      const { data } = await supabase.functions.invoke('mentoring-public', {
        body: { action: 'info', share_token: shareToken },
      });
      setSession(data);
    })();
  }, [shareToken]);

  const handleJoin = async () => {
    const { data } = await supabase.functions.invoke('mentoring-public', {
      body: {
        action: 'join',
        share_token: shareToken,
        member_name: formData.name,
        member_email: formData.email,
        member_phone: formData.phone,
      },
    });
    // data.token = livekit token; data.session_id = uuid
    navigate(`/mentoria/${data.session_id}?guest_token=${data.token}`);
  };
  // ... render form
}
```

**Edge function `mentoring-public` (verify_jwt: false):**

```ts
// action=info: retorna { title, scheduled_at, status } por share_token
// action=join: cria mentoring_participant + gera token LiveKit
if (action === 'join') {
  const { data: session } = await supabase
    .from('mentoring_sessions')
    .select('id, livekit_room_name')
    .eq('share_token', share_token)
    .single();
  if (!session) throw new Error('Sessão não encontrada');

  // Cria/reusa participant
  const { data: existing } = await supabase
    .from('mentoring_participants')
    .select('id, lead_id')
    .eq('session_id', session.id)
    .eq('member_email', member_email.toLowerCase())
    .maybeSingle();

  const participantId = existing?.id || (await supabase
    .from('mentoring_participants')
    .insert({
      session_id: session.id,
      member_email: member_email.toLowerCase(),
      member_name, member_phone,
      via_public_link: true,
    })
    .select('id').single()).data.id;

  // Gera token LiveKit como GUEST
  const at = new AccessToken(LIVEKIT_KEY, LIVEKIT_SECRET, {
    identity: `guest-${member_name}-${Date.now()}`,
    name: member_name,
    metadata: JSON.stringify({ email: member_email, participant_id: participantId }),
  });
  at.addGrant({
    roomJoin: true, room: session.livekit_room_name,
    canPublish: true, canSubscribe: true, canPublishData: true,
  });

  return { token: await at.toJwt(), session_id: session.id };
}
```

### 18.3 Fila de mão levantada com dossiê

**No painel do mentor:** aba "Fila" mostra quem levantou a mão em ordem cronológica. Cada card tem foto, nome, health score (se cliente), tempo desde levantou, e botões "Dar palavra" / "Baixar mão".

```tsx
// Aluno levanta a mão via edge function (não DataChannel — pra persistir)
const raiseHand = async () => {
  await supabase.functions.invoke('mentoring-actions', {
    body: { action: 'raise_hand', session_id, participant_id },
  });
};

// Edge function insere em mentoring_hand_raises + atualiza participant.hand_raised_at
```

**Query pra fila (frontend faz polling a cada 5s):**

```tsx
const { data: participants } = await supabase
  .from('mentoring_participants')
  .select('id, lead_id, member_email, member_name, hand_raised_at, questions_count')
  .eq('session_id', sessionId)
  .is('left_at', null);

const handRaised = participants
  .filter((p) => !!p.hand_raised_at)
  .sort((a, b) => new Date(a.hand_raised_at) - new Date(b.hand_raised_at));
```

**"Dar palavra"** = envia `take_stage` via DataChannel PRA ESSE ALUNO ESPECÍFICO:

```tsx
const sendStageEvent = async (email, type: 'take_stage' | 'leave_stage') => {
  const identities = Array.from(room.remoteParticipants.values())
    .filter((p) => JSON.parse(p.metadata || '{}').email === email)
    .map((p) => p.identity);
  const data = new TextEncoder().encode(JSON.stringify({ type }));
  await room.localParticipant.publishData(data, {
    reliable: true, destinationIdentities: identities,
  });
};
```

**Aluno recebe `take_stage`** → modal aparece ("Você foi convidado ao palco. Aceitar?"). Se ele aceitar, publica câmera + confirma via `take_stage_confirmed`. Isso é essencial pra o **user gesture** que o browser exige pra publicar câmera.

### 18.4 Perguntas escritas (pre_call + during_call)

Alunos que não podem falar (mudos, no celular) mandam pergunta escrita. Aparece no painel do mentor com status pending/answered/skipped.

```tsx
// Aluno envia pergunta
await supabase.functions.invoke('mentoring-actions', {
  body: {
    action: 'submit_question',
    session_id, participant_id,
    question: text,
    source: sessionStarted ? 'during_call' : 'pre_call',
  },
});

// Mentor no painel:
const { data: questions } = await supabase
  .from('mentoring_questions')
  .select('*')
  .eq('session_id', sessionId)
  .eq('status', 'pending')
  .order('submitted_at');

// Marcar respondida
await supabase.functions.invoke('mentoring-actions', {
  body: { action: 'answer_question', question_id: q.id },
});

// Mostrar a pergunta pra todo mundo (não responde só, mostra pra galera ler)
const payload = new TextEncoder().encode(JSON.stringify({
  type: 'question_show', text: q.question, author: q.member_name,
}));
room.localParticipant.publishData(payload, { reliable: true });
```

### 18.5 Handoff CS → Mentor

**Caso de uso:** o CS tá acompanhando um cliente e quer que o mentor apresente pra galera na próxima mentoria. Ele cria uma "tarefa de handoff" pra sessão específica.

```sql
-- Reusa a tabela genérica de tarefas
INSERT INTO company_activities (
  task_type, mentoring_session_id, lead_id, organization_id, description
) VALUES (
  'mentoring_handoff', 'session-uuid', 'lead-uuid', NULL,
  'Demanda: Ajuste fino do agente. Cliente pediu ajuda com carrossel.'
);
```

**No painel do mentor**, aba "Alunos" mostra badge "CS" nos cards de quem tem handoff pendente + a nota do CS. Quando o mentor sobe esse aluno ao palco, a tarefa é marcada como completed + `lead_id` fica gravado (auditoria).

**Agrupamento por org:** se o handoff foi criado com `lead_id=NULL` (CS não sabia quem da empresa X vai entrar), o painel agrupa todos os alunos daquela org sob um cabeçalho comum:

```
⭐ CS PEDIU PRA APRESENTAR · VISPE
   "Demanda: Ajuste fino do agente"

   [FF] Fabiana Ferreira
   [PC] Pablo Constantino
   [CA] Carlos
```

Quando você chama UM (Carlos) ao palco → task marcada `completed` com `lead_id=Carlos.lead_id` → grupo inteiro some do painel.

### 18.6 Chat com anexos (imagens + arquivos)

Chat via DataChannel envia texto + URL de mídia. Aluno seleciona arquivo → upload no Storage bucket `mentoring-chat-media` → envia msg com `media_url`.

```tsx
const sendChat = async (text: string, media?: File) => {
  let mediaMeta = null;
  if (media) {
    const path = `${sessionId}/${Date.now()}-${media.name}`;
    await supabase.storage.from('mentoring-chat-media').upload(path, media);
    const { data: pub } = supabase.storage.from('mentoring-chat-media').getPublicUrl(path);
    mediaMeta = {
      media_url: pub.publicUrl,
      media_type: media.type.startsWith('image/') ? 'image' : 'file',
      media_filename: media.name,
      media_size: media.size,
    };
  }

  const payload = new TextEncoder().encode(JSON.stringify({
    type: 'chat', text: text.trim(), ...mediaMeta,
  }));
  await room.localParticipant.publishData(payload, { reliable: true });
};
```

**⚠️ Chat via DataChannel é EFÊMERO** (ver 17.12). Se você quer histórico depois da mentoria (busca, análise IA), **crie tabela `mentoring_chat_messages` e INSERT no handler `DataReceived`**. A gente aprendeu na dor: um aluno mandou o nome de um browser no chat, ninguém salvou, e depois quisemos buscar. Perdemos.

### 18.7 Aprovação de share (aluno pede, host aprova)

Numa call de vendas normal, qualquer participante compartilha tela livremente. Na mentoria com 30+ alunos, o host precisa aprovar:

```tsx
// ALUNO clica em "compartilhar tela"
if (!isMentor && shareStatus !== 'approved') {
  // Envia pedido pro host
  const payload = new TextEncoder().encode(JSON.stringify({ type: 'share_request' }));
  await room.localParticipant.publishData(payload, { reliable: true });
  setShareStatus('awaiting');
  return;
}

// HOST recebe share_request → modal "Aluno X quer compartilhar tela — aprovar?"
// Se aprova, envia share_approved direcionado
const approveShare = async (identity: string, approve: boolean) => {
  const payload = new TextEncoder().encode(JSON.stringify({
    type: approve ? 'share_approved' : 'share_denied',
  }));
  await room.localParticipant.publishData(payload, {
    reliable: true, destinationIdentities: [identity],
  });
};

// ALUNO recebe share_approved → picker abre automaticamente (fix 17.8)
```

### 18.8 Modo Palco vs Galeria

**Palco (default):** você (host) grande no meio + 1 aluno no palco secundário + strip horizontal embaixo com miniaturas da audiência.

**Galeria:** todas as câmeras iguais em grid adaptativo. Ideal pra oficina prática onde você quer ver todo mundo.

Toggle no canto superior esquerdo do vídeo (só aparece quando não tá compartilhando tela — durante share, sempre palco pra dar prioridade à tela).

Código completo do grid adaptativo em 17.10.

### 18.9 Análise IA pós-mentoria + sync externo

Depois da mentoria terminar, uma edge function `analyze-mentoring-session` roda:

1. Busca `mentoring_sessions.transcriptions` completas
2. Manda pro Gemini/Claude com prompt estruturado
3. Recebe: summary, topics[], key_insights[], questions_summary[], student_engagement (baixo/medio/alto), next_mentoring_ideas[], highlights[] (com timestamp aprox)
4. Salva em `mentoring_sessions.metadata.analysis`
5. **Sync com sistema externo** (LMS/PAIN) via proxy webhook: manda `recording_url`, `transcriptions`, `metadata` pra outro sistema onde os alunos veem depois

```ts
// supabase/functions/analyze-mentoring-session/index.ts
const prompt = `
Você é um especialista em mentoria de negócios.
Analise a transcrição da sessão "${session.title}" e retorne JSON com:
- summary: parágrafo curto do que rolou
- topics: array de {title, description}
- key_insights: array de strings (insights principais)
- questions_summary: array de {question, author, answered, notes}
- student_engagement: "baixo" | "medio" | "alto"
- next_mentoring_ideas: array de sugestões pra próxima
- highlights: array de {timestamp_approx, quote, why}

Transcrição:
${transcript.map(t => `[${t.speaker}] ${t.text}`).join('\n')}
`;

const analysis = await callLLM(prompt);

await supabase.from('mentoring_sessions')
  .update({ metadata: { ...session.metadata, analysis } })
  .eq('id', session_id);

// Sync com sistema externo (opcional)
await supabase.functions.invoke('proxy-external-webhook', {
  body: {
    action: 'sync-mentoring',
    payload: {
      mentoring_session_id: session_id,
      title: session.title,
      recording_url: session.recording_url,
      transcriptions: session.transcriptions,
      metadata: { analysis },
    },
  },
});
```

### 18.10 Timeline do aluno recebe eventos de mentoria

No perfil do cliente/lead (`/clientes/:id`), adiciona 4 tipos de evento na timeline:

- **🎓 Compareceu à mentoria "X"** — de `mentoring_participants.entered_at`
- **🎤 Subiu ao palco em "X"** — de `mentoring_participants.called_at`
- **🙋 Levantou a mão em "X"** — de `mentoring_hand_raises.raised_at` (com status)
- **❓ Fez pergunta em "X"** — de `mentoring_questions.submitted_at` (com texto)

```ts
// Hook useClientTimeline.ts — bloco de mentoria
const [parts, raises, qs] = await Promise.all([
  supabase.from('mentoring_participants')
    .select('id, entered_at, left_at, called_at, questions_count, session:mentoring_sessions(id, title)')
    .eq('lead_id', leadId),
  supabase.from('mentoring_hand_raises')
    .select('id, raised_at, resolution, session:mentoring_sessions(id, title)')
    .eq('lead_id', leadId),
  supabase.from('mentoring_questions')
    .select('id, question, submitted_at, status, source, session:mentoring_sessions(id, title)')
    .eq('lead_id', leadId),
]);

parts.data?.forEach((p) => {
  events.push({
    id: `mentoring-attend-${p.id}`,
    date: p.entered_at,
    type: 'mentoring',
    title: `🎓 Compareceu à mentoria "${p.session?.title}"`,
    description: p.left_at ? `Ficou ${Math.round((+new Date(p.left_at) - +new Date(p.entered_at))/60000)} min` : 'Entrou',
  });
  if (p.called_at) events.push({
    id: `mentoring-stage-${p.id}`,
    date: p.called_at,
    type: 'mentoring',
    title: `🎤 Subiu ao palco em "${p.session?.title}"`,
  });
});

raises.data?.forEach((h) => events.push({
  id: `mentoring-hand-${h.id}`,
  date: h.raised_at,
  type: 'mentoring',
  title: `🙋 Levantou a mão em "${h.session?.title}"`,
  description: `Status: ${h.resolution || 'pendente'}`,
}));

qs.data?.forEach((q) => events.push({
  id: `mentoring-question-${q.id}`,
  date: q.submitted_at,
  type: 'mentoring',
  title: `❓ Pergunta em "${q.session?.title}"`,
  description: q.question,
}));
```

### 18.11 Diferenças entre Call e Mentoria — resumo

| Feature | Call (`/meet/:roomId`) | Mentoria (`/mentoria/:sessionId`) |
|---|---|---|
| Público | Fechado (link privado) | Público (`/m/:share_token`) |
| Papéis | host + guest + observer | mentor + alunos (30+) |
| Layout | 1:1 ou split | Palco / Galeria toggle |
| Levantar mão | Overlay simples | Fila com dossiê + histórico |
| Perguntas | Não | Sim (pre_call + during_call) |
| Chat | Sim (texto simples) | Sim (com anexos) |
| Handoff CS | Não | Sim (multi-org agrupado) |
| Aprovação de share | Livre | Aluno pede, mentor aprova |
| Modo Palco | Automático | Toggle Palco/Galeria |
| Análise IA | BANT + score + ata | Tópicos + engajamento + próximas ideias |
| Sync externo | Não | Sim (LMS/PAIN) |
| Timeline lead | Reunião registrada | 4 tipos de evento (compareceu, palco, mão, pergunta) |

**As melhorias avançadas (seção 17) valem pros DOIS sistemas.** O `<CallScreenShareEnhancer>` funciona igual no MentoringRoom. Os fixes de DataChannel transcription, requirements pinado, áudio da tela, Document PiP, tudo é compartilhado — implementa uma vez, ganha nos dois.

---

## Suporte

Dúvidas técnicas: consulte a documentação oficial:
- LiveKit: https://docs.livekit.io
- Cloudflare R2: https://developers.cloudflare.com/r2
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Deepgram (transcrição): https://developers.deepgram.com
- AssemblyAI (recovery): https://www.assemblyai.com/docs
- Document Picture-in-Picture API: https://developer.chrome.com/docs/web-platform/document-picture-in-picture

Este guia foi escrito com base em implementação real rodando em produção, com atualizações contínuas conforme aprendemos na prática.
