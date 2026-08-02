# Power Assistant's local diarized transcription server.
#
# Job-based API (v2): the plugin POSTs a recording to /transcribe, gets a
# job id back immediately, and polls /jobs/<id> until the job reports done
# with {"segments": [{"start", "end", "text", "speaker"}]}. A segment during
# which the diarizer heard two or more voices AT ONCE also carries
# "speakers": [labels] (the attributed voice first) so the client can label
# the crosstalk instead of trusting the single-name attribution; whisper
# itself still transcribes only the dominant voice. Passing the form
# field embeddings=1 also returns a per-speaker mean voice vector under
# result.embeddings plus per-turn vectors under result.segment_embeddings
# (for cross-recording speaker identity and for auditing a cluster turn by
# turn); it is opt-in because the embedding model is a separate download.
# Optional min_speakers / max_speakers form fields bound the diarizer's
# speaker count, e.g. from the meeting invite's attendee list. An hour of
# audio can take minutes to process; handing back an id instead of holding
# one long HTTP request open means a dropped socket, a plugin reload, or a
# busy server never loses the work. Jobs run one at a time (a small box
# stays responsive) and finished results are kept for an hour.
#
#   python server.py --model large-v3-turbo --port 8571
#
# Diarization (the speaker labels) needs a Hugging Face token with the
# gated pyannote models accepted; see README.md. Without a token the
# server still transcribes, it just cannot tell speakers apart, and
# /health says so.

import argparse
import gc
import os
import tempfile
import threading
import time
import uuid
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

parser = argparse.ArgumentParser(description="WhisperX transcription server for Power Assistant")
parser.add_argument("--model", default=os.environ.get("WHISPERX_MODEL", "large-v3-turbo"))
parser.add_argument("--port", type=int, default=int(os.environ.get("WHISPERX_PORT", "8571")))
parser.add_argument("--host", default=os.environ.get("WHISPERX_HOST", "0.0.0.0"))
parser.add_argument("--batch-size", type=int, default=int(os.environ.get("WHISPERX_BATCH", "8")))
args = parser.parse_args()

HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()

import torch  # noqa: E402  (after argparse so --help works without CUDA drama)
import whisperx  # noqa: E402

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
COMPUTE = "float16" if DEVICE == "cuda" else "int8"

print(f"[whisperx-server] loading {args.model} on {DEVICE} ({COMPUTE})...")
model = whisperx.load_model(args.model, DEVICE, compute_type=COMPUTE)

diarizer = None
DIARIZER_MODEL = None
if HF_TOKEN:
    try:
        try:
            from whisperx.diarize import DiarizationPipeline  # whisperx >= 3.2
        except ImportError:
            DiarizationPipeline = whisperx.DiarizationPipeline  # older layouts
        # the auth kwarg was renamed (use_auth_token -> token) in the pyannote 4
        # era; a wrong kwarg is a TypeError that would silently cost the labels
        def _load_diarizer(**kw):
            try:
                return DiarizationPipeline(token=HF_TOKEN, device=DEVICE, **kw)
            except TypeError:
                return DiarizationPipeline(use_auth_token=HF_TOKEN, device=DEVICE, **kw)

        # explicit preference order, so which pipeline runs never depends on
        # which whisperx happens to be installed: community-1 first (clearly
        # better speaker counting on big meetings), then whatever the library
        # defaults to, then 3.1 (the one older tokens have accepted). Each is
        # gated separately on Hugging Face; a token that cannot reach the
        # newer one still deserves labels from the one it can.
        for _name in ("pyannote/speaker-diarization-community-1", None, "pyannote/speaker-diarization-3.1"):
            try:
                diarizer = _load_diarizer(**({"model_name": _name} if _name else {}))
                DIARIZER_MODEL = _name or "library default"
                break
            except Exception as e:  # noqa: BLE001  (try the next pipeline in line)
                print(f"[whisperx-server] {_name or 'the default pipeline'} unavailable ({str(e)[:160]})")
        if diarizer is None:
            raise RuntimeError("no diarization pipeline could be loaded with this token")
        print(f"[whisperx-server] diarization ready ({DIARIZER_MODEL}).")
    except Exception as e:  # noqa: BLE001  (a missing gated model must not kill transcription)
        print(f"[whisperx-server] diarization unavailable: {e}")
        print("[whisperx-server] transcripts will have no speaker labels until this is fixed.")
