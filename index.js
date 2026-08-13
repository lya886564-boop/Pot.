'use strict';

/*
╔══════════════════════════════════════════════╗
║              𝑰𝑻𝑨𝑪𝑯𝑰 BOT                  ║
║        WhatsApp Bot - Stable Edition        ║
╚══════════════════════════════════════════════╝

الإضافات:
🔎 Google Search بدون API Key
⚽ Football + Google fallback
🌤️ Weather + ملاحظات
🕐 الوقت
😂 نكات بدون تكرار
🤖 Gemini ON/OFF
👑 لوحة الإدارة
🛠️ تعطيل / تفعيل الأوامر
📋 قائمة منظمة
*/

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

const {
    askGemini,
    getGeminiStatus,
    setGeminiEnabled,
    clearAllHistories
} = require('./gemini');

const {
    googleSearch
} = require('./search');

/* =========================================================
   CONFIG
========================================================= */

const PORT =
    Number(process.env.PORT || 10000);

const AUTH_DIR =
    process.env.AUTH_DIR || 'itachi_auth';

const OWNER_NUMBER =
    process.env.OWNER_NUMBER || '249120591509';

const ACTIVATION_COMMAND =
    'تفعيل';

const WEATHER_API_KEY =
    String(
        process.env.WEATHER_API_KEY || ''
    ).trim();

const FOOTBALL_API_KEY =
    String(
        process.env.FOOTBALL_API_KEY || ''
    ).trim();

/* =========================================================
   NUMBER NORMALIZATION
========================================================= */

function normalizePhoneNumber(input) {

    if (!input) {
        return '';
    }

    let number =
        String(input)
            .trim()
            .split('@')[0]
            .replace(/\D/g, '');

    if (!number) {
        return '';
    }

    if (number.startsWith('00')) {
        number = number.slice(2);
    }

    if (number.startsWith('0')) {
        number = number.slice(1);
    }

    if (
        number.length === 9 &&
        !number.startsWith('249')
    ) {
        number = '249' + number;
    }

    return number;
}

const OWNER_NUMBER_NORMALIZED =
    normalizePhoneNumber(
        OWNER_NUMBER
    );
const OWNER_ALIASES = new Set([
    '0120591509',
    '120591509',
    '+249120591509',
    '249120591509+',
    '249120591509',

    // WhatsApp LID الخاص بالمالك
    '158270064971804@lid',
    '158270064971804'
].map(normalizePhoneNumber));

OWNER_ALIASES.add(
    OWNER_NUMBER_NORMALIZED
);
/* =========================================================
   GLOBAL STATE
========================================================= */

let sock = null;
let starting = false;
let reconnectTimer = null;

const activatedChats =
    new Set();

const processedMessages =
    new Map();

const botSentMessages =
    new Map();

const chatHistory =
    new Map();

const games =
    new Map();

const temporaryCache =
    new Map();

const weatherCache =
    new Map();

const footballCache =
    new Map();

/*
   الأوامر التي عطّلها الأدمن.
*/
const disabledCommands =
    new Set();

/*
   النكات المستخدمة في كل دردشة.
*/
const usedJokes =
    new Map();

const MAX_HISTORY = 20;
const MAX_GAMES = 80;
const MAX_PROCESSED = 1000;

const PROCESSED_TIMEOUT =
    5 * 60 * 1000;

const BOT_SENT_TIMEOUT =
    5 * 60 * 1000;

const GAME_TIMEOUT =
    10 * 60 * 1000;

const CACHE_TIMEOUT =
    10 * 60 * 1000;

/* =========================================================
   HTTP SERVER - RENDER
========================================================= */

const httpServer =
    http.createServer(
        (req, res) => {

            res.writeHead(
                200,
                {
                    'Content-Type':
                        'application/json; charset=utf-8'
                }
            );

            res.end(
                JSON.stringify({
                    status: 'online',
                    bot: 'ITACHI',
                    connected:
                        Boolean(sock),
                    uptime:
                        process.uptime(),
                    memory:
                        process.memoryUsage().rss
                })
            );
        }
    );

httpServer.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `🌐 HTTP server listening on ${PORT}`
        );
    }
);

/* =========================================================
   OWNER DETECTION
========================================================= */

function isOwnerJid(jid) {

    if (!jid) {
        return false;
    }

    const normalized =
        normalizePhoneNumber(jid);

    if (!normalized) {
        return false;
    }

    return (
        normalized ===
        OWNER_NUMBER_NORMALIZED
        ||
        OWNER_ALIASES.has(
            normalized
        )
    );
}

function getMessageCandidates(message) {

    const key =
        message?.key || {};

    return [
        key.participant,
        key.participantPn,
        key.remoteJidAlt,
        key.senderPn,
        key.senderLid,
        key.remoteJid
    ].filter(Boolean);
}

function isOwnerMessage(message) {

    const key =
        message?.key || {};

    if (
        key.fromMe === true
    ) {
        return true;
    }

    return getMessageCandidates(
        message
    ).some(
        isOwnerJid
    );
}

/* =========================================================
   SENDER / CHAT
========================================================= */

function getSenderJid(message) {

    const key =
        message?.key || {};

    if (
        key.fromMe === true
    ) {
        return OWNER_NUMBER_NORMALIZED;
    }

    return (
        key.participant ||
        key.participantPn ||
        key.remoteJidAlt ||
        key.senderPn ||
        key.remoteJid ||
        ''
    );
}

function getChatId(message) {

    return (
        message?.key?.remoteJid ||
        ''
    );
}

function isGroup(jid) {

    return String(jid || '')
        .endsWith('@g.us');
}

/* =========================================================
   TEXT
========================================================= */

function extractText(message) {

    const msg =
        message?.message;

    if (!msg) {
        return '';
    }

    if (
        typeof msg.conversation ===
        'string'
    ) {
        return msg.conversation.trim();
    }

    if (
        typeof msg.extendedTextMessage
            ?.text === 'string'
    ) {
        return msg.extendedTextMessage
            .text
            .trim();
    }

    if (
        typeof msg.imageMessage
            ?.caption === 'string'
    ) {
        return msg.imageMessage
            .caption
            .trim();
    }

    if (
        typeof msg.videoMessage
            ?.caption === 'string'
    ) {
        return msg.videoMessage
            .caption
            .trim();
    }

    return '';
}

/* =========================================================
   COMMAND PARSER
========================================================= */

function cleanCommand(text) {

    return String(text || '')
        .trim()
        .replace(/^!+/, '')
        .trim();
}

function getCommand(text) {

    const value =
        cleanCommand(text);

    if (!value) {
        return '';
    }

    return value
        .split(/\s+/)[0]
        .toLowerCase();
}

function getArgs(text) {

    const value =
        cleanCommand(text);

    if (!value) {
        return [];
    }

    return value
        .split(/\s+/)
        .slice(1);
}

/* =========================================================
   COMMAND ALIASES
========================================================= */

const COMMAND_ALIASES = {

    menu: 'قائمة',
    commands: 'قائمة',
    help: 'قائمة',

    status: 'فحص',

    ai: 'اسأل',
    gemini: 'اسأل',

    search: 'بحث',
    google: 'بحث',

    weather: 'طقس',

    time: 'الوقت',

    joke: 'نكتة',

    football: 'مباريات',

    matches: 'مباريات',

    xo: 'xo',

    riddle: 'لغز',

    math: 'رياضيات',

    dice: 'نرد',

    coin: 'عملة'
};

