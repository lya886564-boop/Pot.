import os
import re
import subprocess
import urllib.parse
import telebot
from flask import Flask, request
from telebot.types import Update

BOT_TOKEN = "8791977458:AAGxGWOru1jCyHJykbK9EQuzoui-RSuegc4"
WEBHOOK_URL = os.getenv("WEBHOOK_URL")
bot = telebot.TeleBot(BOT_TOKEN)
app = Flask(__name__)

def extract_project_id(link):
    decoded = urllib.parse.unquote(link)
    match = re.search(r'project=([^&]+)', decoded)
    if match:
        return match.group(1)
    match = re.search(r'continue=.*?[?&]project=([^&]+)', decoded)
    return match.group(1) if match else None

def enable_apis(project_id):
    subprocess.run(["gcloud", "config", "set", "project", project_id], check=True)
    subprocess.run([
        "gcloud", "services", "enable",
        "cloudrun.googleapis.com",
        "artifactregistry.googleapis.com"
    ], check=True)

def deploy_image(project_id, image="docker.io/ajndjd2/ahmed-vip1", region="us-central1"):
    service = "ahmed-vip1"
    subprocess.run([
        "gcloud", "run", "deploy", service,
        f"--image={image}",
        f"--platform=managed",
        f"--region={region}",
        "--allow-unauthenticated",
        "--quiet"
    ], check=True)
    result = subprocess.run([
        "gcloud", "run", "services", "describe", service,
        f"--region={region}",
        "--format=value(status.url)"
    ], capture_output=True, text=True, check=True)
    return result.stdout.strip()

def generate_vless(url):
    host = url.replace("https://", "")
    uuid = "aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000"
    path = "/Telegram/@AM2_D3/@AHMAD3214"
    return f"vless://{uuid}@{host}:443?path={path}&security=tls&encryption=none&host={host}&type=ws&sni={host}#@AHMAD3214"

@bot.message_handler(commands=['start'])
def start(msg):
    bot.reply_to(msg, "👋 أرسل رابط Google Skills لبدء النشر.")

@bot.message_handler(func=lambda m: 'skills.google' in m.text)
def handle(msg):
    link = msg.text.strip()
    chat = msg.chat.id
    project = extract_project_id(link)
    if not project:
        bot.send_message(chat, "❌ لم أجد project_id في الرابط.")
        return
    bot.send_message(chat, f"✅ المشروع: `{project}`")
    try:
        bot.send_message(chat, "🔄 تمكين APIs...")
        enable_apis(project)
        bot.send_message(chat, "🐳 نشر الحاوية...")
        url = deploy_image(project)
        bot.send_message(chat, f"✅ Cloud Run:\n{url}")
        vless = generate_vless(url)
        bot.send_message(chat, f"🔗 VLESS:\n{vless}")
        bot.send_message(chat, "🎉 تم!")
    except Exception as e:
        bot.send_message(chat, f"❌ خطأ: {str(e)}")

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

if __name__ == '__main__':
    bot.remove_webhook()
    if WEBHOOK_URL:
        bot.set_webhook(url=WEBHOOK_URL)
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
