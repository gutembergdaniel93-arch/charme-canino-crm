# LiveKit Acelerador — Pack completo

Pack plug-and-play pra implementar **videochamadas** (call de vendas/CS) + **mentoria em grupo** (30+ alunos) no seu CRM, usando LiveKit Cloud + Cloudflare R2 + Deepgram + Supabase. **Substitui Google Meet.**

## Para a IA (Claude, Cursor, Copilot) implementar

**Instrução única pra colar no chat:**

> Você recebeu um pack de implementação de LiveKit. Faça o seguinte, **na ordem**:
>
> 1. Leia `docs/livekit-acelerador.md` **inteiro** — é o guia completo (arquitetura, decisões, código explicado seção por seção)
> 2. Aplique a migration `supabase/migrations/000_livekit_schema.sql` no banco Supabase do usuário
> 3. Deploy as edge functions em `supabase/functions/*` na ordem: livekit-token, livekit-webhook, livekit-end-room, recover-meeting-transcription, mentoring-actions, mentoring-public, analyze-mentoring-session, send-meeting-email
> 4. Configure os secrets no Supabase (`npx supabase secrets set --project-ref <REF> KEY=value`) — lista em `.env.example`
> 5. Configure o webhook do LiveKit apontando pra edge function `livekit-webhook` (dashboard LiveKit → Settings → Webhooks)
> 6. Deploy o **agent Python** em `livekit-agent/` no LiveKit Cloud (`lk agent deploy`). Requirements PINADO em `==1.5.8` — nunca use `>=`
> 7. Copie os arquivos em `src/pages/`, `src/components/meeting/`, `src/hooks/`, `src/lib/` pro projeto React do usuário. Ajuste imports (`@/lib`, `@/components`, etc) conforme o alias do projeto dele
> 8. Adicione as rotas no router: `/meet/:roomId` → MeetRoom, `/mentoria/:sessionId` → MentoringRoom, `/m/:token` → MentoringPublicJoin
> 9. Peça pra usuário criar as contas (LiveKit Cloud + Cloudflare R2 + Deepgram) e preencher o `.env.example`
> 10. Antes de considerar pronto: verifique se todos os secrets estão no Supabase, o webhook do LiveKit está configurado, o agent Python foi deployado (`lk agent status` mostra Running), o bucket R2 é público e o Storage bucket `mentoring-chat-media` existe no Supabase

**Se surgir dúvida, sempre consulte primeiro `docs/livekit-acelerador.md` — o guia tem 2000+ linhas cobrindo arquitetura, código, gotchas, custos e checklist final.**

---

## Estrutura do pack