else:
    print("[whisperx-server] HF_TOKEN not set: transcribing WITHOUT speaker labels.")

# Speaker embeddings ("voiceprints") are opt-in per request and lazy-loaded, so
# a user who never asks for them pays no VRAM or startup for the extra model.
# pyannote/embedding is a SEPARATE gated model from the diarizer: accept it once
# on Hugging Face (see README) under the same token.
_embedder = None
_embedder_tried = False
_embedder_lock = threading.Lock()


def _get_embedder():
    global _embedder, _embedder_tried
    with _embedder_lock:
        if _embedder_tried:
            return _embedder
        _embedder_tried = True
        if not HF_TOKEN:
            return None
        try:
            from pyannote.audio import Inference, Model

            try:
                m = Model.from_pretrained("pyannote/embedding", token=HF_TOKEN)
            except TypeError:
                m = Model.from_pretrained("pyannote/embedding", use_auth_token=HF_TOKEN)
            _embedder = Inference(m, window="whole", device=torch.device(DEVICE))
            print("[whisperx-server] speaker embeddings ready.")
        except Exception as e:  # noqa: BLE001  (missing model must not break transcription)
            print(f"[whisperx-server] speaker embeddings unavailable: {e}")
            _embedder = None
        return _embedder


def _diar_turns(diar):
    """The diarizer's speaker turns as plain (start, end, label) triples.
    whisperx's DiarizationPipeline returns a pandas DataFrame (start / end /
    speaker columns), while a raw pyannote Annotation carries the same facts
    under itertracks; normalizing here lets the embedding and crosstalk
    passes take either. (The embedding pass used to call itertracks on the
    result directly, which the DataFrame does not have, so on stock whisperx
    every embedding request died before reaching the model.)"""
    if hasattr(diar, "itertracks"):
        return [(float(t.start), float(t.end), str(label)) for t, _, label in diar.itertracks(yield_label=True)]
    return [(float(row.start), float(row.end), str(row.speaker)) for row in diar.itertuples()]


def _mark_crosstalk(segments, turns, overlap_min=0.25):
    """Flag transcript segments during which two or more voices talked AT
    ONCE. Each transcript segment is attributed to one dominant voice, so an
    interjection under it is silently miscredited; when diarizer turns with
    different labels overlap each other inside the segment's window for at
    least overlap_min seconds, the segment gains "speakers": [labels] (the
    attributed voice first, the rest by how long they overlap the segment).
    Requiring the turns to overlap EACH OTHER keeps a clean handover that
    whisper merged into one segment, or boundary jitter, from reading as
    crosstalk. overlap_min is a placeholder to calibrate like the plugin's
    voice thresholds."""
    if not turns:
        return
    ts = sorted(turns)
    for seg in segments:
        ss = float(seg.get("start") or 0.0)
        se = float(seg.get("end") or 0.0)
        if se <= ss:
            continue
        active = [t for t in ts if t[0] < se and t[1] > ss]
        if len(active) < 2:
            continue
        involved = set()
        for i, (s1, e1, l1) in enumerate(active):
            for s2, e2, l2 in active[i + 1 :]:
                if l2 == l1:
                    continue
                if min(se, e1, e2) - max(ss, s1, s2) >= overlap_min:
                    involved.add(l1)
                    involved.add(l2)
        if not involved:
            continue
        secs = {}
        for s0, e0, label in active:
            if label in involved:
                secs[label] = secs.get(label, 0.0) + max(0.0, min(se, e0) - max(ss, s0))
        order = sorted(secs, key=lambda label: -secs[label])
        assigned = seg.get("speaker")
        if assigned:
            order = [assigned] + [label for label in order if label != assigned]
        seg["speakers"] = order


