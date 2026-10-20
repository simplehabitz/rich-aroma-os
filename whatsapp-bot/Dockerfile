FROM python:3.12-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# App code (webhook.py, order_engine.py, orders.py, kds_push.py).
COPY server/ ./server/

# Render/Heroku-style port; defaults to 5000 locally.
CMD ["sh", "-c", "gunicorn --chdir server webhook:app --bind 0.0.0.0:${PORT:-5000} --workers 2 --timeout 60"]
