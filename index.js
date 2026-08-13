'use strict';

const http = require('http');
const axios = require('axios');
const Pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const { askGemini, getGeminiStatus } = require('./gemini');
const { googleSearch } = require('./search');

const PORT = Number(process.env.PORT || 10000);
const AUTH_DIR = process.env.AUTH_DIR || 'itachi_auth';
const OWNER = String(process.env.OWNER_NUMBER || '249120591509').replace(/\D/g, '');
const WEATHER_KEY = process.env.WEATHER_API_KEY || '';

let sock = null, starting = false, reconnectTimer = null;
const active = new Set(), seen = new Map(), sent = new Map();
const TTL = 300000;
const commands = new Map();

const jokes = [
  '😂 واحد راح للدكتور وقال: كل ما أشرب شاي عيني توجعني. قال له: شيل الملعقة.',
  '😂 واحد بخيل مات، كتبوا على قبره: ممنوع الوقوف.',
  '😂 مدرس رياضيات خلف ولدين سمّى واحد سين والثاني صاد.',
  '😂 واحد اشترى ساعة ضد الماء، عطشها.',
  '😂 واحد نسي كلمة السر، دخل على نفسه وقال: مين؟',
  '😂 واحد اشترى قلم رصاص ورجعه لأنه يكتب بدون حبر.'
];
const riddles = [
  ['له أسنان ولا يعض','المشط'],['يمشي بلا أرجل ويبكي بلا عيون','السحاب'],
  ['كلما زاد نقص','العمر'],['بحر بلا ماء','الخريطة'],['يلف الغرفة دون حركة','الجدار']
];
const colors = ['أحمر','أزرق','أخضر','أصفر','أسود','أبيض','رمادي','بنفسجي','برتقالي','وردي'];
const countries = ['السودان','مصر','السعودية','الإمارات','قطر','المغرب','العراق','سوريا','لبنان','تونس','الجزائر','ليبيا','الأردن','فلسطين','اليمن','عمان','البحرين','الكويت','موريتانيا','الصومال'];

const ri = (a,b) => Math.floor(Math.random()*(b-a+1))+a;
const pick = a => a[Math.floor(Math.random()*a.length)];
const norm = v => {
  let n=String(v||'').split('@')[0].replace(/\D/g,'');
  if(n.startsWith('00')) n=n.slice(2);
  if(n.startsWith('0')) n=n.slice(1);
  if(n.length===9 && !n.startsWith('249')) n='249'+n;
  return n;
};
function owner(m) {
  if(m?.key?.fromMe) return true;
  return [m?.key?.participant,m?.key?.remoteJidAlt,m?.key?.senderPn,m?.key?.remoteJid]
    .some(x=>norm(x)===norm(OWNER));
}
const jidOf = m => m?.key?.remoteJid || '';
const senderOf = m => { const k=m?.key||{}; return k.participant||k.remoteJidAlt||k.senderPn||k.remoteJid||''; };
function textOf(m) {
  const x=m?.message;if(!x)return '';
  return String(x.conversation||x.extendedTextMessage?.text||x.imageMessage?.caption||x.videoMessage?.caption||'').trim();
}
function once(id) {
  const now=Date.now();
  for(const [k,t] of seen) if(now-t>TTL) seen.delete(k);
  if(seen.has(id)) return false;
  seen.set(id,now); return true;
}
async function send(jid,text) {
  if(!sock||!jid||text===undefined||text===null)return;
  try { const r=await sock.sendMessage(jid,{text:String(text)}); if(r?.key?.id)sent.set(r.key.id,Date.now()); }
  catch(e){ console.error('send:',e.message); }
}
function add(names,fn) { for(const n of names) commands.set(n.toLowerCase(),fn); }
function nowTime(){return new Intl.DateTimeFormat('ar-SD',{timeZone:'Africa/Khartoum',timeStyle:'medium'}).format(new Date());}
function nowDate(){return new Intl.DateTimeFormat('ar-SD',{timeZone:'Africa/Khartoum',dateStyle:'full'}).format(new Date());}

