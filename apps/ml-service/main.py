# apps/ml-service/main.py
# Kuvalam ML Microservice — Specialized HuggingFace model tools
# Runs as a separate service. All tools are OPTIONAL — the main API
# degrades gracefully if this service is not running.
#
# Endpoints:
#   GET  /health                   — liveness check
#   POST /transcribe               — audio transcription (Whisper)
#   POST /sentiment                — financial/general sentiment (FinBERT)
#   POST /entities                 — named entity extraction (BERT NER)
#   POST /classify                 — zero-shot text classification (BART)
#   POST /ocr                      — image OCR (TrOCR)

import os, logging, time, io, base64, requests, threading
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ml-service")

# ── Model registry (lazy-loaded, cached in memory) ───────────────────────────
_models: dict = {}

def get_model(key: str, loader_fn):
    if key not in _models:
        log.info(f"Loading model: {key}")
        t = time.time()
        _models[key] = loader_fn()
        log.info(f"Loaded {key} in {time.time()-t:.1f}s")
    return _models[key]

# ── Core model defaults (CPU-friendly, small & fast) ─────────────────────────
# All defaults are overridable at deploy time via env vars (see README).
# Core models are pre-downloaded into the image at BUILD time (Dockerfile) into
# ML_CORE_CACHE (/app/models) so the service boots offline — "deploy anywhere
# and it just works". Optional/heavy models (Whisper, OCR, Donut) download on
# demand into the normal HF cache (/app/.hf_cache), which is a volume in
# docker-compose / Render so it persists across restarts.
DEFAULT_SENTIMENT_MODEL = os.environ.get("ML_SENTIMENT_MODEL", "ProsusAI/finbert")
DEFAULT_NER_MODEL = os.environ.get("ML_NER_MODEL", "dslim/bert-base-NER")
DEFAULT_CLASSIFY_MODEL = os.environ.get("ML_CLASSIFY_MODEL", "typeform/distilbert-base-uncased-mnli")
ML_CORE_CACHE = os.environ.get("ML_CORE_CACHE", "/app/models")

# Models the service is considered "ready" once loaded.
CORE_TARGETS = [
    (f"sentiment:{DEFAULT_SENTIMENT_MODEL}", "sentiment", DEFAULT_SENTIMENT_MODEL),
    (f"ner:{DEFAULT_NER_MODEL}", "ner", DEFAULT_NER_MODEL),
    (f"classify:{DEFAULT_CLASSIFY_MODEL}", "classify", DEFAULT_CLASSIFY_MODEL),
]

def _load_core():
    """Load the core ML models into memory from the baked cache. Raises on
    failure (fail-fast) so a broken build fails the readiness check.

    cache_dir is passed via `model_kwargs` (→ from_pretrained), NOT as a direct
    pipeline kwarg — some pipelines (e.g. NER) reject `cache_dir` in
    _sanitize_parameters(). This keeps core models on the baked /app/models path
    while optional models (Whisper/OCR) keep using the mounted /app/.hf_cache."""
    from transformers import pipeline
    for key, kind, model in CORE_TARGETS:
        if key in _models:
            continue
        mkw = {"cache_dir": ML_CORE_CACHE}
        if kind == "sentiment":
            loader = lambda m=model: pipeline("text-classification", model=m, top_k=None, device=-1, model_kwargs=mkw)
        elif kind == "ner":
            loader = lambda m=model: pipeline("ner", model=m, aggregation_strategy="simple", device=-1, model_kwargs=mkw)
        else:
            loader = lambda m=model: pipeline("zero-shot-classification", model=m, device=-1, model_kwargs=mkw)
        get_model(key, loader)

# Readiness flag: set once core models are loaded.
_ready = threading.Event()

def prewarm_core():
    """Load core models. Failure is logged but non-fatal (service still serves
    whatever is loaded; /ready reports true only when all core models are up)."""
    try:
        _load_core()
        _ready.set()
        log.info("Prewarm complete — core models ready")
    except Exception as e:
        log.error(f"Prewarm failed: {e}")
        _ready.clear()

# ── Lifespan ─────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("ML Service starting — pre-warming core models")
    if os.environ.get("ML_PREWARM", "1") != "0":
        # Background thread so /health responds immediately while models warm.
        threading.Thread(target=prewarm_core, daemon=True).start()
    yield
    log.info("ML Service shutting down")

app = FastAPI(title="Kuvalam ML Service", version="1.0.0", lifespan=lifespan)