function canonicalCommand(command) {

    return (
        COMMAND_ALIASES[command] ||
        command
    );
}

/* =========================================================
   COMMAND DISABLE SYSTEM
========================================================= */

function isCommandDisabled(command) {

    const canonical =
        canonicalCommand(
            command
        );

    return disabledCommands.has(
        canonical
    );
}

function disableCommand(command) {

    const canonical =
        canonicalCommand(
            String(command || '')
                .toLowerCase()
        );

    if (!canonical) {
        return false;
    }

    disabledCommands.add(
        canonical
    );

    return true;
}

function enableCommand(command) {

    const canonical =
        canonicalCommand(
            String(command || '')
                .toLowerCase()
        );

    if (!canonical) {
        return false;
    }

    disabledCommands.delete(
        canonical
    );

    return true;
}

/* =========================================================
   SAFE SEND
========================================================= */

async function safeSend(
    jid,
    text,
    options = {}
) {

    if (
        !sock ||
        !jid ||
        !text
    ) {
        return null;
    }

    try {

        const result =
            await sock.sendMessage(
                jid,
                {
                    text:
                        String(text)
                },
                options
            );

        const messageId =
            result?.key?.id;

        if (messageId) {

            botSentMessages.set(
                messageId,
                Date.now()
            );
        }

        return result;

    } catch (error) {

        console.error(
            '❌ Send error:',
            error.message
        );

        return null;
    }
}

/* =========================================================
   DUPLICATE PROTECTION
========================================================= */

function rememberMessage(messageId) {

    if (!messageId) {
        return true;
    }

    const now =
        Date.now();

    for (
        const [
            id,
            time
        ] of processedMessages
    ) {

        if (
            now - time >
            PROCESSED_TIMEOUT
        ) {
            processedMessages.delete(id);
        }
    }

    if (
        processedMessages.has(
            messageId
        )
    ) {
        return false;
    }

    processedMessages.set(
        messageId,
        now
    );

    if (
        processedMessages.size >
        MAX_PROCESSED
    ) {

        const first =
            processedMessages
                .keys()
                .next()
                .value;

        if (first) {
            processedMessages.delete(
                first
            );
        }
    }

    return true;
}

function isBotSentMessage(
    messageId
) {

    if (!messageId) {
        return false;
    }

    return botSentMessages.has(
        messageId
    );
}

/* =========================================================
   HISTORY
========================================================= */

function addHistory(
    chatId,
    role,
    text
) {

    if (
        !chatId ||
        !text
    ) {
        return;
    }

    let history =
        chatHistory.get(
            chatId
        );

    if (!history) {

        history = [];

        chatHistory.set(
            chatId,
            history
        );
    }

    history.push({
        role,
        parts: [
            {
                text:
                    String(text)
                        .slice(0, 4000)
            }
        ]
    });

    if (
        history.length >
        MAX_HISTORY
    ) {

        history.splice(
            0,
            history.length -
            MAX_HISTORY
        );
    }
}

function getHistory(chatId) {

    return (
        chatHistory.get(chatId) ||
        []
    );
}

/* =========================================================
   CLEANUP
========================================================= */

function clearOldData() {

    const now =
        Date.now();

    for (
        const [
            id,
            game
        ] of games
    ) {

        if (
            !game ||
            now -
            game.updatedAt >
            GAME_TIMEOUT
        ) {
            games.delete(id);
        }
    }

    for (
        const [
            id,
            time
        ] of processedMessages
    ) {

        if (
            now -
            time >
            PROCESSED_TIMEOUT
        ) {
            processedMessages.delete(
                id
            );
        }
    }

    for (
        const [
            id,
            time
        ] of botSentMessages
    ) {

        if (
            now -
            time >
            BOT_SENT_TIMEOUT
        ) {
            botSentMessages.delete(
                id
            );
        }
    }

    for (
        const [
            id,
            data
        ] of temporaryCache
    ) {

        if (
            !data ||
            now -
            data.createdAt >
            CACHE_TIMEOUT
        ) {
            temporaryCache.delete(
                id
            );
        }
    }
}

setInterval(
    clearOldData,
    60 * 1000
).unref();

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function randomItem(array) {

    return array[
        Math.floor(
            Math.random() *
            array.length
        )
    ];
}

function formatBytes(bytes) {

    return `${(
        Number(bytes || 0) /
        1024 /
        1024
    ).toFixed(1)} MB`;
}

function formatUptime(seconds) {

    const total =
        Math.floor(
            Number(seconds || 0)
        );

    const days =
        Math.floor(
            total / 86400
        );

    const hours =
        Math.floor(
            (total % 86400) /
            3600
        );

    const minutes =
        Math.floor(
            (total % 3600) /
            60
        );

    const secs =
        total % 60;

    const parts = [];

    if (days) {
        parts.push(`${days}d`);
    }

    if (hours) {
        parts.push(`${hours}h`);
    }

    if (minutes) {
        parts.push(`${minutes}m`);
    }

    parts.push(`${secs}s`);

    return parts.join(' ');
}

/* =========================================================
   MAIN MENU
========================================================= */

function menu() {

    return `
╭━━━〔 ⚔️ 𝑰𝑻𝑨𝑪𝑯𝑰 〕━━━╮
┃
┃ ① 👑 لوحة الإدارة
┃ ② 🤖 الذكاء الاصطناعي
┃ ③ 🧰 الأدوات
┃ ④ ⚽ كرة القدم
┃ ⑤ 🔎 البحث
┃ ⑥ 🎮 الألعاب
┃ ⑦ 🌤️ الطقس
┃ ⑧ 🎨 الترفيه
┃ ⑨ 📚 المعلومات
┃
╰━━━━━━━━━━━━━━━━━━╯

✨ اكتب:
┃ • قائمة 1
┃ • قائمة 2
┃ • قائمة 3
┃ • قائمة 4
┃ • قائمة 5
┃ • قائمة 6
┃ • قائمة 7
┃ • قائمة 8
┃ • قائمة 9
`;
}

/* =========================================================
   CATEGORY MENUS
========================================================= */