async function weather(city='Khartoum') {
  if(!WEATHER_KEY)return '❌ أضف WEATHER_API_KEY.';
  try {
    const r=await axios.get('https://api.openweathermap.org/data/2.5/weather',
      {params:{q:city,appid:WEATHER_KEY,units:'metric',lang:'ar'},timeout:15000});
    const d=r.data;
    return `🌤️ ${d.name}\n🌡️ ${d.main.temp}°C\n💧 ${d.main.humidity}%\n🌬️ ${d.wind.speed} م/ث\n📋 ${d.weather[0].description}`;
  } catch(e){return '❌ تعذر جلب الطقس.';}
}
async function currency(ctx) {
  const amount=Number(ctx.args[0]), from=ctx.args[1]?.toUpperCase(), to=ctx.args[2]?.toUpperCase();
  if(!amount||!from||!to)return '💱 مثال: عملة_تحويل 100 USD SDG';
  try {
    const r=await axios.get(`https://api.exchangerate-api.com/v4/latest/${from}`,{timeout:15000});
    const rate=r.data.rates[to]; return rate?`💱 ${amount} ${from} = ${(amount*rate).toFixed(2)} ${to}`:'❌ عملة غير معروفة.';
  } catch{return '❌ فشل التحويل.';}
}
function safeCalc(expr) {
  if(!/^[0-9+\-*/().%\s]+$/.test(expr)) return null;
  try { return Function('"use strict";return ('+expr+')')(); } catch { return null; }
}

