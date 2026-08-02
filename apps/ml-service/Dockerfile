FROM python:3.11-slim

WORKDIR /app

# System deps for audio + image processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 libgomp1 && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Install CPU-only torch. The CPU wheel index only ships x86_64 builds, so on
# arm64 (Apple Silicon, AWS Graviton) we fall back to PyPI's CPU build.
RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    (pip install --no-cache-dir torch==2.5.1+cpu --index-url https://download.pytorch.org/whl/cpu \
      || pip install --no-cache-dir torch==2.5.1) && \
    pip install --no-cache-dir -r requirements.txt

# HuggingFace cache layout:
#   /app/models      — CORE models baked into the image at build time (offline-ready)
#   /app/.hf_cache   — optional/heavy models (Whisper, OCR, Donut); mount as a
#                      volume (docker-compose / Render) so downloads persist.
ENV HF_HOME=/app/.hf_cache
ENV TRANSFORMERS_CACHE=/app/.hf_cache
ENV HUGGINGFACE_HUB_CACHE=/app/.hf_cache/hub
ENV ML_CORE_CACHE=/app/models

# Default models (override via env vars at deploy time)
ENV WHISPER_MODEL=base
ENV OCR_MODEL=microsoft/trocr-large-printed
ENV ML_SENTIMENT_MODEL=ProsusAI/finbert
ENV ML_NER_MODEL=dslim/bert-base-NER
ENV ML_CLASSIFY_MODEL=typeform/distilbert-base-uncased-mnli

COPY . .

# ── Bake the core models into the image at BUILD time ────────────────────────
# This is the key "deploy anywhere" step: the models ship inside the image at
# /app/models, so first boot is instant and works even without internet access.
# Baked to /app/models (NOT /app/.hf_cache) so a mounted cache volume on
# Render/k8s/docker does NOT shadow them.
# The bash retry loop guards against transient network errors (common on
# HuggingFace) so a flaky download doesn't fail the whole build.
# Re-run `docker build --no-cache` to refresh the baked models.
RUN for i in 1 2 3 4 5; do \
      python -c "from main import _load_core; _load_core()" && break; \
      echo "Bake attempt $i failed, retrying in 5s..."; sleep 5; \
    done && \
    [ -n "$(ls -d /app/models/models--*/ 2>/dev/null)" ] \
    && echo "Core models baked into /app/models" \
    || (echo "BAKE FAILED after 5 attempts" && exit 1)

EXPOSE 8000

# Readiness check — only healthy once core models are loaded in memory.
# start_period must be generous for slow disks / first-ever bake.
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
    CMD curl -f http://localhost:8000/ready || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