function categoryMenu(number) {

    const menus = {

        '1': `
╭━━━〔 👑 لوحة الإدارة 〕━━━╮
┃ 🔐 للمالك فقط
┃
┃ • لوحة
┃ • حالة
┃ • فحص
┃ • تفريغ
┃ • حذف_أمر <الأمر>
┃ • تفعيل_أمر <الأمر>
┃ • المحذوفات
┃ • gemini on
┃ • gemini off
┃ • gemini حالة
╰━━━━━━━━━━━━━━━━━━━━━━╯
`,

        '2': `
╭━━━〔 🤖 الذكاء الاصطناعي 〕━━━╮
┃
┃ • اسأل <سؤال>
┃ • ai <سؤال>
┃ • ط <سؤال>
┃ • gemini on
┃ • gemini off
┃ • gemini حالة
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯
`,

        '3': `
╭━━━〔 🧰 الأدوات 〕━━━╮
┃
┃ • فحص
┃ • الوقت
┃ • تاريخ
┃ • حظ
┃ • حكمة
┃ • نكتة
┃ • خط
┃ • بحث
┃ • ترجمة
┃ • رقم
┃
╰━━━━━━━━━━━━━━━━━━╯
`,

        '4': `
╭━━━〔 ⚽ كرة القدم 〕━━━╮
┃
┃ • مباريات
┃ • نتائج
┃ • مباراة
┃ • كرة
┃
┃ ⚠️ عند فشل API
┃ يستخدم البحث تلقائيًا.
╰━━━━━━━━━━━━━━━━━━╯
`,

        '5': `
╭━━━〔 🔎 البحث 〕━━━╮
┃
┃ • بحث <كلمة>
┃ • جوجل <كلمة>
┃ • search <كلمة>
┃
┃ 🌐 Google بدون API Key
╰━━━━━━━━━━━━━━━━━━╯
`,

        '6': `
╭━━━〔 🎮 الألعاب 〕━━━╮
┃
┃ • xo
┃ • لغز
┃ • رياضيات
┃ • كلمة
┃ • نرد
┃ • عملة
┃ • حجر
┃ • ورق
┃ • مقص
┃ • تحدي
┃
╰━━━━━━━━━━━━━━━━━━╯
`,

        '7': `
╭━━━〔 🌤️ الطقس 〕━━━╮
┃
┃ • طقس
┃ • طقس بورتسودان
┃ • طقس الخرطوم
┃
┃ 🌡️ يشمل:
┃ الحرارة
┃ الرطوبة
┃ الرياح
┃ الإحساس
┃ الملاحظات
╰━━━━━━━━━━━━━━━━━━╯
`,

        '8': `
╭━━━〔 🎨 الترفيه 〕━━━╮
┃
┃ • نكتة
┃ • حظ
┃ • حكمة
┃ • خط
┃ • حجر
┃ • ورق
┃ • مقص
┃ • نرد
┃ • عملة
╰━━━━━━━━━━━━━━━━━━╯
`,

        '9': `
╭━━━〔 📚 المعلومات 〕━━━╮
┃
┃ • بحث
┃ • الوقت
┃ • تاريخ
┃ • معلومات
┃ • فحص
┃
╰━━━━━━━━━━━━━━━━━━╯
`
    };

    return (
        menus[String(number)] ||
        menu()
    );
}

function commandsMenu() {

    return menu();
}

/* =========================================================
   JOKES - NO REPEAT
========================================================= */

const jokes = [

    '😂 واحد راح للدكتور وقال له: كل ما أشرب شاي عيني توجعني. قال له الدكتور: شيل الملعقة من الكوب.',
    '😂 مدرس سأل طالب: لماذا تأخرت؟ قال: كنت أمشي وراء أبي. قال المدرس: وأين أبوك؟ قال: سبقني.',
    '😂 واحد بخيل جدًا مات، كتبوا على قبره: ممنوع الوقوف.',
    '😂 واحد سأل صاحبه: لماذا الكمبيوتر بردان؟ قال: لأنه فاتح Windows.',
    '😂 مدرس رياضيات خلف ولدين سمّى واحد سِين والثاني صاد.',
    '😂 واحد اشترى ساعة ضد الماء، عطشها.',
    '😂 واحد راح يشتري نظارة، قال للبائع: عندك شيء أشوف به المستقبل؟',
    '😂 واحد قال لصاحبه: أنا سريع جدًا في اتخاذ القرارات. قال له: من متى؟ قال: من زمان.',
    '😂 واحد دخل مطعم وقال: عندكم أكل سريع؟ قالوا نعم. قال: طيب خلّوه يركض لي.',
    '😂 واحد نسي كلمة السر، دخل على نفسه وقال: مين؟',
    '😂 واحد سأل الجوال: ليه بطاريتك تخلص بسرعة؟ قال له: من كثر ما تفتحني.',
    '😂 واحد نام متأخر، صحى لقى نفسه أمس.',
    '😂 واحد اشترى قلم رصاص، رجعه وقال: يكتب بدون حبر!',
    '😂 واحد ذهب للمكتبة وقال: عندكم كتاب كيف تتخلص من التوتر؟ قالت له الموظفة: نعم. قال: ممتاز، أعطيني إياه بسرعة.',
    '😂 واحد قال لصديقه: أنا أحب الهدوء. قال له: طيب ليه تتكلم؟ قال: عشان ما يصير هدوء.',
    '😂 واحد سأل صاحبه: لماذا تضحك وحدك؟ قال: أتذكر نكاتي القديمة.',
    '😂 واحد فتح الثلاجة بالليل وقال لها: لا تخافي، أنا فقط أريد شيئًا باردًا.',
    '😂 واحد دخل اختبار ذكاء، خرج يقول: كان اختبارًا صعبًا جدًا. سألوه: ماذا كان السؤال؟ قال: نسيت.',
    '😂 واحد اشترى كتابًا عن الثقة بالنفس، لم يقرأه لأنه لم يثق بنفسه.',
    '😂 واحد قال لصديقه: عندي ذاكرة قوية جدًا. قال: من متى؟ قال: نسيت.'
];

function getJoke(chatId) {

    if (!usedJokes.has(chatId)) {
        usedJokes.set(
            chatId,
            new Set()
        );
    }

    const used =
        usedJokes.get(chatId);

    /*
       عندما تنتهي كل النكات،
       تبدأ دورة جديدة.
    */
    if (
        used.size >= jokes.length
    ) {
        used.clear();
    }

    const available =
        jokes.filter(
            (_, index) =>
                !used.has(index)
        );

    const index =
        Math.floor(
            Math.random() *
            available.length
        );

    const joke =
        available[index];

    const realIndex =
        jokes.indexOf(joke);

    used.add(realIndex);

    return `
╭━━━〔 😂 نكتة 〕━━━╮

${joke}

╰━━━━━━━━━━━━━━━━━━╯
`;
}

/* =========================================================
   RIDDLES
========================================================= */

const riddles = [

    {
        q: 'ما الشيء الذي له أسنان ولا يعض؟',
        a: 'المشط'
    },

    {
        q: 'ما الشيء الذي كلما أخذت منه كبر؟',
        a: 'الحفرة'
    },

    {
        q: 'ما الشيء الذي يكتب ولا يقرأ؟',
        a: 'القلم'
    },

    {
        q: 'ما الشيء الذي له عين ولا يرى؟',
        a: 'الإبرة'
    },

    {
        q: 'ما الشيء الذي يمشي بلا أرجل ويبكي بلا عيون؟',
        a: 'السحاب'
    },

    {
        q: 'ما الشيء الذي إذا وضعته في الثلاجة لا يبرد؟',
        a: 'الفلفل الحار'
    }
];

const words = [
    'موز',
    'كتاب',
    'مدرسة',
    'كمبيوتر',
    'واتساب',
    'برمجة',
    'نمر',
    'قمر'
];

function normalizeAnswer(text) {

    return String(text || '')
        .toLowerCase()
        .trim()
        .replace(
            /[ًٌٍَُِّْـ]/g,
            ''
        )
        .replace(
            /[^\p{L}\p{N}]+/gu,
            ''
        );
}

function createRiddleGame(chatId) {

    const item =
        randomItem(riddles);

    games.set(
        chatId,
        {
            type: 'riddle',
            answer:
                normalizeAnswer(
                    item.a
                ),
            question:
                item.q,
            updatedAt:
                Date.now()
        }
    );

    return `
╭━━━〔 🧩 لغز 〕━━━╮

${item.q}

✍️ أرسل الإجابة.

╰━━━━━━━━━━━━━━━━━━╯
`;
}

