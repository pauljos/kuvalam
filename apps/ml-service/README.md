# Kuvalam ML Service

Specialized HuggingFace model tools for the Kuvalam agent platform. Runs as a
standalone FastAPI service. All tools are **optional** — the main API degrades
gracefully if this service is not running.

## Endpoints

| Method | Path              | Purpose                                            |
|--------|-------------------|----------------------------------------------------|
| GET    | `/health`         | Liveness — process is up                            |
| GET    | `/ready`          | Readiness — 503 until core models loaded            |
| POST   | `/warmup`         | Load core models now (blocks until done)            |
| POST   | `/sentiment`      | Financial sentiment (FinBERT)                       |
| POST   | `/entities`       | Named entity extraction (BERT NER)                  |
| POST   | `/classify`       | Zero-shot classification (DistilBERT MNLI)          |
| POST   | `/transcribe`     | Speech-to-text (Whisper)                            |
| POST   | `/ocr`            | OCR (TrOCR)                                         |
| POST   | `/parse_document` | Document extraction (Donut)                         |
| POST   | `/forecast`       | Time-series forecast (Prophet)                      |
| POST   | `/anomaly_detect` | Anomaly detection (Isolation Forest)                |
| POST   | `/image_search`   | CLIP image-text similarity                          |

## Deploy anywhere

The **three core models are baked into the image at build time**, so first boot
is instant and does **not** require internet access:

- `ProsusAI/finbert` (sentiment)
- `dslim/bert-base-NER` (entities)
- `typeform/distilbert-base-uncased-mnli` (zero-shot classify — small & CPU-fast)

Build + run:

```bash
docker build -t kuvalam-ml-service apps/ml-service
docker run -d --name kuvalam-ml-service -p 8001:8000 \
  -v ml_model_cache:/app/.hf_cache \
  kuvalam-ml-service
```

Or via the monorepo compose (profile `ml`):

```bash
docker compose --profile ml up -d ml-service
```

## Configuration (env vars)

| Var                   | Default                                      | Notes                          |
|-----------------------|----------------------------------------------|--------------------------------|
| `ML_SENTIMENT_MODEL`  | `ProsusAI/finbert`                           | Override sentiment model       |
| `ML_NER_MODEL`        | `dslim/bert-base-NER`                        | Override NER model             |
| `ML_CLASSIFY_MODEL`   | `typeform/distilbert-base-uncased-mnli`      | Override zero-shot model       |
| `ML_PREWARM`          | `1`                                          | Set `0` to disable startup prewarm |
| `ML_ALLOWED_ORIGINS`  | `http://localhost:3001,http://api:3001`      | CORS origins (comma-separated) |
| `WHISPER_MODEL`       | `base`                                       | Whisper size                    |
| `OCR_MODEL`           | `microsoft/trocr-large-printed`              | OCR model                       |

Changing a model env var at runtime requires the new model to be available —
either it was baked at build time or the host has internet to download it into
the `ml_model_cache` volume on first request.

## API integration

The main API calls ML tools through the `ML_SERVICE_URL` env var, e.g.:

```
ML_SERVICE_URL=http://ml-service:8000   # inside docker network
ML_SERVICE_URL=http://localhost:8001    # from host (mapped port)
```

ML tool calls in `task.service.js` use a 2-minute timeout with **3 attempts +
backoff**, so a model warming up on first call is retried automatically.
