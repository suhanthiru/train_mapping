# Python analytics: FastAPI serving the XGBoost ETA model + weather/311 context.
FROM python:3.11-slim
WORKDIR /app
# libgomp1: OpenMP runtime XGBoost needs at import time
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
# Trained model (eta_model.json / eta_features.json) is volume-mounted or trained
# separately; without it /predict returns 503 but weather/context still serve.
EXPOSE 8091
CMD ["python", "app.py"]