```
livekit-acelerador-pack/
├── README.md                             # este arquivo
├── .env.example                          # todos os secrets necessários
│
├── docs/
│   └── livekit-acelerador.md             # 📘 GUIA COMPLETO — LER PRIMEIRO
│
├── supabase/
│   ├── migrations/
│   │   └── 000_livekit_schema.sql        # schema calls + mentoria + RLS
│   └── functions/
│       ├── livekit-token/                # gera JWT pro participante
│       ├── livekit-webhook/               # recebe eventos LiveKit + auto-restart egress
│       ├── livekit-end-room/              # encerra sala + para egress
│       ├── send-meeting-email/            # emails de reagendamento (opcional)
│       ├── recover-meeting-transcription/ # recovery via AssemblyAI
│       ├── mentoring-actions/             # ações do mentor (fila, palco, perguntas)
│       ├── mentoring-public/              # endpoints públicos por share_token
│       └── analyze-mentoring-session/     # análise IA pós-mentoria + sync externo
│
├── src/                                   # frontend React
│   ├── pages/
│   │   ├── MeetRoom.tsx                   # /meet/:roomId — call vendas
│   │   ├── MentoringRoom.tsx              # /mentoria/:sessionId — sala do mentor
│   │   ├── MentoringPublicJoin.tsx        # /m/:token — entrada pública do aluno
│   │   └── MentoringDetail.tsx            # painel de detalhes da sessão
│   ├── components/meeting/
│   │   ├── CallScreenShareEnhancer.tsx    # áudio da tela + overlay Zoom + Doc PiP
│   │   ├── RaiseHandOverlay.tsx           # botão levantar mão (call)
│   │   ├── ScreenShareTip.tsx             # dica visual pra host
│   │   ├── ParticipantNameOverlay.tsx     # nome do participante flutuante
│   │   └── RecordingIndicator.tsx         # badge "GRAVANDO"
│   ├── hooks/
│   │   ├── useLiveKit.ts                  # setup LiveKitRoom + token
│   │   ├── useLiveKitTranscriptionV2.ts   # transcrição via DataChannel (fix bug #3477)
│   │   ├── useLiveKitTranscription.ts     # transcrição legacy (Soniox, opcional)
│   │   └── useLiveKitTranscriptionAuto.ts # wrapper que escolhe V1/V2
│   └── lib/
│       └── utils.ts                       # cn() e helpers de className
│
├── livekit-agent/                         # 🐍 agent Python que roda no LiveKit Cloud
│   ├── main.py                            # entrypoint: transcreve via Deepgram + publica DataChannel
│   └── requirements.txt                   # PINADO ==1.5.8 (nunca use >=)
│
└── recording-concat/                      # 🎬 Modal worker (opcional)
    ├── main.py                            # ffmpeg concat de segments longos
    └── README.md                          # setup do Modal
```

---

## Instalação passo-a-passo (humano)

### 1. Criar contas externas