/* ==================== 100 GENERAL COMMANDS ==================== */
const general = [
 ['menu','القائمة'],['help','مساعدة'],['ping','بينج'],['alive','حي'],['about','نبذة'],
 ['owner','مالك'],['source','مصدر'],['status','حالة'],['uptime','مدة_التشغيل'],['stats','احصائيات'],
 ['system','نظام'],['version','إصدار'],['time','الوقت'],['date','تاريخ'],['joke','نكتة'],
 ['jokes','نكت'],['riddle','لغز'],['random','عشوائي'],['coin','عملة'],['dice','نرد'],
 ['activate','تفعيل'],['deactivate','تعطيل'],['on','تشغيل'],['off','إيقاف'],['clear','تفريغ'],
 ['reset','تصفير'],['ownercheck','فحص_المالك'],['broadcast','اذاعة'],['groupinfo','معلومات_المجموعة'],
 ['grouplink','رابط_المجموعة'],['members','الأعضاء'],['admins','الأدمن'],['tagall','منشن'],
 ['hidetag','مخفي'],['promote','ترقية'],['demote','تنزيل'],['kick','طرد'],['add','اضافة'],
 ['lock','قفل'],['unlock','فتح'],['mute','كتم'],['unmute','الغاء_الكتم'],['setname','تغيير_الاسم'],
 ['setdesc','تغيير_الوصف'],['setphoto','تغيير_الصورة'],['rules','قوانين'],['welcome','ترحيب'],
 ['goodbye','وداع'],['prefix','بادئة'],['language','لغة'],['author','المطور'],['pack','حزمة'],
 ['ai','ذكاء'],['gemini','جيميني'],['ask','اسأل'],['search','بحث'],['google','جوجل'],
 ['youtube','يوتيوب'],['wiki','ويكيبيديا'],['weather','طقس'],['weatherhelp','مساعدة_الطقس'],
 ['calc','حاسبة'],['convert','تحويل'],['currency','عملة_تحويل'],['qr','رمز_QR'],['shorten','اختصار'],
 ['urlcheck','فحص_الرابط'],['ip','ايب'],['location','موقع'],['password','كلمة_مرور'],['wordcount','عدد_كلمات'],
 ['charcount','عدد_حروف'],['age','عمر'],['horoscope','برج'],['timer','مؤقت'],['reminder','تذكير'],
 ['note','ملاحظة'],['choose','اختيار'],['yesno','نعم_لا'],['ball','كرة_سحرية'],['luck','حظ'],
 ['challenge','تحدي'],['contest','مسابقة'],['score','نقاط'],['profile','ملف'],['id','معرف'],
 ['chatid','معرف_الدردشة'],['sender','المرسل'],['botinfo','معلومات_البوت'],['health','صحة'],
 ['memory','ذاكرة_النظام'],['cpu','المعالج'],['platform','منصة'],['node','نسخة_نود'],
 ['commands','الأوامر'],['games','الألعاب'],['tools','الأدوات'],['ping2','بينج2'],['ping3','بينج3']
];
general.forEach(([en,ar],i)=>add([en,ar],async ctx=>{
  switch(en){
    case'menu':case'help':case'commands':return menu();
    case'ping':return'🏓 Pong!';
    case'alive':return'✅ ITACHI يعمل.';
    case'about':return'🤖 ITACHI-MD 2.0\n⚔️ WhatsApp Bot\n🤖 Gemini 3.6 Flash';
    case'owner':return`👑 ${OWNER}`;
    case'source':return'📦 ITACHI-MD';
    case'status':case'health':return`🩺 متصل: ${!!sock}\n🤖 Gemini: ${getGeminiStatus().configured?'🟢':'🔴'}\n⏱️ ${Math.floor(process.uptime())}s`;
    case'uptime':return`⏱️ ${Math.floor(process.uptime())} ثانية`;
    case'stats':return`📊 RAM ${(process.memoryUsage().rss/1048576).toFixed(1)}MB\n⏱️ ${Math.floor(process.uptime())}s`;
    case'system':return`🖥️ ${process.platform}\nNode ${process.version}`;
    case'version':return'📦 2.0.0';
    case'time':return`🕐 ${nowTime()}`;
    case'date':return`📅 ${nowDate()}`;
    case'joke':case'jokes':return pick(jokes);
    case'riddle':return`🧩 ${pick(riddles)[0]}`;
    case'random':return`🎲 ${ri(1,100)}`;
    case'coin':return`🪙 ${Math.random()<.5?'صورة':'كتابة'}`;
    case'dice':return`🎲 ${ri(1,6)}`;
    case'activate':case'on':if(!owner(ctx.message))return'⛔ للمالك فقط';active.add(ctx.chatId);return'✅ تم التفعيل.';
    case'deactivate':case'off':if(!owner(ctx.message))return'⛔ للمالك فقط';active.delete(ctx.chatId);return'🔒 تم التعطيل.';
    case'clear':seen.clear();return'🧹 تم التنظيف.';
    case'ownercheck':return owner(ctx.message)?'👑 أنت المالك.':'⛔ لست المالك.';
    case'broadcast':if(!owner(ctx.message))return'⛔ للمالك فقط';for(const j of active)await send(j,`📢 ${ctx.args.join(' ')}`);return'✅ تم الإرسال.';
    case'groupinfo':if(!ctx.chatId.endsWith('@g.us'))return'❌ للمجموعة فقط';{const g=await sock.groupMetadata(ctx.chatId);return`📱 ${g.subject}\n👥 ${g.participants.length}`;}
    case'grouplink':if(!ctx.chatId.endsWith('@g.us'))return'❌ للمجموعة فقط';return`🔗 https://chat.whatsapp.com/${await sock.groupInviteCode(ctx.chatId)}`;
    case'members':case'admins':return'👥 استخدم منشن لعرض أعضاء المجموعة.';
    case'tagall':if(!ctx.chatId.endsWith('@g.us'))return'❌ للمجموعة فقط';{const g=await sock.groupMetadata(ctx.chatId);return g.participants.map(p=>'@'+p.id.split('@')[0]).join(' ');}
    case'promote':case'demote':case'kick':case'add':case'lock':case'unlock':case'mute':case'unmute':case'setname':case'setdesc':case'setphoto':return'ℹ️ هذا الإصدار يتجنب عمليات الإدارة الخطرة تلقائياً.';
    case'rules':return'📜 احترم الأعضاء ولا ترسل محتوى مزعجاً.';
    case'welcome':return'👋 أهلاً وسهلاً!';
    case'goodbye':return'👋 إلى اللقاء!';
    case'prefix':return'⚙️ البادئة: !';
    case'language':return'🌐 العربية';
    case'author':return'⚔️ ITACHI';
    case'pack':return'📦 ITACHI-MD';
    case'ai':case'gemini':case'ask':return ctx.args.length?askGemini(ctx.args.join(' '),ctx.chatId):'🤖 اكتب سؤالك.';
    case'search':case'google':return ctx.args.length?googleSearch(ctx.args.join(' '),5):'🔎 اكتب البحث.';
    case'youtube':return ctx.args.length?`▶️ https://www.youtube.com/results?search_query=${encodeURIComponent(ctx.args.join(' '))}`:'▶️ اكتب العنوان.';
    case'wiki':return ctx.args.length?`📚 https://ar.wikipedia.org/wiki/${encodeURIComponent(ctx.args.join(' '))}`:'📚 اكتب العنوان.';
    case'weather':return weather(ctx.args.join(' ')||'Khartoum');
    case'calc':{const r=safeCalc(ctx.args.join(' '));return r===null?'❌ تعبير غير صالح.':`🧮 ${r}`;}
    case'convert':{const v=Number(ctx.args[0]),u=ctx.args[1]?.toLowerCase();if(u==='km')return`${v} كم = ${v*1000} متر`;if(u==='m')return`${v} متر = ${v/1000} كم`;if(u==='kg')return`${v} كجم = ${v*1000} جرام`;return'📏 مثال: تحويل 10 km';}
    case'currency':return currency(ctx);
    case'qr':return ctx.args.length?`🔳 https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(ctx.args.join(' '))}&size=300x300`:'🔳 اكتب النص.';
    case'shorten':if(!ctx.args[0])return'🔗 اكتب الرابط.';try{return`🔗 ${await (await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ctx.args[0])}`)).data}`;}catch{return'❌ فشل.';}
    case'urlcheck':if(!ctx.args[0])return'🔍 اكتب الرابط.';try{return`✅ ${(await axios.head(ctx.args[0],{timeout:10000})).status}`;}catch{return'❌ الرابط لا يعمل.';}
    case'ip':try{return`🌐 ${(await axios.get('https://api.ipify.org?format=json')).data.ip}`;}catch{return'❌ فشل.';}
    case'location':return ctx.args.length?`📍 https://www.google.com/maps/search/${encodeURIComponent(ctx.args.join(' '))}`:'📍 اكتب المدينة.';
    case'password':{const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';return'🔐 '+Array.from({length:16},()=>c[ri(0,c.length-1)]).join('');}
    case'wordcount':return`📝 ${ctx.args.join(' ').trim().split(/\s+/).filter(Boolean).length}`;
    case'charcount':return`📝 ${ctx.args.join(' ').length}`;
    case'age':{const y=new Date(ctx.args[0]).getFullYear();return Number.isFinite(y)?`🎂 ${new Date().getFullYear()-y}`:'❌ تاريخ غير صالح.';}
    case'horoscope':return`♈ برج ${ctx.args[0]||'غير محدد'}: يوم جيد.`;
    case'timer':{const s=Math.min(Number(ctx.args[0]||0),60);if(!s)return'⏱️ اكتب الثواني (1-60).';await new Promise(r=>setTimeout(r,s*1000));return`⏱️ انتهى ${s} ثانية.`;}
    case'reminder':return`📝 تذكير: ${ctx.args.join(' ')}`;
    case'note':return`🗒️ ${ctx.args.join(' ')}`;
    case'choose':{const a=ctx.args.join(' ').split('|').filter(Boolean);return a.length>1?`🎯 ${pick(a)}`:'🎯 افصل الخيارات بـ |';}
    case'yesno':return Math.random()<.5?'✅ نعم':'❌ لا';
    case'ball':return`🔮 ${pick(['نعم','لا','ربما','بالتأكيد','حاول لاحقاً'])}`;
    case'luck':return`🍀 ${ri(1,100)}%`;
    case'challenge':return`🔥 ${ctx.args.join(' ')||'تحداك تفوز!'}`;
    case'contest':return'🏆 ما عاصمة السودان؟';
    case'score':return'🏅 نقاطك: 0';
    case'profile':return`👤 المرسل: ${senderOf(ctx.message)}`;
    case'id':case'chatid':return`🆔 ${ctx.chatId}`;
    case'sender':return`👤 ${senderOf(ctx.message)}`;
    case'botinfo':return'⚔️ ITACHI-MD | 100 عام + 50 لعبة + 50 أداة';
    case'memory':return`🧠 ${(process.memoryUsage().rss/1048576).toFixed(1)} MB`;
    case'cpu':return`⚙️ uptime ${Math.floor(process.uptime())}s`;
    case'platform':return`🖥️ ${process.platform}`;
    case'node':return`🟢 ${process.version}`;
    case'games':return'🎮 50 لعبة: !game1 إلى !game50';
    case'tools':return'🧰 50 أداة: !tool1 إلى !tool50';
    default:return`ℹ️ ${ar}`;
  }
}));

