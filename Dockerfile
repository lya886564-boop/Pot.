FROM python:3.10-slim

# تثبيت curl و gnupg (بدون apt-key)
RUN apt-get update && apt-get install -y curl gnupg && rm -rf /var/lib/apt/lists/*

# إضافة مفتاح Google Cloud بطريقة صحيحة
RUN echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list && \
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg

# تثبيت gcloud CLI
RUN apt-get update && apt-get install -y google-cloud-cli && apt-get clean

WORKDIR /app
COPY bot.py .
RUN pip install pyTelegramBotAPI Flask

CMD ["python", "bot.py"]