def _speaker_embeddings(embedder, audio, turns, min_seg=1.0, turn_min=2.0):
    """Per-speaker mean voice embeddings plus per-turn vectors, all
    L2-normalized and keyed by diarization label. `turns` is the normalized
    (start, end, label) list. Fed the in-memory 16 kHz waveform whisperx
    already decoded, so pyannote never has to re-open the (possibly webm)
    source. Turns under min_seg seconds are skipped entirely (a clipped word
    makes a noisy vector). The per-turn list only reports turns past
    turn_min, because that is what a cluster audit can actually trust, and
    its vectors are rounded to 4 decimals: ~1e-3 of cosine noise for roughly
    half the payload. The crops were already being computed for the means,
    so the per-turn list costs nothing extra."""
    import numpy as np
    from pyannote.core import Segment

    wav = torch.from_numpy(np.asarray(audio, dtype="float32")).reshape(1, -1)
    audio_file = {"waveform": wav, "sample_rate": 16000}
    acc = {}
    out_turns = []
    for start, end, label in turns:
        dur = float(end - start)
        if dur < min_seg:
            continue
        try:
            vec = embedder.crop(audio_file, Segment(start, end))
        except Exception:  # noqa: BLE001  (one bad crop should not sink the rest)
            continue
        vec = np.asarray(vec, dtype="float64").reshape(-1)
        if vec.size == 0 or not np.all(np.isfinite(vec)):
            continue
        if label not in acc:
            acc[label] = [np.zeros_like(vec), 0.0]
        acc[label][0] += vec * dur
        acc[label][1] += dur
        if dur >= turn_min:
            norm = float(np.linalg.norm(vec))
            if norm > 0:
                out_turns.append(
                    {
                        "speaker": label,
                        "start": round(float(start), 2),
                        "end": round(float(end), 2),
                        "seconds": round(dur, 2),
                        "vector": [round(float(x), 4) for x in (vec / norm)],
                    }
                )
    out = {}
    for label, (vsum, secs) in acc.items():
        if secs <= 0:
            continue
        mean = vsum / secs
        norm = float(np.linalg.norm(mean))
        if norm <= 0:
            continue
        mean = (mean / norm).tolist()
        out[label] = {"vector": [round(float(x), 6) for x in mean], "seconds": round(float(secs), 2)}
    return out, out_turns


# one recording at a time: a second job queues rather than fighting the
# first for VRAM. The plugin polls either way.
work_lock = threading.Lock()

RESULT_TTL_S = 3600
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


def _gc_jobs():
    now = time.monotonic()
    with jobs_lock:
        for jid in [j for j, v in jobs.items() if v["status"] in ("done", "error") and now - v["finished"] > RESULT_TTL_S]:
            del jobs[jid]


def _set(jid: str, **fields):
    with jobs_lock:
        if jid in jobs:
            jobs[jid].update(fields)