# CORS: default to the API container/dev host. Override via ML_ALLOWED_ORIGINS
# (comma-separated) in production, e.g. "http://api:3001,https://api.example.com".
_allowed = os.environ.get(
    "ML_ALLOWED_ORIGINS",
    "http://localhost:3001,http://api:3001",
).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _allowed if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ── Health / Readiness ───────────────────────────────────────────────────────
@app.get("/health")
def health():
    """Liveness — process is up. Always 200 once the server is serving."""
    return {
        "status": "ok",
        "ready": _ready.is_set(),
        "loaded_models": list(_models.keys()),
        "required_models": [k for k, _, _ in CORE_TARGETS],
    }

@app.get("/ready")
def ready():
    """Readiness — for orchestrators (Docker HEALTHCHECK, k8s). Returns 503
    until all core models are loaded so traffic isn't routed to a warming pod."""
    if _ready.is_set():
        return {"status": "ready", "loaded_models": list(_models.keys())}
    return JSONResponse(
        status_code=503,
        content={"status": "warming", "loaded_models": list(_models.keys())},
    )

@app.post("/warmup")
def warmup():
    """Explicitly load the core models (sentiment, NER, classify) so the
    first agent call doesn't hit a cold-start timeout. Blocks until loaded."""
    prewarm_core()
    return {"status": "ok", "loaded_models": list(_models.keys())}

# ─────────────────────────────────────────────────────────────────────────────
# 1. TRANSCRIBE — Whisper speech-to-text
# ─────────────────────────────────────────────────────────────────────────────
class TranscribeRequest(BaseModel):
    audio_url: Optional[str] = None       # URL to audio file
    audio_base64: Optional[str] = None    # base64-encoded audio bytes
    language: Optional[str] = None        # e.g. "en", "fr" — None = auto-detect

@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    if not req.audio_url and not req.audio_base64:
        raise HTTPException(400, "Provide audio_url or audio_base64")
    try:
        from transformers import pipeline as hf_pipeline
        import tempfile, soundfile as sf, numpy as np

        # Map WHISPER_MODEL (base/small/medium/large) → HuggingFace model ID
        size = os.getenv("WHISPER_MODEL", "base")
        hf_model = f"openai/whisper-{size}"

        pipe = get_model(f"whisper:{size}", lambda: hf_pipeline(
            "automatic-speech-recognition",
            model=hf_model,
            chunk_length_s=30,
            device=-1,  # CPU
        ))

        if req.audio_url:
            resp = requests.get(req.audio_url, timeout=30)
            resp.raise_for_status()
            audio_bytes = resp.content
        else:
            audio_bytes = base64.b64decode(req.audio_base64)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        generate_kwargs = {}
        if req.language:
            generate_kwargs["language"] = req.language

        result = pipe(tmp_path, generate_kwargs=generate_kwargs, return_timestamps=True)
        os.unlink(tmp_path)

        chunks = result.get("chunks") or []
        return {
            "success": True,
            "text": result["text"].strip(),
            "language": req.language or "auto",
            "segments": [{"start": c["timestamp"][0], "end": c["timestamp"][1], "text": c["text"]} for c in chunks if c.get("timestamp")]
        }
    except Exception as e:
        log.error(f"Transcribe error: {e}")
        return {"success": False, "error": str(e)}

# ─────────────────────────────────────────────────────────────────────────────
# 2. SENTIMENT — FinBERT financial sentiment
# ─────────────────────────────────────────────────────────────────────────────
class SentimentRequest(BaseModel):
    texts: list[str]                              # up to 32 texts at once
    model: str = DEFAULT_SENTIMENT_MODEL          # override with any HF sentiment model

@app.post("/sentiment")
def sentiment(req: SentimentRequest):
    if not req.texts:
        raise HTTPException(400, "texts cannot be empty")
    try:
        from transformers import pipeline
        pipe = get_model(f"sentiment:{req.model}", lambda: pipeline(
            "text-classification", model=req.model,
            top_k=None, device=-1
        ))
        results = pipe(req.texts[:32], truncation=True, max_length=512)
        formatted = []
        for scores in results:
            best = max(scores, key=lambda x: x["score"])
            formatted.append({
                "label": best["label"].lower(),
                "score": round(best["score"], 4),
                "all": {s["label"].lower(): round(s["score"], 4) for s in scores}
            })
        return {"success": True, "results": formatted}
    except Exception as e:
        log.error(f"Sentiment error: {e}")
        return {"success": False, "error": str(e)}

# ─────────────────────────────────────────────────────────────────────────────
# 3. ENTITIES — Named Entity Recognition
# ─────────────────────────────────────────────────────────────────────────────
class EntitiesRequest(BaseModel):
    text: str
    model: str = DEFAULT_NER_MODEL