function createWordGame(chatId) {

    const word =
        randomItem(words);

    const index =
        Math.floor(
            Math.random() *
            word.length
        );

    const hidden =
        word.slice(0, index) +
        '＿' +
        word.slice(index + 1);

    games.set(
        chatId,
        {
            type: 'word',
            answer:
                normalizeAnswer(word),
            updatedAt:
                Date.now()
        }
    );

    return `
🔤 الكلمة:

${hidden}

✍️ ما الكلمة؟
`;
}

function createMathGame(chatId) {

    const a =
        Math.floor(
            Math.random() * 20
        ) + 1;

    const b =
        Math.floor(
            Math.random() * 20
        ) + 1;

    const operations = [
        {
            symbol: '+',
            answer:
                a + b
        },
        {
            symbol: '-',
            answer:
                a - b
        },
        {
            symbol: '×',
            answer:
                a * b
        }
    ];

    const operation =
        randomItem(
            operations
        );

    games.set(
        chatId,
        {
            type: 'math',
            answer:
                String(
                    operation.answer
                ),
            updatedAt:
                Date.now()
        }
    );

    return `
🧮 𝑴𝑨𝑻𝑯

${a} ${operation.symbol} ${b} = ؟

✍️ أرسل الإجابة.
`;
}

/* =========================================================
   XO
========================================================= */

function createXoBoard(board) {

    return `
🎮 𝑿𝑶

${board[0]} │ ${board[1]} │ ${board[2]}
──┼───┼──
${board[3]} │ ${board[4]} │ ${board[5]}
──┼───┼──
${board[6]} │ ${board[7]} │ ${board[8]}
`;
}

function checkWinner(board) {

    const wins = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
        [0, 4, 8],
        [2, 4, 6],
        [0, 3, 6],
        [1, 4, 7],
        [2, 5, 8]
    ];

    for (
        const [
            a,
            b,
            c
        ] of wins
    ) {

        if (
            board[a] !== ' ' &&
            board[a] === board[b] &&
            board[b] === board[c]
        ) {
            return board[a];
        }
    }

    if (
        !board.includes(' ')
    ) {
        return 'draw';
    }

    return null;
}

function findComputerMove(board) {

    const empty = [];

    for (
        let i = 0;
        i < board.length;
        i++
    ) {

        if (
            board[i] === ' '
        ) {
            empty.push(i);
        }
    }

    if (!empty.length) {
        return -1;
    }

    for (
        const move of empty
    ) {

        const copy = [
            ...board
        ];

        copy[move] = 'O';

        if (
            checkWinner(copy) === 'O'
        ) {
            return move;
        }
    }

    for (
        const move of empty
    ) {

        const copy = [
            ...board
        ];

        copy[move] = 'X';

        if (
            checkWinner(copy) === 'X'
        ) {
            return move;
        }
    }

    if (
        board[4] === ' '
    ) {
        return 4;
    }

    const corners = [
        0,
        2,
        6,
        8
    ].filter(
        i =>
            board[i] === ' '
    );

    if (corners.length) {
        return randomItem(
            corners
        );
    }

    return randomItem(
        empty
    );
}

function startXo(
    chatId,
    playerJid
) {

    const existing =
        games.get(chatId);

    if (
        existing &&
        existing.type === 'xo'
    ) {
        return '⚠️ توجد لعبة XO نشطة بالفعل.';
    }

    const board = [
        ' ',
        ' ',
        ' ',
        ' ',
        ' ',
        ' ',
        ' ',
        ' ',
        ' '
    ];

    games.set(
        chatId,
        {
            type: 'xo',
            mode: 'computer',
            playerX:
                playerJid,
            board,
            turn:
                playerJid,
            updatedAt:
                Date.now()
        }
    );

    return `
${createXoBoard(
        board.map(
            (x, i) =>
                x === ' '
                    ? String(i + 1)
                    : x
        )
)}

🤖 ضد الكمبيوتر
❌ دورك الآن.

أرسل رقمًا من 1 إلى 9.
`;
}

function playXo(
    chatId,
    senderJid,
    position
) {

    const game =
        games.get(chatId);

    if (
        !game ||
        game.type !== 'xo'
    ) {
        return '⚠️ لا توجد لعبة XO.';
    }

    if (
        game.turn !== senderJid
    ) {
        return '⏳ ليس دورك الآن.';
    }

    const number =
        Number(position);

    if (
        !Number.isInteger(number) ||
        number < 1 ||
        number > 9
    ) {
        return '⚠️ اختر رقمًا من 1 إلى 9.';
    }

    const index =
        number - 1;

    if (
        game.board[index] !== ' '
    ) {
        return '⚠️ الخانة مشغولة.';
    }

    game.board[index] =
        'X';

    game.updatedAt =
        Date.now();

    let winner =
        checkWinner(
            game.board
        );

    if (winner) {

        games.delete(
            chatId
        );

        if (
            winner === 'draw'
        ) {
            return `
${createXoBoard(
                game.board
            )}

🤝 تعادل!
`;
        }

        return `
${createXoBoard(
            game.board
        )}

🏆 فزت!
`;
    }

    const computerMove =
        findComputerMove(
            game.board
        );

    if (
        computerMove >= 0
    ) {
        game.board[
            computerMove
        ] = 'O';
    }

    winner =
        checkWinner(
            game.board
        );

    if (winner) {

        games.delete(
            chatId
        );

        if (
            winner === 'draw'
        ) {
            return `
${createXoBoard(
                game.board
            )}

🤝 تعادل!
`;
        }

        return `
${createXoBoard(
            game.board
        )}

🤖 الكمبيوتر فاز.
`;
    }

    return `
${createXoBoard(
        game.board.map(
            (x, i) =>
                x === ' '
                    ? String(i + 1)
                    : x
        )
    )}

🎯 دورك الآن.
`;
}

/* =========================================================
   WEATHER NOTES
========================================================= */

function weatherNotes(data) {

    const notes = [];

    const temp =
        Number(
            data?.main?.temp
        );

    const feels =
        Number(
            data?.main?.feels_like
        );

    const humidity =
        Number(
            data?.main?.humidity
        );

    const wind =
        Number(
            data?.wind?.speed
        );

    if (temp >= 40 || feels >= 43) {

        notes.push(
            '🥵 حرارة مرتفعة جدًا: تجنب الخروج وقت الظهيرة قدر الإمكان.'
        );

        notes.push(
            '💧 احرص على شرب الماء والبقاء في مكان جيد التهوية.'
        );

    } else if (temp >= 35) {

        notes.push(
            '☀️ الجو حار: يفضل تجنب الشمس المباشرة لفترات طويلة.'
        );
    }

    if (humidity >= 75) {

        notes.push(
            '💦 الرطوبة مرتفعة وقد يزيد الإحساس بالحرارة.'
        );
    }

    if (wind >= 10) {

        notes.push(
            '🌬️ الرياح قوية نسبيًا: انتبه أثناء الخروج.'
        );
    }

    if (
        data?.weather?.[0]?.main ===
        'Rain'
    ) {

        notes.push(
            '🌧️ يوجد احتمال/حالة أمطار: انتبه أثناء التنقل.'
        );
    }

    if (!notes.length) {

        notes.push(
            '✅ الظروف تبدو مناسبة بشكل عام، مع متابعة تغيرات الطقس.'
        );
    }

    return notes;
}

