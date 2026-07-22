# Python analytics: FastAPI serving the XGBoost ETA model + weather/311 context.
# Build context is the REPO ROOT (see docker-compose.yml) so this can also copy
# shared/features.json — featurize.py loads it at /app/../shared/features.json,
# i.e. /shared/features.json in the container. Without it every import of
# train_eta (hence app.py) crashes at startup with FileNotFoundError.
FROM python:3.11-slim
WORKDIR /app
# libgomp1: OpenMP runtime XGBoost needs at import time
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY analytics-py/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY analytics-py/*.py ./
# THE feature registry — the single source of truth featurize.feature_spec()
# reads. Lands at /shared/features.json to match the code's ../shared lookup.
COPY shared/features.json /shared/features.json
# Trained model (eta_model.json / eta_features.json) is volume-mounted or trained
# separately; without it /predict returns 503 but weather/context still serve.
EXPOSE 8091
CMD ["python", "app.py"]