def _run_job(jid: str, path: str, want_embeddings: bool = False, min_speakers: Optional[int] = None, max_speakers: Optional[int] = None):
    try:
        with work_lock:
            _set(jid, status="working", stage="transcribing")
            audio = whisperx.load_audio(path)
            result = model.transcribe(audio, batch_size=args.batch_size)
            language = result.get("language", "en")
            speaker_embeddings = {}
            turn_embeddings = []
            diar_turns = []
            if diarizer is not None:
                # word-level alignment first, so speaker turns land on the
                # right words instead of drifting across segment borders
                _set(jid, stage="aligning")
                try:
                    align_model, meta = whisperx.load_align_model(language_code=language, device=DEVICE)
                    result = whisperx.align(result["segments"], align_model, meta, audio, DEVICE)
                    del align_model
                except Exception as e:  # noqa: BLE001  (no align model for this language)
                    print(f"[whisperx-server] alignment skipped: {e}")
                _set(jid, stage="diarizing")
                # the caller can bound the speaker count (say, from a meeting
                # invite's attendee list); the classic long-meeting failure is
                # the clusterer inventing the wrong number of speakers
                bounds = {}
                if min_speakers:
                    bounds["min_speakers"] = min_speakers
                if max_speakers:
                    bounds["max_speakers"] = max_speakers
                try:
                    diar = diarizer(audio, **bounds)
                except TypeError:
                    # an older DiarizationPipeline without the bounds kwargs
                    # should still produce labels, just unbounded
                    diar = diarizer(audio)
                result = whisperx.assign_word_speakers(diar, result)
                try:
                    diar_turns = _diar_turns(diar)
                except Exception as e:  # noqa: BLE001  (labels still stand; only the extras need the turns)
                    print(f"[whisperx-server] could not read the diarization turns: {e}")
                if want_embeddings:
                    embedder = _get_embedder()
                    if embedder is not None and diar_turns:
                        _set(jid, stage="embedding")
                        try:
                            speaker_embeddings, turn_embeddings = _speaker_embeddings(embedder, audio, diar_turns)
                        except Exception as e:  # noqa: BLE001  (voiceprints are a bonus, never the job)
                            print(f"[whisperx-server] embeddings failed: {e}")
            segments = [
                {
                    "start": float(sg.get("start") or 0.0),
                    "end": float(sg.get("end") or 0.0),
                    "text": (sg.get("text") or "").strip(),
                    **({"speaker": sg["speaker"]} if sg.get("speaker") else {}),
                }
                for sg in result.get("segments", [])
                if (sg.get("text") or "").strip()
            ]
            try:
                _mark_crosstalk(segments, diar_turns)
            except Exception as e:  # noqa: BLE001  (an unmarked transcript is still a transcript)
                print(f"[whisperx-server] crosstalk pass failed: {e}")
            payload = {"segments": segments, "language": language}
            if speaker_embeddings:
                payload["embeddings"] = speaker_embeddings
            if turn_embeddings:
                payload["segment_embeddings"] = turn_embeddings
            _set(jid, status="done", stage="done", finished=time.monotonic(), result=payload)
    except Exception as e:  # noqa: BLE001  (the job must report, not vanish)
        print(f"[whisperx-server] job {jid} failed: {e}")
        _set(jid, status="error", stage="error", finished=time.monotonic(), error=str(e))
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
        gc.collect()
        if DEVICE == "cuda":
            torch.cuda.empty_cache()


app = FastAPI(title="Power Assistant WhisperX server")


@app.get("/health")
def health():
    with jobs_lock:
        active = sum(1 for v in jobs.values() if v["status"] in ("queued", "working"))
    # embeddings need a diarization to attribute segments, so the capability
    # tracks it; the model itself loads lazily on the first request that asks
    return {
        "ok": True,
        "api": 2,
        "model": args.model,
        "device": DEVICE,
        "diarization": diarizer is not None,
        "diarization_model": DIARIZER_MODEL,
        "embeddings": diarizer is not None,
        "active_jobs": active,
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    embeddings: bool = Form(False),
    min_speakers: Optional[int] = Form(None),
    max_speakers: Optional[int] = Form(None),
):
    _gc_jobs()
    suffix = os.path.splitext(file.filename or "audio.webm")[1] or ".webm"
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    # a nonsense bound would make the diarizer worse than no bound at all
    min_speakers = min_speakers if min_speakers and min_speakers > 0 else None
    max_speakers = max_speakers if max_speakers and max_speakers > 0 else None
    if min_speakers and max_speakers and min_speakers > max_speakers:
        min_speakers = None
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name
    jid = uuid.uuid4().hex[:12]
    with jobs_lock:
        jobs[jid] = {"status": "queued", "stage": "queued", "finished": 0.0}
    threading.Thread(target=_run_job, args=(jid, path, bool(embeddings), min_speakers, max_speakers), daemon=True).start()
    return {"job": jid}


@app.get("/jobs/{jid}")
def job_status(jid: str):
    _gc_jobs()
    with jobs_lock:
        v = jobs.get(jid)
        if v is None:
            raise HTTPException(status_code=404, detail="unknown or expired job")
        out = {"job": jid, "status": v["status"], "stage": v["stage"]}
        if v["status"] == "done":
            out["result"] = v["result"]
        elif v["status"] == "error":
            out["error"] = v.get("error", "unknown error")
        return out


if __name__ == "__main__":
    print(f"[whisperx-server] listening on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)