/* ==================== 50 GAMES ==================== */
const gameNames = [
 'نرد','عملة','حجر_ورقة_مقص','تخمين_رقم','لغز','كرة_سحرية','عجلة_الحظ','حظك_اليوم','يانصيب','سحب_بطاقة',
 'رمي_نردين','قذف_ثلاث','تخمين_لون','تخمين_دولة','تخمين_كلمة','اختيار_عشوائي','صراع_أرقام','اربح_او_اخسر','تحدي_رياضي','اسم_عشوائي',
 'قصة_عشوائية','مسابقة_سريعة','ذاكرة_سريعة','عد_تنازلي','رقم_زوجي','رقم_فردي','أعلى_أو_أدنى','مضاعف','حظ_الذهب','سؤال_سريع',
 'تحدي_حساب','تحدي_كلمة','تحدي_لون','تحدي_بلد','اختبار_نرد','اختبار_عملة','سباق_أرقام','صيد_النقاط','ضربة_حظ','صندوق_مفاجأة',
 'اختيار_بطاقة','ثلاثة_أرقام','رقم_سري','حرف_عشوائي','حرف_مفقود','كلمة_مخفية','قصة_تكميلية','اختبار_ذاكرة','حجر_ضد_بوت','مباراة_نهاية'
];
gameNames.forEach((n,i)=>add([`game${i+1}`,`لعبة${i+1}`,n],ctx=>{
  if(i===0)return`🎲 ${ri(1,6)}`;
  if(i===1)return`🪙 ${Math.random()<.5?'صورة':'كتابة'}`;
  if(i===2){const u=ctx.args[0]||pick(['حجر','ورقة','مقص']);return`✊ أنت: ${u}\n🤖 البوت: ${pick(['حجر','ورقة','مقص'])}`;}
  if(i===3){const g=Number(ctx.args[0]),s=ri(1,10);return!g?'🎯 خمن 1-10':g===s?'🎉 صحيح!':`❌ ${s}`;}
  if(i===4){const r=pick(riddles);return`🧩 ${r[0]}\n💡 ${r[1]}`;}
  if(i===5)return`🔮 ${pick(['نعم','لا','ربما','بالتأكيد','غير واضح'])}`;
  if(i===6)return`🎡 ${pick(['جائزة','لا شيء','فرصة أخرى','جائزة كبرى'])}`;
  if(i===7)return`🍀 ${ri(1,100)}%`;
  if(i===8)return`🎟️ ${Array.from({length:5},()=>ri(1,50)).join(' - ')}`;
  if(i===9)return`🃏 ${pick(['A♠','K♥','Q♦','J♣','10♠','9♥'])}`;
  if(i===10)return`🎲 ${ri(1,6)} + ${ri(1,6)}`;
  if(i===11)return`🪙 ${[1,2,3].map(x=>`${x}. ${Math.random()<.5?'صورة':'كتابة'}`).join('\\n')}`;
  if(i===12)return`🎨 اللون: ${pick(colors)}`;
  if(i===13)return`🌍 الدولة: ${pick(countries)}`;
  if(i===14)return`🔤 الكلمة: ${pick(['قطة','كلب','كتاب','قمر','شجرة'])}`;
  if(i===15){const a=ctx.args.join(' ').split('|').filter(Boolean);return a.length>1?`🎯 ${pick(a)}`:'🎯 خيارات بـ |';}
  if(i===16){const a=ri(1,100),b=ri(1,100);return`⚔️ ${a} ضد ${b} = ${a===b?'تعادل':a>b?'الأول':'الثاني'}`;}
  if(i===17)return Math.random()<.5?'🎰 ربحت!':'🎰 خسرت!';
  if(i===18){const a=ri(1,10),b=ri(1,10);return`🧮 ${a}+${b}=?`;}
  if(i===19)return`👤 ${pick(['محمد','أحمد','علي','خالد','سارة','فاطمة'])}`;
  if(i===20)return'📖 كان يا ما كان...';
  if(i===21)return'🏆 سؤال: ما عاصمة السودان؟';
  if(i===22)return'🧠 تذكر: ITACHI-50';
  if(i===23)return'⏳ '+Array.from({length:5},(_,x)=>5-x).join(' ');
  if(i===24)return`🔢 ${ri(1,100)*2}`;
  if(i===25)return`🔢 ${ri(1,100)*2+1}`;
  if(i===26)return ri(1,100)>50?'⬆️ أعلى':'⬇️ أدنى';
  if(i===27)return`✖️ ${ri(2,12)} × ${ri(2,12)}`;
  if(i===28)return`🥇 ${ri(1,1000)} نقطة`;
  if(i===29)return`❓ ${pick(['2+2؟','عاصمة السودان؟','لون السماء؟'])}`;
  if(i===30)return`🧮 ${ri(1,20)} × ${ri(1,20)} = ؟`;
  if(i===31)return`🔤 ${pick(['كتاب','قلم','باب','شمس'])}`;
  if(i===32)return`🎨 ${pick(colors)}`;
  if(i===33)return`🌍 ${pick(countries)}`;
  if(i===34)return`🎲 ${ri(1,6)} | ${ri(1,6)}`;
  if(i===35)return`🪙 ${Math.random()<.5?'صورة':'كتابة'}`;
  if(i===36)return`🏁 ${ri(1,100)} - ${ri(1,100)}`;
  if(i===37)return`🎯 +${ri(1,50)} نقطة`;
  if(i===38)return`🍀 ${ri(1,100)}%`;
  if(i===39)return`🎁 ${pick(['ذهبي','فضي','مفاجأة','فارغ'])}`;
  if(i===40)return`🃏 ${pick(['A','K','Q','J'])}`;
  if(i===41)return`🔢 ${ri(100,999)} - ${ri(100,999)} - ${ri(100,999)}`;
  if(i===42)return`🔐 ${ri(1000,9999)}`;
  if(i===43)return`🔤 ${String.fromCharCode(65+ri(0,25))}`;
  if(i===44)return`🧩 _${pick(['اب','كت','م'])}_`;
  if(i===45)return'📖 أكمل القصة بكلمة واحدة.';
  if(i===46)return`🧠 الذاكرة: ${pick(['قمر','نار','بحر','كتاب'])}`;
  if(i===47)return`🪨 ${pick(['حجر','ورقة','مقص'])}`;
  return`🏁 الفائز: ${pick(['أنت','البوت'])}`;
}));