@app.post("/entities")
def entities(req: EntitiesRequest):
    if not req.text.strip():
        raise HTTPException(400, "text cannot be empty")
    try:
        from transformers import pipeline
        pipe = get_model(f"ner:{req.model}", lambda: pipeline(
            "ner", model=req.model,
            aggregation_strategy="simple", device=-1
        ))
        raw = pipe(req.text[:2000])
        # Group by entity type
        grouped: dict = {}
        for ent in raw:
            label = ent["entity_group"]
            if label not in grouped:
                grouped[label] = []
            if ent["word"] not in grouped[label]:
                grouped[label].append(ent["word"])

        return {
            "success": True,
            "entities": grouped,
            "raw": [{"entity": e["entity_group"], "word": e["word"], "score": float(round(float(e["score"]), 3))} for e in raw]
        }
    except Exception as e:
        log.error(f"Entities error: {e}")
        return {"success": False, "error": str(e)}

# ─────────────────────────────────────────────────────────────────────────────
# 4. CLASSIFY — Zero-shot text classification
# ─────────────────────────────────────────────────────────────────────────────
class ClassifyRequest(BaseModel):
    text: str
    labels: list[str]                              # candidate labels
    multi_label: bool = False
    model: str = DEFAULT_CLASSIFY_MODEL

@app.post("/classify")
def classify(req: ClassifyRequest):
    if not req.text.strip():
        raise HTTPException(400, "text cannot be empty")
    if not req.labels:
        raise HTTPException(400, "labels cannot be empty")
    try:
        from transformers import pipeline
        pipe = get_model(f"classify:{req.model}", lambda: pipeline(
            "zero-shot-classification", model=req.model, device=-1
        ))
        result = pipe(req.text[:1024], req.labels, multi_label=req.multi_label)
        return {
            "success": True,
            "best_label": result["labels"][0],
            "best_score": round(result["scores"][0], 4),
            "scores": {l: round(s, 4) for l, s in zip(result["labels"], result["scores"])}
        }
    except Exception as e:
        log.error(f"Classify error: {e}")
        return {"success": False, "error": str(e)}

# ─────────────────────────────────────────────────────────────────────────────
# 5. OCR — Extract text from image
# ─────────────────────────────────────────────────────────────────────────────
class OcrRequest(BaseModel):
    image_url: Optional[str] = None
    image_base64: Optional[str] = None

@app.post("/ocr")
def ocr(req: OcrRequest):
    if not req.image_url and not req.image_base64:
        raise HTTPException(400, "Provide image_url or image_base64")
    try:
        from transformers import TrOCRProcessor, VisionEncoderDecoderModel
        from PIL import Image

        processor = get_model("trocr_processor", lambda: TrOCRProcessor.from_pretrained(
            os.getenv("OCR_MODEL", "microsoft/trocr-large-printed")
        ))
        ocr_model = get_model("trocr_model", lambda: VisionEncoderDecoderModel.from_pretrained(
            os.getenv("OCR_MODEL", "microsoft/trocr-large-printed")
        ))

        if req.image_url:
            resp = requests.get(req.image_url, timeout=30)
            resp.raise_for_status()
            img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        else:
            img = Image.open(io.BytesIO(base64.b64decode(req.image_base64))).convert("RGB")

        import torch
        pixel_values = processor(images=img, return_tensors="pt").pixel_values
        with torch.no_grad():
            generated_ids = ocr_model.generate(pixel_values)
        text = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]

        return {"success": True, "text": text.strip()}
    except Exception as e:
        log.error(f"OCR error: {e}")
        return {"success": False, "error": str(e)}

# ─────────────────────────────────────────────────────────────────────────────
# 6. PARSE DOCUMENT — Donut (invoice / receipt / form structured extraction)
# ─────────────────────────────────────────────────────────────────────────────
class ParseDocRequest(BaseModel):
    image_url: Optional[str] = None
    image_base64: Optional[str] = None
    # "cord-v2" for receipts, "docvqa" for VQA, "rvlcdip" for classification
    task: str = "cord-v2"

