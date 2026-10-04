"""
LiveKit Agent — Transcrição em tempo real com Deepgram Nova-3 pt-BR

Entra como bot invisível em cada sala, captura audio de cada participant
separadamente, transcreve via Deepgram e publica via DataChannel
(topic="cs-transcription") com identity EXPLÍCITA no payload.

Por que DataChannel e não publish_transcription?
Bug LiveKit #3477: o evento nativo TranscriptionReceived dispara com
participant_identity errado (vem o do AGENT em vez do que falou). Quebrou em
21/05/2026 quando o LiveKit Cloud reciclou réplicas e puxou versão >= 1.2.0.
Fix de 25/05 mudou pra DataChannel; alguém reverteu entre 25/05 e 11/06 (caso
ANDREY 17:01 e Adel Nayef 18:22 — 2h+ de transcrição perdida) e RE-REVERTEU
em 03/07/2026. Re-aplicado com mesma abordagem.

Speaker diarization trivial: cada participant é um stream separado, o
participantIdentity já identifica quem falou.
"""

import asyncio
import json
import logging
import uuid

from livekit import agents, rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, WorkerPermissions, cli, stt
from livekit.plugins import deepgram

logger = logging.getLogger("transcription-agent")
logger.setLevel(logging.INFO)

# Topic do DataChannel. Frontend escuta em useLiveKitTranscriptionV2.ts.
# NÃO MUDAR sem atualizar o hook do frontend ao mesmo tempo.
DATA_TOPIC = "cs-transcription"


def _build_stt() -> stt.STT:
    """Constrói Deepgram STT com config padrão. Isolado pra recriar em reconnect."""
    return deepgram.STT(
        model="nova-3",
        language="multi",
        interim_results=True,
        punctuate=True,
        smart_format=True,
        no_delay=True,
    )


async def _publish_segment(
    ctx: JobContext,
    participant_identity: str,
    track_sid: str,
    segment_id: str,
    text: str,
    is_final: bool,
):
    """
    Publica uma transcrição via DataChannel + (best-effort) transcrição nativa.

    DataChannel é a fonte da verdade pro frontend (cs-transcription topic).
    publish_transcription mantido como fallback pra clientes legados; falha
    nele não derruba a transcrição.
    """
    payload = {
        "type": "transcription",
        "participant_identity": participant_identity,
        "track_sid": track_sid,
        "segment_id": segment_id,
        "text": text,
        "is_final": is_final,
    }
    data_bytes = json.dumps(payload).encode("utf-8")

    # Caminho principal: DataChannel reliable, topic explícito.
    for pub_attempt in range(3):
        try:
            await ctx.room.local_participant.publish_data(
                data_bytes,
                reliable=True,
                topic=DATA_TOPIC,
            )
            break
        except Exception as e:
            if pub_attempt == 2:
                logger.error(
                    f"publish_data falhou 3x ({participant_identity}): {e}"
                )
            else:
                await asyncio.sleep(0.3 * (pub_attempt + 1))

    # Caminho secundário (best-effort): transcrição nativa, ignora bug #3477.
    try:
        segment = rtc.TranscriptionSegment(
            id=segment_id,
            text=text,
            start_time=0,
            end_time=0,
            language="pt-BR",
            final=is_final,
        )
        transcription = rtc.Transcription(
            participant_identity=participant_identity,
            track_sid=track_sid,
            segments=[segment],
        )
        await ctx.room.local_participant.publish_transcription(transcription)
    except Exception:
        # Silencioso por design: DataChannel é a fonte da verdade.
        pass


async def transcribe_track(
    ctx: JobContext,
    participant: rtc.RemoteParticipant,
    track: rtc.Track,
):
    """
    Transcreve áudio de 1 participant com retry automático.

    Causa raiz #2 (caso Rafael 12/05 — parou aos 36min de 52):
    o loop `async for ev in stt_stream` termina silenciosamente se Deepgram
    fecha a conexão (timeout, network blip, etc) e o agent perde o resto da
    call. Fix: wrap em retry com backoff exponencial e recria stt_stream a
    cada reconexão enquanto a track ainda existir.
    """
    audio_stream = rtc.AudioStream(track)
    attempt = 0
    max_attempts = 20  # ~30min de retry no pior caso (backoff capa em 60s)

    while attempt < max_attempts:
        stt_provider = _build_stt()
        stt_stream = stt_provider.stream()

        async def send_audio():
            async for event in audio_stream:
                try:
                    stt_stream.push_frame(event.frame)
                except Exception as e:
                    logger.warning(
                        f"push_frame falhou ({participant.identity}): {e}"
                    )
                    return

        async def forward_transcriptions():
            async for ev in stt_stream:
                if ev.type not in (
                    stt.SpeechEventType.INTERIM_TRANSCRIPT,
                    stt.SpeechEventType.FINAL_TRANSCRIPT,
                ):
                    continue
                if not ev.alternatives:
                    continue
                text = ev.alternatives[0].text
                if not text or not text.strip():
                    continue

                is_final = ev.type == stt.SpeechEventType.FINAL_TRANSCRIPT
                segment_id = f"seg_{uuid.uuid4().hex[:12]}"
                await _publish_segment(
                    ctx,
                    participant_identity=participant.identity,
                    track_sid=track.sid,
                    segment_id=segment_id,
                    text=text,
                    is_final=is_final,
                )

        try:
            logger.info(
                f"Stream Deepgram iniciada (attempt {attempt + 1}) "
                f"para {participant.identity} (track_sid={track.sid})"
            )
            await asyncio.gather(send_audio(), forward_transcriptions())
            logger.info(
                f"Stream encerrada limpamente: {participant.identity} "
                f"(track_sid={track.sid})"
            )
            return
        except Exception as e:
            attempt += 1
            backoff = min(2 ** attempt, 60)
            logger.warning(
                f"Stream Deepgram caiu ({participant.identity}, attempt={attempt}): {e}. "
                f"Reconectando em {backoff}s..."
            )
            await asyncio.sleep(backoff)

    logger.error(
        f"Desisti de transcrever {participant.identity} após {max_attempts} tentativas"
    )


async def entrypoint(ctx: JobContext):
    logger.info(f"Transcription agent entrou na sala: {ctx.room.name}")

    transcribing_sids: set[str] = set()

    def start_transcribe(participant: rtc.RemoteParticipant, track: rtc.Track):
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if track.sid in transcribing_sids:
            return
        transcribing_sids.add(track.sid)
        logger.info(
            f"Transcrevendo áudio de: {participant.identity} (track_sid={track.sid})"
        )
        asyncio.create_task(
            transcribe_track(ctx, participant, track)
        )

    # CAUSA RAIZ #1 DO BUG `n_lines: 0`:
    # Registrar listeners ANTES de ctx.connect() fecha a janela de race condition.
    @ctx.room.on("track_subscribed")
    def on_track_subscribed(
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ):
        start_transcribe(participant, track)

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # DEFESA EM PROFUNDIDADE: varre participants já presentes.
    for participant in ctx.room.remote_participants.values():
        for publication in participant.track_publications.values():
            if publication.track is not None and publication.subscribed:
                start_transcribe(participant, publication.track)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        permissions=WorkerPermissions(hidden=True),
    ))