/* ==================== 50 TOOLS ==================== */
const toolNames = [
 'وقت_الأداة','تاريخ_الأداة','طقس_حالي','بحث_جوجل','بحث_يوتيوب','بحث_ويكيبيديا','تحويل_عملات','حاسبة_آمنة','تحويل_كم_متر','تحويل_متر_كم',
 'تحويل_كجم_جرام','تحويل_جرام_كجم','توليد_QR','اختصار_رابط','فحص_رابط_صالح','عنوان_IP','موقع_خريطة','توليد_كلمة_مرور','رقم_عشوائي_مخصص','عداد_كلمات',
 'عداد_حروف','حساب_العمر','برج_اليوم','حالة_البوت','معلومات_النظام','معلومات_السيرفر','ذاكرة_السيرفر','نسخة_نود','منصة_التشغيل','مدة_التشغيل',
 'ملاحظات_الطقس','عنوان_بحث','رابط_يوتيوب','رابط_ويكيبيديا','نسبة_عشوائية','اختيار_من_قائمة','مولد_رمز','مولد_حرف','مولد_لون','مولد_دولة',
 'فحص_رقم','تنسيق_نص','عدد_الأسطر','عكس_نص','تكرار_نص','حروف_كبيرة','حروف_صغيرة','مولد_رقم_سري','معلومات_المالك','قائمة_الأوامر'
];
toolNames.forEach((n,i)=>add([`tool${i+1}`,`أداة${i+1}`,n],async ctx=>{
  const q=ctx.args.join(' ');
  if(i===0)return`🕐 ${nowTime()}`; if(i===1)return`📅 ${nowDate()}`; if(i===2)return weather(q||'Khartoum');
  if(i===3)return q?googleSearch(q,5):'🔎 اكتب البحث.'; if(i===4)return q?`▶️ https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`:'▶️ اكتب العنوان.';
  if(i===5)return q?`📚 https://ar.wikipedia.org/wiki/${encodeURIComponent(q)}`:'📚 اكتب العنوان.'; if(i===6)return currency(ctx);
  if(i===7){const r=safeCalc(q);return r===null?'❌ تعبير غير صالح.':`🧮 ${r}`;} if(i===8)return`📏 ${Number(ctx.args[0]||0)*1000} متر`;
  if(i===9)return`📏 ${Number(ctx.args[0]||0)/1000} كم`; if(i===10)return`📏 ${Number(ctx.args[0]||0)*1000} جرام`;
  if(i===11)return`📏 ${Number(ctx.args[0]||0)/1000} كجم`; if(i===12)return q?`🔳 https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(q)}&size=300x300`:'🔳 اكتب النص.';
  if(i===13){if(!ctx.args[0])return'🔗 اكتب الرابط.';try{return(await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ctx.args[0])}`)).data;}catch{return'❌ فشل.';}}
  if(i===14){try{return`✅ ${(await axios.head(ctx.args[0],{timeout:10000})).status}`;}catch{return'❌ لا يعمل.';}}
  if(i===15){try{return`🌐 ${(await axios.get('https://api.ipify.org?format=json')).data.ip}`;}catch{return'❌ فشل.';}}
  if(i===16)return q?`📍 https://www.google.com/maps/search/${encodeURIComponent(q)}`:'📍 اكتب المكان.';
  if(i===17){const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';return'🔐 '+Array.from({length:20},()=>c[ri(0,c.length-1)]).join('');}
  if(i===18){let a=Number(ctx.args[0]||1),b=Number(ctx.args[1]||100);if(a>b)[a,b]=[b,a];return`🎲 ${ri(a,b)}`;}
  if(i===19)return`📝 ${q.trim().split(/\s+/).filter(Boolean).length}`; if(i===20)return`🔤 ${q.length}`;
  if(i===21){const y=new Date(ctx.args[0]).getFullYear();return Number.isFinite(y)?`🎂 ${new Date().getFullYear()-y}`:'❌ تاريخ.';}
  if(i===22)return`♈ ${ctx.args[0]||'غير محدد'}: يوم جيد.`; if(i===23)return`🩺 ${!!sock?'متصل':'غير متصل'}`;
  if(i===24)return`🖥️ ${process.platform} / ${process.version}`; if(i===25)return`🖥️ ${process.platform} / ${process.version}`;
  if(i===26)return`🧠 ${(process.memoryUsage().rss/1048576).toFixed(1)} MB`; if(i===27)return`🟢 ${process.version}`;
  if(i===28)return`🖥️ ${process.platform}`; if(i===29)return`⏱️ ${Math.floor(process.uptime())}s`;
  if(i===30)return weather(q||'Khartoum'); if(i===31)return`🔎 ${q||'اكتب عنواناً'}`;
  if(i===32)return`▶️ https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`; if(i===33)return`📚 https://ar.wikipedia.org/wiki/${encodeURIComponent(q)}`;
  if(i===34)return`${ri(1,100)}%`; if(i===35){const a=q.split('|').filter(Boolean);return a.length>1?pick(a):'افصل الخيارات بـ |';}
  if(i===36)return`#${ri(100000,999999)}`; if(i===37)return String.fromCharCode(65+ri(0,25)); if(i===38)return pick(colors); if(i===39)return pick(countries);
  if(i===40)return'🔍 استخدم رقم الهاتف بصيغة دولية.'; if(i===41)return q.replace(/\s+/g,' ').trim(); if(i===42)return String(q.split('\\n').length);
  if(i===43)return q.split('').reverse().join(''); if(i===44)return q?`${q} ${q}`:'اكتب النص.';
  if(i===45)return q.toUpperCase(); if(i===46)return q.toLowerCase(); if(i===47)return String(ri(100000,99999999));
  if(i===48)return`👑 ${OWNER}`; return menu();
}));

function menu(){
  return `╭━━━〔 ⚔️ ITACHI-MD 〕━━━╮
┃ 🤖 100 أمر عام
┃ 🎮 50 لعبة: game1..game50
┃ 🧰 50 أداة: tool1..tool50
┃ 🤖 Gemini 3.6 Flash
┃ 🔎 Search • 🌤️ Weather
┃
┃ مثال: !game4 7
┃ مثال: !tool13 hello
╰━━━━━━━━━━━━━━━━━━━━╯`;
}
console.log(`📦 Loaded ${commands.size} unique command names.`);

async function handleCommand(ctx){
  const parts=ctx.text.replace(/^!+/,'').trim().split(/\s+/);
  const c=(parts.shift()||'').toLowerCase();ctx.args=parts;
  const fn=commands.get(c); return fn?fn(ctx):null;
}
async function handleMessage(m){
  const id=m?.key?.id;if(!id||sent.has(id)||!once(id))return;
  const jid=jidOf(m), text=textOf(m);if(!jid||!text)return;
  if(text==='تفعيل'||text==='!تفعيل'){if(owner(m)){active.add(jid);await send(jid,'✅ تم التفعيل.');}return;}
  if(text==='تعطيل'||text==='!تعطيل'){if(owner(m)){active.delete(jid);await send(jid,'🔒 تم التعطيل.');}return;}
  if(!active.has(jid))return;
  const ctx={message:m,chatId:jid,sender:senderOf(m),text};
  try{
    const r=await handleCommand(ctx);
    if(r!==null&&r!==undefined){await send(jid,r);return;}
    if(owner(m)&&!text.startsWith('!')&&getGeminiStatus().enabled)await send(jid,'🤖 '+await askGemini(text,jid));
  }catch(e){console.error('command:',e.stack||e.message);await send(jid,'❌ حدث خطأ داخلي.');}
}

const server=http.createServer((req,res)=>{
  res.writeHead(200,{'content-type':'application/json; charset=utf-8'});
  res.end(JSON.stringify({status:'online',bot:'ITACHI',connected:!!sock,commands:commands.size,uptime:process.uptime()}));
});
server.listen(PORT,'0.0.0.0',()=>console.log(`🌐 HTTP ${PORT}`));

async function startBot(){
  if(starting)return;starting=true;
  try{
    const {state,saveCreds}=await useMultiFileAuthState(AUTH_DIR);
    const {version}=await fetchLatestBaileysVersion();
    sock=makeWASocket({
      version,auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,Pino({level:'silent'}))},
      logger:Pino({level:'silent'}),printQRInTerminal:false,
      browser:['Mac OS','Chrome','121.0.0.0'],markOnlineOnConnect:false,
      syncFullHistory:false,generateHighQualityLinkPreview:false,
      connectTimeoutMs:30000,defaultQueryTimeoutMs:30000
    });
    sock.ev.on('creds.update',saveCreds);
    sock.ev.on('connection.update',async u=>{
      const {connection,lastDisconnect}=u;
      if(connection==='open'){starting=false;console.log(`✅ ITACHI connected | Owner ${OWNER}`);}
      if(connection==='close'){
        starting=false;const code=lastDisconnect?.error?.output?.statusCode;
        if(code===DisconnectReason.loggedOut){console.log('❌ Logged out. Delete auth and pair again.');return;}
        clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>startBot().catch(console.error),5000);
      }
    });
    sock.ev.on('messages.upsert',async e=>{
      if(e.type!=='notify')return;
      for(const m of e.messages||[])try{await handleMessage(m);}catch(x){console.error('message:',x.stack||x.message);}
    });
    if(!state.creds.registered){
      await new Promise(r=>setTimeout(r,3000));
      const code=await sock.requestPairingCode(OWNER);
      console.log('================================');
      console.log(`🔑 PAIRING CODE: ${code}`);
      console.log('📱 WhatsApp > الأجهزة المرتبطة > ربط جهاز');
      console.log('================================');
    }else console.log('✅ Existing WhatsApp session.');
  }catch(e){
    starting=false;console.error('start:',e.stack||e.message);
    clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>startBot().catch(console.error),10000);
  }
}
setInterval(()=>{const n=Date.now();for(const [k,t] of seen)if(n-t>TTL)seen.delete(k);for(const [k,t] of sent)if(n-t>TTL)sent.delete(k);},60000).unref();
process.on('unhandledRejection',e=>console.error('unhandled:',e));
process.on('uncaughtException',e=>console.error('uncaught:',e));
startBot();
