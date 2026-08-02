# WhisperX server for Power Assistant

Speaker-labeled transcription on your own hardware. The plugin's **WhisperX** provider POSTs recordings here and gets back diarized segments; nothing leaves your network, and the usage meter prices it at $0.00.

Runs anywhere Python runs, but a CUDA GPU (an RTX 3090 class card is ideal) makes an hour of audio take a few minutes instead of a large fraction of an hour.

**The easy path**: in Power Assistant's settings (API keys tab, WhisperX section), press **Show install steps**. The plugin writes these files out for you and shows the one `setup.ps1` / `setup.sh` command that does everything below, including start-at-login. The manual steps that follow are the same thing by hand.

## Setup

1. **Python 3.10 or newer**, then from this folder:

   ```
   pip install -r requirements.txt
   ```

   On a CUDA machine, install the CUDA build of PyTorch first (see pytorch.org for the command matching your CUDA version), then the requirements.

2. **Speaker labels need a Hugging Face token** (transcription works without one, but every meeting comes back as one unlabeled block):

   - Create a free token at huggingface.co (Settings, Access Tokens, read scope).
   - While signed in, open and accept the terms on the gated models:
     - `pyannote/speaker-diarization-community-1` (preferred: clearly better speaker counting in big meetings)
     - `pyannote/segmentation-3.0`
     - `pyannote/speaker-diarization-3.1` (the fallback pipeline for tokens that cannot reach community-1)
   - The server tries community-1 first and falls back down that list; `GET /health` reports which pipeline actually loaded under `diarization_model`.
   - Set the token before starting the server: `set HF_TOKEN=hf_...` (Windows) or `export HF_TOKEN=hf_...` (macOS/Linux).
   - For **voiceprints** (recognizing a speaker across recordings), also accept `pyannote/embedding`. It loads only when a request asks for embeddings, so skip it if you are not using that.

3. **Start it:**

   ```
   python server.py --model large-v3-turbo --port 8571
   ```

   First start downloads the models (several GB) and takes a few minutes; after that they load from cache. `large-v3-turbo` is the speed/quality sweet spot; use `large-v3` for maximum accuracy or `medium` on CPU-only machines.

4. **Point the plugin at it:** Power Assistant settings, API keys tab, WhisperX section. Enter `http://<this machine's LAN address>:8571` and press **Check server**. Then pick WhisperX as the transcription provider (or per capture kind, for example meetings only).

## Keeping it running

The server binds to `0.0.0.0` so the rest of your devices can reach it. Keep it to your own network; it has no authentication by design.

- **Windows:** Task Scheduler (run at startup, whether logged in or not) or `nssm` to install it as a service.
- **Linux:** a systemd unit calling `python server.py` with `Environment=HF_TOKEN=...`.

## API (v2, job-based)

- `POST /transcribe` (multipart, field `file`) answers immediately with `{"job": "<id>"}` and processes in the background, one job at a time. Optional form field `embeddings=1` also computes voice vectors. Optional integer form fields `min_speakers` / `max_speakers` bound how many voices the diarizer looks for; the plugin sends the meeting invite's attendee count as the ceiling.
- `GET /jobs/<id>` reports `{"status": "queued"|"working"|"done"|"error", "stage": ...}`; `done` carries `result.segments` (`start`/`end` seconds, `text`, `speaker`), `error` carries the reason. A segment during which the diarizer heard two or more voices at once also carries `speakers` (every voice active in the overlap, the attributed one first), so the plugin can label crosstalk honestly; whisper itself still transcribes only the dominant voice. When embeddings were requested, `done` also carries `result.embeddings` (an L2-normalized mean vector plus total `seconds` per speaker id) and `result.segment_embeddings` (one vector per diarized turn of two seconds or more, with `speaker`, `start`, `end`, `seconds`), which is what lets the plugin audit a speaker cluster turn by turn. Finished jobs are kept for an hour.
- `GET /health` reports `{"ok", "api": 2, "model", "device", "diarization", "diarization_model", "embeddings", "active_jobs"}`.

The plugin (1.56.0 and later) polls this contract, so a dropped connection or an Obsidian reload mid-job never loses server work; it also still understands a v1 server that answers with segments inline.

## Answers to likely questions

- **`/health` says `"diarization": false`**: HF_TOKEN is missing, or none of the gated pipelines above have been accepted with that token's account. Fix and restart. If it says `"diarization": true` but `diarization_model` is `pyannote/speaker-diarization-3.1`, accepting community-1's terms (and restarting) upgrades the speaker counting.
- **Out of VRAM alongside an LLM:** lower `--batch-size` to 4, or use `--model medium`. The server already handles one recording at a time and releases cache between jobs.
- **First request after startup is slow:** alignment models load per language on first use; later requests reuse them warm.