@app.post("/parse_document")
def parse_document(req: ParseDocRequest):
    if not req.image_url and not req.image_base64:
        raise HTTPException(400, "Provide image_url or image_base64")
    TASK_MODEL_MAP = {
        "cord-v2":  "naver-clova-ix/donut-base-finetuned-cord-v2",   # receipts
        "docvqa":   "naver-clova-ix/donut-base-finetuned-docvqa",     # VQA
        "rvlcdip":  "naver-clova-ix/donut-base-finetuned-rvlcdip",    # doc classification
    }
    model_name = TASK_MODEL_MAP.get(req.task, TASK_MODEL_MAP["cord-v2"])
    try:
        from transformers import DonutProcessor, VisionEncoderDecoderModel
        from PIL import Image
        import torch, re

        processor = get_model(f"donut_proc:{model_name}", lambda: DonutProcessor.from_pretrained(model_name))
        model     = get_model(f"donut_model:{model_name}", lambda: VisionEncoderDecoderModel.from_pretrained(model_name))

        if req.image_url:
            resp = requests.get(req.image_url, timeout=30)
            resp.raise_for_status()
            img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        else:
            img = Image.open(io.BytesIO(base64.b64decode(req.image_base64))).convert("RGB")

        task_prompt = f"<s_{req.task}>"
        decoder_input_ids = processor.tokenizer(task_prompt, add_special_tokens=False, return_tensors="pt").input_ids
        pixel_values = processor(img, return_tensors="pt").pixel_values

        with torch.no_grad():
            outputs = model.generate(
                pixel_values, decoder_input_ids=decoder_input_ids,
                max_length=model.decoder.config.max_position_embeddings,
                pad_token_id=processor.tokenizer.pad_token_id,
                eos_token_id=processor.tokenizer.eos_token_id,
                use_cache=True, bad_words_ids=[[processor.tokenizer.unk_token_id]],
                return_dict_in_generate=True
            )

        sequence = processor.batch_decode(outputs.sequences)[0]
        sequence = sequence.replace(processor.tokenizer.eos_token, "").replace(processor.tokenizer.pad_token, "")
        sequence = re.sub(r"<.*?>", "", sequence, count=1).strip()
        parsed = processor.token2json(sequence)

        return {"success": True, "task": req.task, "data": parsed, "raw_sequence": sequence}
    except Exception as e:
        log.error(f"Parse document error: {e}")
        return {"success": False, "error": str(e)}

# ─────────────────────────────────────────────────────────────────────────────
# 7. FORECAST — Prophet time-series forecasting
# ─────────────────────────────────────────────────────────────────────────────
class ForecastRequest(BaseModel):
    # List of { "ds": "2024-01-01", "y": 123.4 } rows
    data: list[dict]
    periods: int = 30          # how many future periods to forecast
    freq: str = "D"            # pandas freq: D=daily, W=weekly, MS=monthly start, H=hourly
    include_history: bool = False

@app.post("/forecast")
def forecast(req: ForecastRequest):
    if len(req.data) < 2:
        raise HTTPException(400, "Need at least 2 data points")
    try:
        import pandas as pd
        from prophet import Prophet

        df = pd.DataFrame(req.data)
        if "ds" not in df.columns or "y" not in df.columns:
            raise ValueError("Each row must have 'ds' (date string) and 'y' (numeric value)")
        df["ds"] = pd.to_datetime(df["ds"])
        df["y"] = pd.to_numeric(df["y"])

        m = Prophet(yearly_seasonality="auto", weekly_seasonality="auto", daily_seasonality="auto")
        m.fit(df)

        future = m.make_future_dataframe(periods=req.periods, freq=req.freq, include_history=req.include_history)
        fc = m.predict(future)

        result_cols = ["ds", "yhat", "yhat_lower", "yhat_upper"]
        rows = fc[result_cols].tail(req.periods).to_dict(orient="records")
        # Convert Timestamp to string for JSON serialisation
        for row in rows:
            row["ds"] = str(row["ds"].date()) if hasattr(row["ds"], "date") else str(row["ds"])
            row["yhat"]       = round(float(row["yhat"]), 4)
            row["yhat_lower"] = round(float(row["yhat_lower"]), 4)
            row["yhat_upper"] = round(float(row["yhat_upper"]), 4)

        return {"success": True, "forecast": rows, "periods": req.periods, "freq": req.freq}
    except Exception as e:
        log.error(f"Forecast error: {e}")
        return {"success": False, "error": str(e)}

# ─────────────────────────────────────────────────────────────────────────────
# 8. ANOMALY DETECT — Isolation Forest on tabular/time-series data
# ─────────────────────────────────────────────────────────────────────────────
class AnomalyRequest(BaseModel):
    # List of numeric rows. Each row is a dict of { column: value }.
    # For a single metric time series just use [{"value": 1.2}, {"value": 3.4}, ...]
    data: list[dict]
    contamination: float = 0.05   # expected fraction of anomalies (0.01–0.5)
    label_column: Optional[str] = None  # if set, exclude this column from features

