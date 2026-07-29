import os
import re
import subprocess
import json
import time
import telebot
from flask import Flask, request
from telebot.types import Update

# ===================== التوكن =====================
BOT_TOKEN = "8791977458:AAGxGWOru1jCyHJykbK9EQuzoui-RSuegc4"
# =================================================

# إعدادات webhook (سيُطلب منك تعيينها عند النشر)
WEBHOOK_URL = os.getenv("WEBHOOK_URL")  # مثال: https://اسم_البوت.onrender.com/webhook

bot = telebot.TeleBot(BOT_TOKEN)
app = Flask(__name__)

# ========== دوال مساعدة ==========
def extract_project_id(link):
    """استخراج project_id من رابط Google Skills"""
    match = re.search(r'project=([^&]+)', link)
    return match.group(1) if match else None

def enable_apis(project_id):
    """تفعيل Cloud Run و Artifact Registry باستخدام gcloud"""
    subprocess.run(["gcloud", "config", "set", "project", project_id], check=True)
    subprocess.run([
        "gcloud", "services", "enable",
        "cloudrun.googleapis.com",
        "artifactregistry.googleapis.com"
    ], check=True)

def deploy_image(project_id, image="docker.io/ajndjd2/ahmed-vip1", region="us-central1"):
    """نشر الحاوية على Cloud Run واسترجاع الرابط"""
    service_name = "ahmed-vip1"
    # نشر الخدمة
    subprocess.run([
        "gcloud", "run", "deploy", service_name,
        f"--image={image}",
        f"--platform=managed",
        f"--region={region}",
        "--allow-unauthenticated",
        "--quiet"
    ], check=True)

    # الحصول على الرابط
    result = subprocess.run([
        "gcloud", "run", "services", "describe", service_name,
        f"--region={region}",
        "--format=value(status.url)"
    ], capture_output=True, text=True, check=True)
    return result.stdout.strip()

def generate_vless(cloud_run_url):
    """توليد رابط VLESS بالقالب المطلوب"""
    host = cloud_run_url.replace("https://", "")
    uuid = "aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000"
    path = "/Telegram/@AM2_D3/@AHMAD3214"
    return (
        f"vless://{uuid}@{host}:443?"
        f"path={path}&security=tls&encryption=none&host={host}&type=ws&sni={host}"
        f"#@AHMAD3214"
    )

# ========== أوامر البوت ==========
@bot.message_handler(commands=['start'])
def start_handler(message):
    bot.reply_to(message, "👋 أرسل رابط Google Skills لبدء النشر.")

@bot.message_handler(func=lambda m: 'skills.google' in m.text)
def handle_link(message):
    link = message.text.strip()
    chat_id = message.chat.id

    # استخراج project_id
    project_id = extract_project_id(link)
    if not project_id:
        bot.send_message(chat_id, "❌ لم أجد project_id في الرابط.")
        return

    bot.send_message(chat_id, f"✅ تم الاستلام. المشروع: `{project_id}`")
    bot.send_message(chat_id, "🔄 جاري تمكين الخدمات...")

    try:
        enable_apis(project_id)
        bot.send_message(chat_id, "✅ تم تمكين Cloud Run و Artifact Registry.")

        bot.send_message(chat_id, "🐳 جاري نشر الحاوية (قد يستغرق 2-3 دقائق)...")
        url = deploy_image(project_id)
        bot.send_message(chat_id, f"✅ رابط Cloud Run:\n{url}")

        vless = generate_vless(url)
        bot.send_message(chat_id, f"🔗 رابط VLESS:\n{vless}")

        bot.send_message(chat_id, "🎉 تم النشر بنجاح!")

    except Exception as e:
        bot.send_message(chat_id, f"❌ حدث خطأ:\n{str(e)}")

# ========== Flask Webhook ==========
@app.route('/webhook', methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        update = Update.de_json(request.get_data().decode('utf-8'))
        bot.process_new_updates([update])
        return 'OK', 200
    return 'Unsupported Media Type', 415

@app.route('/')
def index():
    return "Bot is running!"

# ========== التشغيل ==========
if __name__ == '__main__':
    # حذف أي webhook سابق وتعيين الجديد
    bot.remove_webhook()
    if WEBHOOK_URL:
        bot.set_webhook(url=WEBHOOK_URL)
    # تشغيل Flask
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
