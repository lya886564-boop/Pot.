FROM python:3.10-slim

# تثبيت gcloud CLI
RUN apt-get update && apt-get install -y curl gnupg && \
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list && \
    curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | apt-key --keyring /usr/share/keyrings/cloud.google.gpg add - && \
    apt-get update && apt-get install -y google-cloud-cli && \
    apt-get clean

WORKDIR /app
COPY bot.py .
RUN pip install pyTelegramBotAPI Flask

# متغير البيئة لحساب الخدمة (اختياري، يمكنك تعيينه في Render)
# ENV GOOGLE_APPLICATION_CREDENTIALS=/app/service-account.json

CMD ["python", "bot.py"]