- [LiveKit Cloud](https://cloud.livekit.io) → criar projeto → copiar `URL`, `API Key`, `API Secret`
- [Cloudflare R2](https://dash.cloudflare.com/?to=/:account/r2) → criar bucket `meeting-recordings` → **habilitar Public Access** → copiar Public URL (`pub-xxxxx.r2.dev`) + criar API Token (Object Read & Write no bucket)
- [Deepgram](https://console.deepgram.com) → API Key
- [AssemblyAI](https://www.assemblyai.com) → API Key (opcional, só pra recovery)
- [Anthropic](https://console.anthropic.com) **ou** [Google AI Studio](https://aistudio.google.com/apikey) → API Key (pra análise IA)

Preencher `.env.example` com os valores → salvar como `.env`

### 2. Rodar migration no Supabase

```bash
# Via CLI
npx supabase db push

# OU: copiar conteúdo de supabase/migrations/000_livekit_schema.sql
# e rodar no SQL Editor do dashboard
```

### 3. Setar secrets no Supabase

```bash
export SUPABASE_REF=<seu-project-ref>

npx supabase secrets set --project-ref $SUPABASE_REF \
  LIVEKIT_URL=... \
  LIVEKIT_WS_URL=... \
  LIVEKIT_API_KEY=... \
  LIVEKIT_API_SECRET=... \
  R2_ACCESS_KEY_ID=... \
  R2_SECRET_ACCESS_KEY=... \
  R2_BUCKET=meeting-recordings \
  R2_ENDPOINT=... \
  R2_PUBLIC_URL=... \
  DEEPGRAM_API_KEY=... \
  ASSEMBLYAI_API_KEY=... \
  ANTHROPIC_API_KEY=... \
  GEMINI_API_KEY=...
```

### 4. Deploy edge functions

```bash
for FN in livekit-token livekit-webhook livekit-end-room \
          recover-meeting-transcription mentoring-actions \
          mentoring-public analyze-mentoring-session send-meeting-email; do
  npx supabase functions deploy $FN --project-ref $SUPABASE_REF --no-verify-jwt
done
```

**Importante**: `livekit-webhook` e `mentoring-public` **precisam** de `--no-verify-jwt` (LiveKit e alunos públicos não têm JWT do Supabase).

### 5. Configurar webhook no LiveKit

Dashboard LiveKit → Settings → Webhooks → **Add webhook**:

- URL: `https://<seu-supabase>.supabase.co/functions/v1/livekit-webhook`
- Eventos: `room_started`, `participant_joined`, `egress_ended`, `room_finished`

### 6. Deploy agent Python (transcrição)

```bash
# Instalar LiveKit CLI: https://docs.livekit.io/home/cli/cli-setup/
brew install livekit-cli  # macOS
# ou: curl -sSL https://get.livekit.io/cli | bash

# Autenticar
lk cloud auth

cd livekit-agent
# Setar secret DEEPGRAM_API_KEY no LiveKit Cloud
lk agent create --secrets DEEPGRAM_API_KEY=$DEEPGRAM_API_KEY
lk agent deploy

# Verificar
lk agent status
# Deve mostrar: Status: Running, 1/1/8 replicas
```

**REGRA INVIOLÁVEL**: `requirements.txt` está pinado em `==1.5.8`. **NUNCA use `>=`** — o LiveKit Cloud recicla réplicas e puxa versão nova com bugs (histórico: bug #3477 quebrou transcrição 3× já).

### 7. Deploy Modal worker (opcional, pra mentorias 4h+)

Ver `recording-concat/README.md`. Só é necessário se você faz mentorias longas onde o egress do LiveKit corta no meio.

### 8. Copiar frontend

Copiar `src/pages/`, `src/components/meeting/`, `src/hooks/`, `src/lib/` pro seu projeto React. Ajustar imports (`@/lib`, `@/components`, etc).

Dependências npm necessárias:

```bash
npm i livekit-client @livekit/components-react @livekit/components-styles \
      @supabase/supabase-js lucide-react
```

### 9. Criar bucket de chat no Supabase Storage

Dashboard Supabase → Storage → **New bucket** → nome: `mentoring-chat-media`, Public: **yes**

### 10. Rotas do router

```tsx
// src/App.tsx (ou seu router)
<Route path="/meet/:roomId" element={<MeetRoom />} />
<Route path="/mentoria/:sessionId" element={<MentoringRoom />} />
<Route path="/m/:token" element={<MentoringPublicJoin />} />
```

### 11. Smoke test

1. Criar meeting: `INSERT INTO meetings (livekit_room_name, title) VALUES ('test-room', 'Teste');`
2. Abrir `/meet/test-room` no browser → deve entrar na sala
3. Verificar no dashboard LiveKit se a sala aparece "active"
4. Verificar no R2 se um `.mp4` foi criado depois de alguns segundos

---

## Custos estimados (mês)

- **LiveKit Cloud**: $5 free tier + $0.006/min de video egress. Estimativa: 100 calls de 30min = ~180h = $65
- **Cloudflare R2**: $0.015/GB storage + zero egress fee. 100 calls × 500MB = 50GB = $0.75/mês
- **Deepgram Nova-3 streaming**: $0.0058/min por participant. **Cuidado com mentoria de 20 alunos = 20× o consumo**. Recomendação: mentoria usa transcrição só do host + palco (não da audiência inteira)
- **AssemblyAI batch**: $0.27/hora (só usa quando precisa recovery)
- **Supabase**: free tier cobre bem até 500MB banco
- **Anthropic Claude Sonnet**: análise pós-mentoria ~$0.05/análise

**Total realista**: $80-150/mês pra empresa de vendas média rodando 100 calls + 4 mentorias/mês.

---

## Suporte

- Guia completo: `docs/livekit-acelerador.md`
- Docs LiveKit: https://docs.livekit.io
- Docs R2: https://developers.cloudflare.com/r2
- Docs Deepgram: https://developers.deepgram.com

Este pack foi baseado em implementação real rodando em produção há 6+ meses com centenas de calls e mentorias com 30+ alunos simultâneos.