/* =========================================================
   WEATHER
========================================================= */

async function getWeather(city) {

    if (!WEATHER_API_KEY) {

        return `
⚠️ WEATHER_API_KEY غير مضبوط.

أضفه في Environment Variables في Render.
`;
    }

    const requestedCity =
        String(
            city || 'Port Sudan'
        ).trim();

    const isPortSudan =
        normalizeAnswer(
            requestedCity
        ).includes(
            normalizeAnswer(
                'بورتسودان'
            )
        ) ||
        normalizeAnswer(
            requestedCity
        ).includes(
            'portsudan'
        );

    const finalCity =
        isPortSudan
            ? 'Port Sudan, Sudan'
            : requestedCity;

    const cacheKey =
        finalCity.toLowerCase();

    const cached =
        weatherCache.get(
            cacheKey
        );

    if (
        cached &&
        Date.now() -
        cached.time <
        5 * 60 * 1000
    ) {
        return cached.text;
    }

    try {

        const response =
            await axios.get(
                'https://api.openweathermap.org/data/2.5/weather',
                {
                    params: {
                        q:
                            finalCity,
                        appid:
                            WEATHER_API_KEY,
                        units:
                            'metric',
                        lang:
                            'ar'
                    },
                    timeout:
                        10000
                }
            );

        const data =
            response.data;

        const notes =
            weatherNotes(data);

        const text = `
╭━━━〔 🌤️ 𝑾𝑬𝑨𝑻𝑯𝑬𝑹 〕━━━╮
┃ 📍 ${data.name}
┃ 🌡️ الحرارة: ${data.main.temp}°C
┃ 🥵 الإحساس: ${data.main.feels_like}°C
┃ ☁️ ${
            data.weather?.[0]
                ?.description ||
            'غير معروف'
        }
┃ 💧 الرطوبة: ${data.main.humidity}%
┃ 🌬️ الرياح: ${
            data.wind?.speed ||
            0
        } m/s
╰━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━〔 📝 ملاحظات 〕━━━╮
${notes
    .map(
        note =>
            `┃ ${note}`
    )
    .join('\n')}
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;

        weatherCache.set(
            cacheKey,
            {
                text,
                time:
                    Date.now()
            }
        );

        return text;

    } catch (error) {

        console.error(
            'Weather:',
            error.message
        );

        return `
⚠️ تعذر الحصول على بيانات الطقس.

📍 المدينة:
${finalCity}

🔄 حاول مرة أخرى بعد قليل.
`;
    }
}

/* =========================================================
   TIME
========================================================= */

function getPortSudanTime() {

    const now =
        new Date();

    const time =
        new Intl.DateTimeFormat(
            'ar-SD',
            {
                timeZone:
                    'Africa/Khartoum',
                hour:
                    '2-digit',
                minute:
                    '2-digit',
                second:
                    '2-digit',
                hour12:
                    true
            }
        ).format(now);

    const date =
        new Intl.DateTimeFormat(
            'ar-SD',
            {
                timeZone:
                    'Africa/Khartoum',
                weekday:
                    'long',
                year:
                    'numeric',
                month:
                    'long',
                day:
                    'numeric'
            }
        ).format(now);

    return `
╭━━━〔 🕐 الوقت 〕━━━╮
┃ 📍 بورتسودان / السودان
┃ 🕐 ${time}
┃ 📅 ${date}
╰━━━━━━━━━━━━━━━━━━╯
`;
}

/* =========================================================
   FOOTBALL
========================================================= */

async function getFootballFromAPI() {

    if (!FOOTBALL_API_KEY) {
        throw new Error(
            'FOOTBALL_API_KEY missing'
        );
    }

    const response =
        await axios.get(
            'https://v3.football.api-sports.io/fixtures',
            {
                params: {
                    live: 'all'
                },
                headers: {
                    'x-apisports-key':
                        FOOTBALL_API_KEY
                },
                timeout:
                    10000
            }
        );

    const fixtures =
        response.data?.response ||
        [];

    if (
        !fixtures.length
    ) {
        return `
⚽ لا توجد مباريات مباشرة حاليًا.

🔎 سأبحث لك عن أحدث معلومات المباريات...
`;
    }

    const lines =
        fixtures
            .slice(0, 10)
            .map(item => {

                const home =
                    item.teams?.home
                        ?.name ||
                    '?';

                const away =
                    item.teams?.away
                        ?.name ||
                    '?';

                const gh =
                    item.goals?.home ??
                    0;

                const ga =
                    item.goals?.away ??
                    0;

                return `┃ ⚽ ${home} ${gh} - ${ga} ${away}`;
            });

    return `
╭━━━〔 ⚽ 𝑳𝑰𝑽𝑬 〕━━━╮
${lines.join('\n')}
╰━━━━━━━━━━━━━━━━━━╯
`;
}

async function getFootballFromGoogle() {

    const query =
        'مباريات كرة القدم اليوم نتائج المباريات مباشر';

    const result =
        await googleSearch(
            query,
            5
        );

    return `
╭━━━〔 ⚽ نتائج البحث عن المباريات 〕━━━╮

${result}

╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯

ℹ️ تم استخدام Google لأن خدمة كرة القدم غير متاحة حاليًا.
`;
}

async function getFootball() {

    try {

        const text =
            await getFootballFromAPI();

        footballCache.set(
            'matches',
            {
                text,
                time:
                    Date.now()
            }
        );

        return text;

    } catch (error) {

        console.error(
            'Football API:',
            error.message
        );

        return await getFootballFromGoogle();
    }
}

/* =========================================================
   SIMPLE TOOLS
========================================================= */

function randomLuck() {

    return randomItem([
        '🍀 حظك اليوم ممتاز.',
        '✨ يوم جيد لتجربة شيء جديد.',
        '🎯 فرصتك تبدو جيدة.',
        '🌟 الحظ معك اليوم.',
        '🔮 النتيجة عشوائية، استمتع!'
    ]);
}

function randomWisdom() {

    return randomItem([
        '🌿 خطوة صغيرة كل يوم تصنع فرقًا كبيرًا.',
        '💡 التعلم من الخطأ أفضل من تجاهله.',
        '🎯 الوضوح يجعل الطريق أسهل.',
        '🚀 الاستمرار أهم من البداية.',
        '📚 كل سؤال جيد بداية لمعرفة جديدة.'
    ]);
}

/* =========================================================
   ADMIN PANEL
========================================================= */

function adminPanel() {

    return `
╭━━━〔 👑 لوحة الإدارة 〕━━━╮
┃
┃ 🤖 ITACHI CONTROL
┃
┃ • حالة
┃ • فحص
┃ • تفريغ
┃ • المحذوفات
┃
┃ 🔴 حذف أمر
┃ مثال:
┃ حذف_أمر نكتة
┃
┃ 🟢 إعادة أمر
┃ مثال:
┃ تفعيل_أمر نكتة
┃
┃ 🤖 Gemini
┃ • gemini on
┃ • gemini off
┃ • gemini حالة
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
}

function disabledCommandsMenu() {

    if (
        !disabledCommands.size
    ) {
        return `
╭━━━〔 🟢 الأوامر 〕━━━╮
┃ لا توجد أوامر محذوفة.
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
    }

    return `
╭━━━〔 🔴 الأوامر المعطلة 〕━━━╮
${[
        ...disabledCommands
    ]
        .map(
            command =>
                `┃ • ${command}`
        )
        .join('\n')}
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
}

/* =========================================================
   COMMAND HANDLER
========================================================= */

async function handleCommand(
    message,
    chatId,
    sender,
    text
) {

    const rawCommand =
        getCommand(text);

    const command =
        canonicalCommand(
            rawCommand
        );

    const args =
        getArgs(text);

    const owner =
        isOwnerMessage(message);

    /* =====================================================
       ADMIN COMMANDS
    ===================================================== */

    if (
        command === 'لوحة'
    ) {

        if (!owner) {
            return '⛔ لوحة الإدارة للمالك فقط.';
        }

        return adminPanel();
    }

    if (
        command === 'حذف_أمر' ||
        command === 'حذف'
    ) {

        if (!owner) {
            return '⛔ هذا الأمر للمالك فقط.';
        }

        const target =
            args[0];

        if (!target) {
            return `
⚠️ اكتب الأمر.

مثال:
حذف_أمر نكتة
`;
        }

        const ok =
            disableCommand(
                target
            );

        return ok
            ? `🔴 تم تعطيل الأمر: ${target}`
            : '⚠️ تعذر تعطيل الأمر.';
    }

    if (
        command === 'تفعيل_أمر' ||
        command === 'استرجاع'
    ) {

        if (!owner) {
            return '⛔ هذا الأمر للمالك فقط.';
        }

        const target =
            args[0];

        if (!target) {
            return `
⚠️ اكتب الأمر.

مثال:
تفعيل_أمر نكتة
`;
        }

        const ok =
            enableCommand(
                target
            );

        return ok
            ? `🟢 تم تفعيل الأمر: ${target}`
            : '⚠️ تعذر تفعيل الأمر.';
    }

    if (
        command === 'المحذوفات'
    ) {

        if (!owner) {
            return '⛔ هذا الأمر للمالك فقط.';
        }

        return disabledCommandsMenu();
    }

    /* =====================================================
       GEMINI CONTROL
    ===================================================== */

    if (
        rawCommand === 'gemini' ||
        rawCommand === 'جيمناي'
    ) {

        if (!owner) {
            return '⛔ التحكم في Gemini للمالك فقط.';
        }

        const action =
            String(
                args[0] || ''
            ).toLowerCase();

        if (
            action === 'on' ||
            action === 'تشغيل'
        ) {

            setGeminiEnabled(true);

            return '🟢 تم تشغيل Gemini.';
        }

        if (
            action === 'off' ||
            action === 'ايقاف' ||
            action === 'إيقاف'
        ) {

            setGeminiEnabled(false);

            return '🔴 تم إيقاف Gemini.';
        }

        if (
            action === 'حالة' ||
            action === 'status'
        ) {

            const status =
                getGeminiStatus();

            return `
╭━━━〔 🤖 GEMINI 〕━━━╮
┃ التشغيل:
┃ ${
                status.enabled
                    ? '🟢 ON'
                    : '🔴 OFF'
            }
┃
┃ API:
┃ ${
                status.configured
                    ? '🟢 موجود'
                    : '🔴 غير موجود'
            }
┃
┃ النماذج:
┃ ${status.modelCount}
┃
┃ الجلسات:
┃ ${status.historyChats}
╰━━━━━━━━━━━━━━━━━━╯
`;
        }

        return `
🤖 Gemini

• gemini on
• gemini off
• gemini حالة
`;
    }

    /* =====================================================
       ACTIVATION
    ===================================================== */

    if (
        command ===
        ACTIVATION_COMMAND
    ) {

        if (!owner) {
            return '';
        }

        activatedChats.add(
            chatId
        );

        return `
╭━━━〔 🔓 𝑰𝑻𝑨𝑪𝑯𝑰 〕━━━╮
┃
┃ ✅ تم تفعيل البوت
┃
┃ 👑 المطور:
┃ ${OWNER_NUMBER_NORMALIZED}
┃
┃ 🤖 البوت جاهز الآن
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
    }

    /* =====================================================
       DISABLE
    ===================================================== */

    if (
        command === 'تعطيل'
    ) {

        if (!owner) {
            return '⛔ هذا الأمر للمالك فقط.';
        }

        activatedChats.delete(
            chatId
        );

        return '🔒 تم تعطيل البوت في هذه الدردشة.';
    }

    /* =====================================================
       MENU
    ===================================================== */

    if (
        command === 'قائمة'
    ) {

        if (
            args[0] &&
            /^[1-9]$/.test(
                args[0]
            )
        ) {
            return categoryMenu(
                args[0]
            );
        }

        return commandsMenu();
    }

    if (
        command === 'الاوامر' ||
        command === 'أوامر'
    ) {
        return commandsMenu();
    }

    /* =====================================================
       DISABLED COMMAND CHECK
    ===================================================== */

    if (
        isCommandDisabled(
            command
        )
    ) {
        return `
🔴 هذا الأمر معطل حاليًا.

👑 يمكن للمالك إعادته باستخدام:
تفعيل_أمر ${command}
`;
    }

    /* =====================================================
       STATUS
    ===================================================== */

    if (
        command === 'فحص'
    ) {

        const memory =
            process.memoryUsage();

        const aiStatus =
            getGeminiStatus();

        return `
╭━━━〔 🩺 𝑪𝑯𝑬𝑪𝑲 〕━━━╮
┃ 🟢 الحالة: Online
┃ ⏱️ التشغيل: ${
            formatUptime(
                process.uptime()
            )
        }
┃ 🧠 RAM: ${
            formatBytes(
                memory.rss
            )
        }
┃ 🎮 ألعاب: ${games.size}
┃ 💬 جلسات AI: ${
            chatHistory.size
        }
┃ 🔎 البحث: 🟢
┃ ⚽ Football API: ${
            FOOTBALL_API_KEY
                ? '🟢'
                : '🔴 + Google fallback'
        }
┃ 🔑 Gemini: ${
            aiStatus.configured
                ? '🟢'
                : '🔴'
        }
┃ 🔐 التفعيل: ${
            activatedChats.has(
                chatId
            )
                ? '🟢'
                : '🔴'
        }
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
    }

    /* =====================================================
       OWNER STATUS
    ===================================================== */

    if (
        command === 'حالة'
    ) {

        if (!owner) {
            return '⛔ هذا الأمر للمالك فقط.';
        }

        return `
╭━━━〔 👑 𝑶𝑾𝑵𝑬𝑹 〕━━━╮
┃ 👑 المالك:
┃ ${OWNER_NUMBER_NORMALIZED}
┃
┃ 🔐 الدردشة:
┃ ${
            activatedChats.has(
                chatId
            )
                ? '🟢 مفعلة'
                : '🔴 معطلة'
        }
┃
┃ 🎮 الألعاب: ${games.size}
┃ 💬 AI: ${chatHistory.size}
┃ 🔴 معطل: ${
            disabledCommands.size
        }
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
    }

    /* =====================================================
       CLEAN
    ===================================================== */

    if (
        command === 'تفريغ'
    ) {

        if (!owner) {
            return '⛔ هذا الأمر للمالك فقط.';
        }

        games.clear();
        chatHistory.clear();
        temporaryCache.clear();
        weatherCache.clear();
        footballCache.clear();
        usedJokes.clear();

        clearAllHistories();

        return `
╭━━━〔 🧹 𝑪𝑳𝑬𝑨𝑵 〕━━━╮
┃ ✅ تم تنظيف البيانات
┃ 🎮 الألعاب: 0
┃ 💬 الجلسات: 0
┃ 😂 النكات: تم إعادة ضبطها
╰━━━━━━━━━━━━━━━━━━━━╯
`;
    }

    /* =====================================================
       SEARCH
    ===================================================== */

    if (
        command === 'بحث'
    ) {

        const query =
            args.join(' ').trim();

        if (!query) {
            return `
🔎 اكتب ما تريد البحث عنه.

مثال:
بحث أفضل هواتف 2026
`;
        }

        return await googleSearch(
            query,
            5
        );
    }

    /* =====================================================
       WEATHER
    ===================================================== */

    if (
        command === 'طقس'
    ) {

        const city =
            args.join(' ').trim() ||
            'Port Sudan';

        return await getWeather(
            city
        );
    }

    /* =====================================================
       TIME
    ===================================================== */

    if (
        command === 'الوقت'
    ) {

        return getPortSudanTime();
    }

    /* =====================================================
       DATE
    ===================================================== */

    if (
        command === 'تاريخ'
    ) {

        const now =
            new Date();

        return new Intl.DateTimeFormat(
            'ar-SD',
            {
                timeZone:
                    'Africa/Khartoum',
                dateStyle:
                    'full'
            }
        ).format(now);
    }

    /* =====================================================
       FOOTBALL
    ===================================================== */

    if (
        command === 'مباريات' ||
        command === 'مباراة' ||
        command === 'نتائج'
    ) {

        return await getFootball();
    }

    /* =====================================================
       JOKE
    ===================================================== */

    if (
        command === 'نكتة' ||
        command === 'نكته'
    ) {

        return getJoke(
            chatId
        );
    }

    /* =====================================================
       WISDOM / LUCK
    ===================================================== */

    if (
        command === 'حكمة'
    ) {
        return randomWisdom();
    }

    if (
        command === 'حظ'
    ) {
        return randomLuck();
    }

    /* =====================================================
       FONTS
    ===================================================== */

    if (
        command === 'خط'
    ) {

        return `
╭━━━〔 🔤 𝑭𝑶𝑵𝑻𝑺 〕━━━╮

𝑰𝑻𝑨𝑪𝑯𝑰

𝓘𝓣𝓐𝓒𝓗𝓘

𝕀𝕋𝔸ℂℍ𝕀

𝐈𝐓𝐀𝐂𝐇𝐈

𝙄𝙏𝘼𝘾𝙃𝙄

╰━━━━━━━━━━━━━━━━━━╯
`;
    }

    /* =====================================================
       XO
    ===================================================== */

    if (
        command === 'xo' ||
        command === 'اكسو'
    ) {

        return startXo(
            chatId,
            sender
        );
    }

    /* =====================================================
       XO MOVE
    ===================================================== */

    if (
        /^[1-9]$/.test(
            String(text).trim()
        )
    ) {

        const game =
            games.get(chatId);

        if (
            game?.type === 'xo'
        ) {

            return playXo(
                chatId,
                sender,
                text.trim()
            );
        }
    }

    /* =====================================================
       RIDDLE
    ===================================================== */

    if (
        command === 'لغز'
    ) {

        return createRiddleGame(
            chatId
        );
    }

    /* =====================================================
       MATH
    ===================================================== */

    if (
        command === 'رياضيات'
    ) {

        return createMathGame(
            chatId
        );
    }

    /* =====================================================
       WORD
    ===================================================== */

    if (
        command === 'كلمة' ||
        command === 'كلمة_ناقصة'
    ) {

        return createWordGame(
            chatId
        );
    }

    /* =====================================================
       DICE
    ===================================================== */

    if (
        command === 'نرد'
    ) {

        return `
🎲 النتيجة:

${
            Math.floor(
                Math.random() * 6
            ) + 1
        }
`;
    }

    /* =====================================================
       COIN
    ===================================================== */

    if (
        command === 'عملة'
    ) {

        return `
🪙 النتيجة:

${
            Math.random() < 0.5
                ? 'صورة'
                : 'كتابة'
        }
`;
    }

    /* =====================================================
       RPS
    ===================================================== */

    if (
        command === 'حجر' ||
        command === 'ورق' ||
        command === 'مقص'
    ) {

        const bot =
            randomItem([
                'حجر',
                'ورق',
                'مقص'
            ]);

        let result =
            '🤝 تعادل';

        if (
            command !== bot
        ) {

            if (
                (
                    command === 'حجر' &&
                    bot === 'مقص'
                ) ||
                (
                    command === 'ورق' &&
                    bot === 'حجر'
                ) ||
                (
                    command === 'مقص' &&
                    bot === 'ورق'
                )
            ) {
                result =
                    '🏆 فزت!';
            } else {
                result =
                    '🤖 فاز ITACHI!';
            }
        }

        return `
🎮 𝑹𝑷𝑺

👤 أنت: ${command}
🤖 ITACHI: ${bot}

${result}
`;
    }

    /* =====================================================
       AI
    ===================================================== */

    if (
        command === 'اسأل'
    ) {

        const question =
            args.join(' ').trim();

        if (!question) {
            return '🤖 اكتب سؤالك بعد الأمر.';
        }

        const answer =
            await askGemini(
                question,
                chatId
            );

        return `
╭━━━〔 🤖 𝑰𝑻𝑨𝑪𝑯𝑰 𝑨𝑰 〕━━━╮

${answer}

╰━━━━━━━━━━━━━━━━━━━━╯
`;
    }

    return null;
}

/* =========================================================
   GAME ANSWER
========================================================= */

function answerGame(
    chatId,
    sender,
    text
) {

    const game =
        games.get(chatId);

    if (
        !game ||
        game.type === 'xo'
    ) {
        return null;
    }

    game.updatedAt =
        Date.now();

    const answer =
        normalizeAnswer(text);

    if (
        answer ===
        game.answer
    ) {

        games.delete(
            chatId
        );

        return `
🎉 إجابة صحيحة!

🏆 أحسنت يا بطل.
`;
    }

    return `
❌ إجابة غير صحيحة.
💡 حاول مرة أخرى.
`;
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function handleMessage(
    message
) {

    if (!message) {
        return;
    }

    const key =
        message.key || {};

    if (!key.id) {
        return;
    }

    if (
        isBotSentMessage(
            key.id
        )
    ) {
        return;
    }

    if (
        !rememberMessage(
            key.id
        )
    ) {
        return;
    }

    const chatId =
        getChatId(message);

    if (!chatId) {
        return;
    }

    const sender =
        getSenderJid(message);

    const text =
        extractText(message);

    if (!text) {
        return;
    }

    const owner =
        isOwnerMessage(message);

    const clean =
        text.trim();

    console.log(
        `📩 ${clean} | chat=${chatId} | sender=${sender} | owner=${owner} | fromMe=${Boolean(key.fromMe)}`
    );

    /* =====================================================
       ACTIVATION
    ===================================================== */

    if (
        owner &&
        (
            clean === 'تفعيل' ||
            clean === '!تفعيل'
        )
    ) {

        activatedChats.add(
            chatId
        );

        await safeSend(
            chatId,
            `
╭━━━〔 🔓 𝑰𝑻𝑨𝑪𝑯𝑰 〕━━━╮
┃
┃ ✅ تم تفعيل البوت
┃
┃ 👑 المطور:
┃ ${OWNER_NUMBER_NORMALIZED}
┃
┃ 🤖 جاهز الآن
┃
╰━━━━━━━━━━━━━━━━━━╯
`
        );

        return;
    }

    /* =====================================================
       DISABLE
    ===================================================== */

    if (
        owner &&
        (
            clean === 'تعطيل' ||
            clean === '!تعطيل'
        )
    ) {

        activatedChats.delete(
            chatId
        );

        await safeSend(
            chatId,
            '🔒 تم تعطيل البوت في هذه الدردشة.'
        );

        return;
    }

    /* =====================================================
       SECURITY
    ===================================================== */

    if (
        !activatedChats.has(
            chatId
        )
    ) {
        return;
    }

    /* =====================================================
       GAME ANSWER
    ===================================================== */

    const game =
        games.get(chatId);

    if (
        game &&
        game.type !== 'xo' &&
        !clean.startsWith('!')
    ) {

        const response =
            answerGame(
                chatId,
                sender,
                clean
            );

        if (response) {

            await safeSend(
                chatId,
                response
            );

            return;
        }
    }

    /* =====================================================
       XO NUMBER
    ===================================================== */

    if (
        /^[1-9]$/.test(
            clean
        )
    ) {

        const currentGame =
            games.get(chatId);

        if (
            currentGame?.type ===
            'xo'
        ) {

            const response =
                playXo(
                    chatId,
                    sender,
                    clean
                );

            await safeSend(
                chatId,
                response
            );

            return;
        }
    }

    /* =====================================================
       COMMAND
    ===================================================== */

    const response =
        await handleCommand(
            message,
            chatId,
            sender,
            clean
        );

    if (response) {

        await safeSend(
            chatId,
            response
        );

        return;
    }

    /* =====================================================
       DIRECT AI
    ===================================================== */

    if (
        owner &&
        !clean.startsWith('!')
    ) {

        try {

            const status =
                getGeminiStatus();

            if (!status.enabled) {
                return;
            }

            const answer =
                await askGemini(
                    clean,
                    chatId
                );

            await safeSend(
                chatId,
                `
🤖 𝑰𝑻𝑨𝑪𝑯𝑰

${answer}
`
            );

        } catch (error) {

            console.error(
                'Direct AI:',
                error.message
            );
        }
    }
}

/* =========================================================
   START BOT
   الاتصال محفوظ كما هو
========================================================= */

async function startBot() {

    if (starting) {
        return;
    }

    starting = true;

    try {

        console.log(
            '🚀 تشغيل إيتاشي...'
        );

        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                AUTH_DIR
            );

        const {
            version
        } =
            await fetchLatestBaileysVersion();

        sock =
            makeWASocket({
                version,

                auth: {
                    creds:
                        state.creds,

                    keys:
                        makeCacheableSignalKeyStore(
                            state.keys,
                            Pino({
                                level:
                                    'silent'
                            })
                        )
                },

                logger:
                    Pino({
                        level:
                            'silent'
                    }),

                printQRInTerminal:
                    false,

                browser: [
                    'Mac OS',
                    'Chrome',
                    '121.0.0.0'
                ],

                markOnlineOnConnect:
                    false,

                syncFullHistory:
                    false,

                generateHighQualityLinkPreview:
                    false,

                connectTimeoutMs:
                    30000,

                defaultQueryTimeoutMs:
                    30000
            });

        sock.ev.on(
            'creds.update',
            saveCreds
        );

        /* =================================================
           CONNECTION
        ================================================= */

        sock.ev.on(
            'connection.update',
            async update => {

                const {
                    connection,
                    lastDisconnect
                } = update;

                if (
                    connection ===
                    'open'
                ) {

                    starting =
                        false;

                    console.log(
                        '✅ إيتاشي متصل!'
                    );

                    console.log(
                        `👑 Owner: ${OWNER_NUMBER_NORMALIZED}`
                    );

                    return;
                }

                if (
                    connection ===
                    'close'
                ) {

                    starting =
                        false;

                    const code =
                        lastDisconnect
                            ?.error
                            ?.output
                            ?.statusCode;

                    console.log(
                        `⚠️ الاتصال مغلق: ${code || 'unknown'}`
                    );

                    if (
                        code ===
                        DisconnectReason.loggedOut
                    ) {

                        console.log(
                            '❌ تم تسجيل الخروج من واتساب.'
                        );

                        return;
                    }

                    if (
                        reconnectTimer
                    ) {

                        clearTimeout(
                            reconnectTimer
                        );
                    }

                    reconnectTimer =
                        setTimeout(
                            () => {

                                startBot()
                                    .catch(
                                        error =>
                                            console.error(
                                                'Reconnect:',
                                                error.message
                                            )
                                    );

                            },
                            5000
                        );
                }
            }
        );

        /* =================================================
           MESSAGES
        ================================================= */

        sock.ev.on(
            'messages.upsert',
            async event => {

                if (
                    event.type !==
                    'notify'
                ) {
                    return;
                }

                const messages =
                    Array.isArray(
                        event.messages
                    )
                        ? event.messages
                        : [];

                for (
                    const message
                    of messages
                ) {

                    try {

                        await handleMessage(
                            message
                        );

                    } catch (error) {

                        console.error(
                            '❌ Message handler:',
                            error.stack ||
                            error.message
                        );
                    }
                }
            }
        );

        /* =================================================
           PAIRING
        ================================================= */

        if (
            !state.creds.registered
        ) {

            console.log(
                '📱 الحساب غير مرتبط.'
            );

            console.log(
                '🔄 الاتصال بواتساب...'
            );

            await sleep(
                3000
            );

            const pairingCode =
                await sock.requestPairingCode(
                    OWNER_NUMBER_NORMALIZED
                );

            console.log(
                `🔑 كود الربط: ${pairingCode}`
            );

        } else {

            console.log(
                '✅ جلسة WhatsApp موجودة.'
            );

            console.log(
                '🔄 الاتصال بواتساب...'
            );
        }

    } catch (error) {

        starting =
            false;

        console.error(
            '❌ Bot start error:',
            error
        );

        if (
            reconnectTimer
        ) {

            clearTimeout(
                reconnectTimer
            );
        }

        reconnectTimer =
            setTimeout(
                () => {

                    startBot()
                        .catch(
                            err =>
                                console.error(
                                    'Retry:',
                                    err.message
                                )
                        );

                },
                10000
            );
    }
}

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
    'unhandledRejection',
    error => {

        console.error(
            '❌ Unhandled rejection:',
            error
        );
    }
);

process.on(
    'uncaughtException',
    error => {

        console.error(
            '❌ Uncaught exception:',
            error
        );
    }
);

/* =========================================================
   START
========================================================= */

console.log(`
╭────────────────────────────╮
│      𝑰𝑻𝑨𝑪𝑯𝑰 BOT START     │
│ 👑 Owner: ${OWNER_NUMBER_NORMALIZED} │
│ 🔎 Google Search: ON       │
│ 🌤️ Weather: ON             │
│ ⚽ Football fallback: ON   │
│ 😂 No-repeat jokes: ON     │
╰────────────────────────────╯
`);

startBot();
