FROM python:3.11-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY eyeref ./eyeref
RUN useradd --create-home --uid 10001 eyeref && mkdir -p /data && chown eyeref /data
USER eyeref
ENV EYEREF_DATA_DIR=/data EYEREF_DATABASE_URL=sqlite:////data/eyeref.db EYEREF_MODEL_PATH=/models/meridional_mlp.onnx
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')"
CMD ["uvicorn", "eyeref.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