@app.post("/anomaly_detect")
def anomaly_detect(req: AnomalyRequest):
    if len(req.data) < 5:
        raise HTTPException(400, "Need at least 5 data points")
    try:
        import pandas as pd
        from sklearn.ensemble import IsolationForest
        from sklearn.preprocessing import StandardScaler

        df = pd.DataFrame(req.data)
        feature_cols = [c for c in df.columns if c != req.label_column]
        X = df[feature_cols].select_dtypes(include="number").fillna(0)

        if X.empty or X.shape[1] == 0:
            raise ValueError("No numeric columns found in data")

        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)

        clf = IsolationForest(
            contamination=min(max(req.contamination, 0.01), 0.5),
            random_state=42, n_estimators=100
        )
        preds = clf.fit_predict(X_scaled)       # -1 = anomaly, 1 = normal
        scores = clf.score_samples(X_scaled)    # lower = more anomalous

        anomaly_indices = [i for i, p in enumerate(preds) if p == -1]
        results = []
        for i, (pred, score) in enumerate(zip(preds, scores)):
            results.append({
                "index": i,
                "anomaly": bool(pred == -1),
                "score": round(float(score), 4),
                **{k: req.data[i].get(k) for k in feature_cols}
            })

        return {
            "success": True,
            "total": len(req.data),
            "anomaly_count": len(anomaly_indices),
            "anomaly_indices": anomaly_indices,
            "results": results
        }
    except Exception as e:
        log.error(f"Anomaly detect error: {e}")
        return {"success": False, "error": str(e)}

# ─────────────────────────────────────────────────────────────────────────────
# 9. IMAGE SEARCH — CLIP image-text similarity
# ─────────────────────────────────────────────────────────────────────────────
class ImageSearchRequest(BaseModel):
    # Provide either ONE image + multiple texts (image→text search)
    # OR ONE text + multiple images (text→image search)
    text: Optional[str] = None                    # single text query
    texts: Optional[list[str]] = None             # multiple text labels to score
    image_url: Optional[str] = None
    image_base64: Optional[str] = None
    image_urls: Optional[list[str]] = None        # multiple images to rank

@app.post("/image_search")
def image_search(req: ImageSearchRequest):
    try:
        from transformers import CLIPProcessor, CLIPModel
        from PIL import Image
        import torch

        model_name = os.getenv("CLIP_MODEL", "openai/clip-vit-base-patch32")
        clip_model  = get_model(f"clip_model:{model_name}",  lambda: CLIPModel.from_pretrained(model_name))
        clip_proc   = get_model(f"clip_proc:{model_name}",   lambda: CLIPProcessor.from_pretrained(model_name))

        def load_image(url=None, b64=None):
            if url:
                r = requests.get(url, timeout=20); r.raise_for_status()
                return Image.open(io.BytesIO(r.content)).convert("RGB")
            return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")

        # Mode A: one image vs many text labels → returns label probabilities
        if (req.image_url or req.image_base64) and req.texts:
            img = load_image(req.image_url, req.image_base64)
            inputs = clip_proc(text=req.texts, images=img, return_tensors="pt", padding=True)
            with torch.no_grad():
                logits = clip_model(**inputs).logits_per_image
            probs = logits.softmax(dim=1).squeeze().tolist()
            if isinstance(probs, float): probs = [probs]
            scored = sorted(
                [{"label": t, "score": round(p, 4)} for t, p in zip(req.texts, probs)],
                key=lambda x: x["score"], reverse=True
            )
            return {"success": True, "mode": "image_to_labels", "results": scored}

        # Mode B: one text vs many image URLs → returns image ranking
        if req.text and req.image_urls:
            images = [load_image(url=u) for u in req.image_urls[:20]]
            inputs = clip_proc(text=[req.text], images=images, return_tensors="pt", padding=True)
            with torch.no_grad():
                logits = clip_model(**inputs).logits_per_text
            probs = logits.softmax(dim=1).squeeze().tolist()
            if isinstance(probs, float): probs = [probs]
            scored = sorted(
                [{"url": u, "score": round(p, 4)} for u, p in zip(req.image_urls, probs)],
                key=lambda x: x["score"], reverse=True
            )
            return {"success": True, "mode": "text_to_images", "results": scored}

        raise HTTPException(400, "Provide (image_url/image_base64 + texts) OR (text + image_urls)")
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Image search error: {e}")
        return {"success": False, "error": str(e)}
