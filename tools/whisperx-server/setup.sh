#!/usr/bin/env bash
# Power Assistant WhisperX server: one-command setup for macOS and Linux.
#
#   bash setup.sh
#
# Finds Python, makes a private venv (outside your vault), installs PyTorch
# matched to your hardware, installs the server, asks for a Hugging Face token
# (Enter to skip; transcription works without it, speaker labels do not),
# registers the server to start at login, starts it now, and prints the
# address to paste into Power Assistant. Safe to rerun; it only redoes what
# changed.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/powerassistant"
VENV="$DATA/whisperx-venv"
PORT=8571

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

step "Looking for Python (3.10 to 3.12)"
PY=""
for cand in python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    v="$("$cand" --version 2>&1)"
    minor="$(printf '%s' "$v" | sed -n 's/.*3\.\([0-9]*\).*/\1/p')"
    if [ -n "$minor" ] && [ "$minor" -ge 10 ] && [ "$minor" -le 12 ]; then PY="$cand"; echo "    using $v ($cand)"; break; fi
  fi
done
if [ -z "$PY" ]; then
  echo "No suitable Python found. Install 3.12 (brew install python@3.12, or your distro's package), then rerun."
  exit 1
fi

step "Private environment at $VENV"
mkdir -p "$DATA"
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip --quiet

CUDA_INDEX="https://download.pytorch.org/whl/cu128"
if command -v nvidia-smi >/dev/null 2>&1; then
  step "NVIDIA GPU found; installing CUDA PyTorch (about 3 GB, one time)"
  "$VENV/bin/python" -m pip install torch torchaudio --index-url "$CUDA_INDEX"
else
  step "Installing PyTorch (Apple Silicon uses the GPU automatically; plain CPU elsewhere)"
  "$VENV/bin/python" -m pip install torch torchaudio
fi

step "Installing the transcription server"
if command -v nvidia-smi >/dev/null 2>&1; then
  # the CUDA index rides along so a requirements-driven torch upgrade can
  # never resolve to a CPU wheel and silently park the GPU
  "$VENV/bin/python" -m pip install -r "$HERE/requirements.txt" --extra-index-url "$CUDA_INDEX"
else
  "$VENV/bin/python" -m pip install -r "$HERE/requirements.txt"
fi

HF_TOKEN="${HF_TOKEN:-}"
if [ -z "$HF_TOKEN" ]; then
  step "Speaker labels need a free Hugging Face token"
  echo "    1. Create a read token at https://huggingface.co/settings/tokens"
  echo "    2. While signed in, open each page and accept its terms:"
  echo "         https://huggingface.co/pyannote/segmentation-3.0"
  echo "         https://huggingface.co/pyannote/speaker-diarization-3.1"
  echo "         https://huggingface.co/pyannote/speaker-diarization-community-1 (newest pipeline)"
  echo "         https://huggingface.co/pyannote/embedding (voiceprints)"
  printf '    Paste the token (or press Enter to skip; rerun this script later to add it): '
  read -r HF_TOKEN || HF_TOKEN=""
fi

# The metadata API answers 200 even when terms are NOT accepted; only a file
# fetch tells the truth. Catch it here, not as a silent labels-off at runtime.
if [ -n "$HF_TOKEN" ]; then
  step "Checking the token can reach the gated speaker models"
  BLOCKED=""
  for r in pyannote/segmentation-3.0 pyannote/speaker-diarization-3.1 pyannote/speaker-diarization-community-1 pyannote/embedding; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 -H "Authorization: Bearer $HF_TOKEN" "https://huggingface.co/$r/resolve/main/config.yaml" || echo 000)
    if [ "$code" = "200" ] || [ "$code" = "302" ]; then
      echo "    ok       $r"
    else
      BLOCKED="$BLOCKED $r"
      echo "    BLOCKED  $r"
    fi
  done
  if [ -n "$BLOCKED" ]; then
    echo ""
    echo "    Speaker labels stay OFF until the blocked models are accepted:"
    for r in $BLOCKED; do echo "      1. Sign in and accept at https://huggingface.co/$r"; done
    echo "      2. A fine-grained token also needs the 'gated repositories' read permission (a classic Read token is simplest)."
    echo "      3. Rerun this script (or just restart the server) afterwards; nothing else needs redoing."
    echo "    Labels need segmentation-3.0 plus either diarization pipeline; voiceprints need embedding."
  fi
fi

step "Registering the server to start at login"
RUN="$DATA/run-whisperx.sh"
{
  echo '#!/usr/bin/env bash'
  [ -n "$HF_TOKEN" ] && echo "export HF_TOKEN='$HF_TOKEN'"
  echo "exec \"$VENV/bin/python\" \"$HERE/server.py\" --port $PORT"
} > "$RUN"
chmod +x "$RUN"
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.powerassistant.whisperx.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.powerassistant.whisperx</string>
  <key>ProgramArguments</key><array><string>$RUN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "    registered launch agent (starts at login, restarts if it dies)"
elif command -v systemctl >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/powerassistant-whisperx.service"
  mkdir -p "$(dirname "$UNIT")"
  printf '[Unit]\nDescription=Power Assistant WhisperX server\n\n[Service]\nExecStart=%s\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n' "$RUN" > "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now powerassistant-whisperx.service
  echo "    registered systemd user service"
else
  echo "    no launchd or systemd found; start it by hand with: $RUN"
  nohup "$RUN" >/dev/null 2>&1 &
fi

step "Waiting for the server (first start downloads models, a few GB; be patient)"
UP=""
for i in $(seq 1 180); do
  sleep 5
  if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then UP=1; break; fi
  [ $((i % 6)) -eq 0 ] && echo "    still starting ($((i * 5 / 60)) min)..."
done

if [ "$(uname)" = "Darwin" ]; then IP="$(ipconfig getifaddr en0 2>/dev/null || echo localhost)"; else IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
[ -n "$IP" ] || IP=localhost

if [ -n "$UP" ]; then
  step "The server is up"
  curl -fsS "http://localhost:$PORT/health" && echo
  echo
  printf '\033[32mPaste this into Power Assistant settings (API keys tab, WhisperX section):\n\n    http://%s:%s\n\033[0m\n' "$IP" "$PORT"
else
  step "The server did not come up in 15 minutes"
  echo "It may still be downloading models. Run it by hand to watch the log: $RUN"
fi
