'use strict';

/*
╔════════════════════════════════════════════════════╗
║                  ⚔️ ITACHI BOT                   ║
║             Stable WhatsApp Edition              ║
╚════════════════════════════════════════════════════╝

المميزات:
• Pairing Code
• لوحة إدارة للمالك فقط
• Gemini AI
• Weather + نصائح
• Football
• Football Google Fallback
• Google Search بدون API Key
• نتائج المباريات من Google عند فشل API
• أدوات
• بحث ويكيبيديا
• ألعاب
• ترفيه
• معلومات
• نكات وحكم بدون تكرار
• ملاحظات بورتسودان للطقس
• ملاحظات الوقت
• حذف أمر
• حذف من القائمة
• حماية من التكرار والـ loops
• HTTP Server لـ Render
• Auto Reconnect
*/

const http = require('http');
const axios = require('axios');
const cheerio = require('cheerio');
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
    clearHistory,
    clearAllHistories
} = require('./gemini');

/* =========================================================
   CONFIG
========================================================= */

const PORT =
    Number(process.env.PORT || 10000);

const OWNER_NUMBER =
    String(
        process.env.OWNER_NUMBER ||
        '249120591509'
    ).replace(/\D/g, '');

const AUTH_DIR =
    process.env.AUTH_DIR ||
    'itachi_auth';

const BOT_NAME =
    process.env.BOT_NAME ||
    'ITACHI';

const WEATHER_API_KEY =
    String(
        process.env.WEATHER_API_KEY || ''
    ).trim();

const FOOTBALL_API_KEY =
    String(
        process.env.FOOTBALL_API_KEY || ''
    ).trim();

const GOOGLE_URL =
    'https://www.google.com/search';

/* =========================================================
   OWNER
========================================================= */

function normalizeNumber(input) {

    let number =
        String(input || '')
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

const OWNER =
    normalizeNumber(
        OWNER_NUMBER
    );

/* =========================================================
   STATE
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

const games =
    new Map();

const weatherCache =
    new Map();

const footballCache =
    new Map();

const searchCache =
    new Map();

const googleCache =
    new Map();

const MAX_PROCESSED = 1500;

const MESSAGE_TIMEOUT =
    5 * 60 * 1000;

const GAME_TIMEOUT =
    10 * 60 * 1000;

/* =========================================================
   CUSTOM MENU / ADMIN STATE
========================================================= */

/*
 * الأوامر التي يستطيع المالك حذفها من القائمة.
 * الحذف هنا يخفي الأمر من القائمة فقط ولا يمسح
 * وظيفة الأمر من الكود.
 */

const removedCommands =
    new Set();

/* =========================================================
   NO REPEAT SYSTEM
========================================================= */

const usedJokes =
    new Set();

const usedWisdoms =
    new Set();

const usedQuotes =
    new Set();

const usedInfos =
    new Set();

const usedLuck =
    new Set();

/* =========================================================
   HTTP SERVER
========================================================= */

const server =
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
                    bot: BOT_NAME,
                    connected: Boolean(sock),
                    uptime:
                        process.uptime()
                })
            );
        }
    );

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `🌐 HTTP Server: ${PORT}`
        );
    }
);

/* =========================================================
   OWNER CHECK
========================================================= */

function isOwnerJid(jid) {

    if (!jid) {
        return false;
    }

    const number =
        normalizeNumber(jid);

    return number === OWNER;
}

function getSender(message) {

    const key =
        message?.key || {};

    if (key.fromMe) {
        return OWNER;
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

function isOwner(message) {

    const key =
        message?.key || {};

    if (key.fromMe) {
        return true;
    }

    const candidates = [
        key.participant,
        key.participantPn,
        key.remoteJidAlt,
        key.senderPn,
        key.remoteJid
    ];

    return candidates.some(
        isOwnerJid
    );
}

/* =========================================================
   CHAT
========================================================= */

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

function getText(message) {

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
        return msg
            .extendedTextMessage
            .text
            .trim();
    }

    if (
        typeof msg.imageMessage
            ?.caption === 'string'
    ) {
        return msg
            .imageMessage
            .caption
            .trim();
    }

    if (
        typeof msg.videoMessage
            ?.caption === 'string'
    ) {
        return msg
            .videoMessage
            .caption
            .trim();
    }

    return '';
}

/* =========================================================
   COMMAND
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

    return value
        ? value.split(/\s+/).slice(1)
        : [];
}

/* =========================================================
   SEND
========================================================= */

async function sendText(
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

        const id =
            result?.key?.id;

        if (id) {

            botSentMessages.set(
                id,
                Date.now()
            );
        }

        return result;

    } catch (error) {

        console.error(
            '❌ Send:',
            error.message
        );

        return null;
    }
}

/* =========================================================
   DUPLICATE PROTECTION
========================================================= */

function alreadyProcessed(id) {

    if (!id) {
        return false;
    }

    const now =
        Date.now();

    for (
        const [
            key,
            time
        ] of processedMessages
    ) {

        if (
            now - time >
            MESSAGE_TIMEOUT
        ) {
            processedMessages.delete(
                key
            );
        }
    }

    if (
        processedMessages.has(id)
    ) {
        return true;
    }

    processedMessages.set(
        id,
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

    return false;
}

/* =========================================================
   NO REPEAT PICKER
========================================================= */

function randomNoRepeat(
    array,
    usedSet
) {

    if (!Array.isArray(array) ||
        !array.length) {
        return '';
    }

    /*
     * عندما تنتهي جميع العناصر:
     * يتم تصفير المجموعة وتبدأ الدورة من جديد.
     */

    if (
        usedSet.size >=
        array.length
    ) {
        usedSet.clear();
    }

    const available =
        array.filter(
            (_, index) =>
                !usedSet.has(index)
        );

    const index =
        available[
            Math.floor(
                Math.random() *
                available.length
            )
        ];

    usedSet.add(index);

    return array[index];
}

/* =========================================================
   MENUS
========================================================= */

function visible(
    command
) {

    return !removedCommands.has(
        String(command)
            .toLowerCase()
    );
}

function mainMenu() {

    const sections = [];

    if (visible('لوحة')) {
        sections.push('┃ ① 👑 لوحة الإدارة');
    }

    if (visible('ذكاء')) {
        sections.push('┃ ② 🤖 الذكاء الاصطناعي');
    }

    if (visible('أدوات')) {
        sections.push('┃ ③ 🧰 الأدوات');
    }

    if (visible('كرة')) {
        sections.push('┃ ④ ⚽ كرة القدم');
    }

    if (visible('بحث')) {
        sections.push('┃ ⑤ 🔎 البحث');
    }

    if (visible('العاب')) {
        sections.push('┃ ⑥ 🎮 الألعاب');
    }

    if (visible('طقس')) {
        sections.push('┃ ⑦ 🌤️ الطقس');
    }

    if (visible('ترفيه')) {
        sections.push('┃ ⑧ 🎨 الترفيه');
    }

    if (visible('معلومات')) {
        sections.push('┃ ⑨ 📚 المعلومات');
    }

    return `
╭━━━〔 ⚔️ 𝑰𝑻𝑨𝑪𝑯𝑰 〕━━━╮
┃
${sections.join('\n')}
┃
╰━━━━━━━━━━━━━━━━━━╯

✦ أرسل الرقم للدخول للقسم
✦ أو اكتب: قائمة
`;
}

function adminMenu() {

    return `
╭━━━〔 👑 لوحة الإدارة 〕━━━╮
┃
┃ ① 🔓 تفعيل
┃ ② 🔒 تعطيل
┃ ③ 🩺 حالة البوت
┃ ④ 🤖 حالة Gemini
┃ ⑤ 🟢 تشغيل Gemini
┃ ⑥ 🔴 إيقاف Gemini
┃ ⑦ 🧹 مسح ذاكرة AI
┃ ⑧ 🗑️ تنظيف الذاكرة
┃ ⑨ 📊 الإحصائيات
┃
┃ 🗑️ حذف أمر
┃ مثال:
┃ حذف امر نكتة
┃
┃ 📋 حذف من القائمة
┃ مثال:
┃ حذف من القائمة نكتة
┃
┃ ♻️ استعادة من القائمة
┃ مثال:
┃ استعادة من القائمة نكتة
┃
╰━━━━━━━━━━━━━━━━━━━━╯
`;
}

function aiMenu() {

    return `
╭━━━〔 🤖 الذكاء الاصطناعي 〕━━━╮
┃
┃ • ط سؤالك
┃ • ai سؤالك
┃ • اسأل سؤالك
┃
┃ • نسيان
┃   لمسح ذاكرة هذه الدردشة
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
}

function toolsMenu() {

    return `
╭━━━〔 🧰 الأدوات 〕━━━╮
┃
┃ • فحص
┃ • وقت
┃ • تاريخ
┃ • حظ
┃ • حكمة
┃ • نرد
┃ • عملة
┃ • خط
┃ • رقم
┃ • منشن
┃ • معرف
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
}

function footballMenu() {

    return `
╭━━━〔 ⚽ كرة القدم 〕━━━╮
┃
┃ • مباريات
┃ • مباشر
┃ • أهداف
┃ • نتائج
┃ • مباريات اليوم
┃
┃ إذا تعذر API:
┃ 🔎 يستخدم Google تلقائيًا
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
}

function searchMenu() {

    return `
╭━━━〔 🔎 البحث 〕━━━╮
┃
┃ • بحث اسم
┃ • ويكيبيديا اسم
┃
┃ مثال:
┃ بحث محمد صلاح
┃
┃ 🔎 Google يعمل بدون API Key
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
}

function gamesMenu() {

    return `
╭━━━〔 🎮 الألعاب 〕━━━╮
┃
┃ • xo
┃ • لغز
┃ • رياضيات
┃ • كلمة
┃ • لاعب
┃ • فريق
┃ • انمي
┃ • حجر
┃ • ورق
┃ • مقص
┃ • نرد
┃ • عملة
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
}

function entertainmentMenu() {

    return `
╭━━━〔 🎨 الترفيه 〕━━━╮
┃
┃ • حظ
┃ • حكمة
┃ • نكتة
┃ • اقتباس
┃ • سؤال
┃ • تحدي
┃
┃ ♻️ النكات والحكم لا تتكرر
┃ حتى تنتهي المجموعة.
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
}

function informationMenu() {

    return `
╭━━━〔 📚 المعلومات 〕━━━╮
┃
┃ • معلومات
┃ • معلومة
┃ • تعريف اسم
┃ • بوت
┃ • المطور
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
}

/* =========================================================
   DATA
========================================================= */

const riddles = [
    ['ما الشيء الذي له أسنان ولا يعض؟', 'المشط'],
    ['ما الشيء الذي كلما أخذت منه كبر؟', 'الحفرة'],
    ['ما الشيء الذي يكتب ولا يقرأ؟', 'القلم'],
    ['ما الشيء الذي له عين ولا يرى؟', 'الإبرة'],
    ['ما الشيء الذي يمشي بلا أرجل؟', 'الوقت']
];

const words = [
    'برمجة',
    'واتساب',
    'كمبيوتر',
    'مدرسة',
    'كتاب',
    'قمر',
    'نمر',
    'موز'
];

const players = [
    'ميسي',
    'رونالدو',
    'نيمار',
    'صلاح',
    'مبابي'
];

const teams = [
    'برشلونة',
    'ريال مدريد',
    'ليفربول',
    'الهلال',
    'المريخ'
];

const anime = [
    'ناروتو',
    'ساسكي',
    'إيتاتشي',
    'لوفي',
    'غوكو',
    'تانجيرو'
];

const jokes = [
    '😂 واحد دخل البرمجة... طلع له Bug وقال: هذا كان متوقع.',
    '😂 الكمبيوتر قال للمبرمج: عندي مشكلة، المبرمج قال: نفس الشيء.',
    '😂 لماذا المبرمج يفضل الظلام؟ لأنه يحب الـ Dark Mode.',
    '😂 مبرمج راح للدكتور وقال له: عندي مشكلة في الذاكرة... الدكتور قال: منذ متى؟ قال: منذ متى ماذا؟',
    '😂 قالوا للمبرمج: لماذا لا تنام؟ قال: عندي Bug ما يخليني أرتاح.',
    '😂 واحد سأل المبرمج: تعرف Java؟ قال: أعرفها، بس أفضل JavaScript.',
    '😂 المبرمج إذا زعل ما يقول أنا زعلان... يقول: عندي Exception.',
    '😂 سألت الكمبيوتر: لماذا أنت بطيء؟ قال: عندي Processes كثيرة في حياتي.'
];

const wisdoms = [
    '🌱 الاستمرار أهم من السرعة.',
    '💡 الخطأ فرصة للتعلم.',
    '🎯 الهدف الواضح يجعل الطريق أسهل.',
    '📚 كل يوم فرصة لتعلم شيء جديد.',
    '🚀 لا تجعل البداية الصغيرة تمنعك من الاستمرار.',
    '🌟 النجاح غالبًا نتيجة خطوات صغيرة متكررة.',
    '🧠 التعلم المستمر أقوى من الحفظ المؤقت.',
    '🔥 لا تقارن بدايتك بنهاية شخص آخر.'
];

const quotes = [
    '✨ لا تتوقف عن التعلم.',
    '🌟 البداية الصغيرة أفضل من عدم البداية.',
    '🔥 الاستمرار يصنع الفرق.',
    '💡 المعرفة قوة عندما تستخدمها بشكل صحيح.',
    '🚀 كل إنجاز كبير بدأ بخطوة صغيرة.',
    '🌱 الوقت والاستمرار يصنعان نتائج كبيرة.'
];

const infos = [
    '🧠 الدماغ البشري يحتوي على مليارات الخلايا العصبية.',
    '🌍 الأرض تدور حول الشمس.',
    '💻 JavaScript يمكن تشغيلها على الخادم باستخدام Node.js.',
    '⚡ البرق يمكن أن يكون شديد الحرارة مقارنة بالهواء المحيط.',
    '🌊 معظم سطح الأرض مغطى بالمياه.',
    '🌙 القمر يعكس ضوء الشمس ولا يصدر ضوءه بنفسه.'
];

const luckMessages = [
    '🍀 حظك اليوم ممتاز.',
    '✨ فرصة جيدة أمامك.',
    '🎯 يبدو أن يومك يحمل مفاجأة.',
    '🌟 الحظ معك اليوم.',
    '🔮 النتيجة عشوائية، استمتع!',
    '🍀 يوم مناسب للمحاولة من جديد.',
    '✨ ربما تحصل على نتيجة أفضل مما تتوقع.'
];

/* =========================================================
   NORMALIZE
========================================================= */

function normalizeText(text) {

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

/* =========================================================
   RIDDLE
========================================================= */

function startRiddle(chatId) {

    const item =
        riddles[
            Math.floor(
                Math.random() *
                riddles.length
            )
        ];

    games.set(
        chatId,
        {
            type: 'riddle',
            answer:
                normalizeText(item[1]),
            updatedAt:
                Date.now()
        }
    );

    return `
╭━━━〔 🧩 لغز 〕━━━╮
┃
┃ ${item[0]}
┃
┃ ✍️ أرسل الإجابة
╰━━━━━━━━━━━━━━━━╯
`;
}

/* =========================================================
   WORD
========================================================= */

function startWord(chatId) {

    const word =
        words[
            Math.floor(
                Math.random() *
                words.length
            )
        ];

    const index =
        Math.floor(
            Math.random() *
            word.length
        );

    const hidden =
        word.substring(0, index) +
        '＿' +
        word.substring(index + 1);

    games.set(
        chatId,
        {
            type: 'word',
            answer:
                normalizeText(word),
            updatedAt:
                Date.now()
        }
    );

    return `
╭━━━〔 🔤 كلمة ناقصة 〕━━━╮
┃
┃ الكلمة:
┃ ${hidden}
┃
┃ ✍️ أكمل الكلمة
╰━━━━━━━━━━━━━━━━━━━━╯
`;
}

/* =========================================================
   MATH
========================================================= */

function startMath(chatId) {

    const a =
        Math.floor(
            Math.random() * 30
        ) + 1;

    const b =
        Math.floor(
            Math.random() * 30
        ) + 1;

    const operations = [
        {
            text: `${a} + ${b}`,
            answer: a + b
        },
        {
            text: `${a} - ${b}`,
            answer: a - b
        },
        {
            text: `${a} × ${b}`,
            answer: a * b
        }
    ];

    const op =
        operations[
            Math.floor(
                Math.random() *
                operations.length
            )
        ];

    games.set(
        chatId,
        {
            type: 'math',
            answer:
                String(op.answer),
            updatedAt:
                Date.now()
        }
    );

    return `
╭━━━〔 🧮 تحدي الرياضيات 〕━━━╮
┃
┃ ${op.text} = ؟
┃
┃ ✍️ أرسل الناتج
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
}

/* =========================================================
   XO
========================================================= */

function boardText(board) {

    return `
${board[0]} │ ${board[1]} │ ${board[2]}
──┼───┼──
${board[3]} │ ${board[4]} │ ${board[5]}
──┼───┼──
${board[6]} │ ${board[7]} │ ${board[8]}
`;
}

function winner(board) {

    const wins = [
        [0,1,2],
        [3,4,5],
        [6,7,8],
        [0,3,6],
        [1,4,7],
        [2,5,8],
        [0,4,8],
        [2,4,6]
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

function computerMove(board) {

    const empty = [];

    for (
        let i = 0;
        i < 9;
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
        const index of empty
    ) {

        const copy =
            [...board];

        copy[index] = 'O';

        if (
            winner(copy) === 'O'
        ) {
            return index;
        }
    }

    for (
        const index of empty
    ) {

        const copy =
            [...board];

        copy[index] = 'X';

        if (
            winner(copy) === 'X'
        ) {
            return index;
        }
    }

    if (
        board[4] === ' '
    ) {
        return 4;
    }

    return empty[
        Math.floor(
            Math.random() *
            empty.length
        )
    ];
}

function startXO(
    chatId,
    sender
) {

    games.set(
        chatId,
        {
            type: 'xo',
            board: [
                ' ',
                ' ',
                ' ',
                ' ',
                ' ',
                ' ',
                ' ',
                ' ',
                ' '
            ],
            player: sender,
            updatedAt:
                Date.now()
        }
    );

    const display =
        [
            '1',
            '2',
            '3',
            '4',
            '5',
            '6',
            '7',
            '8',
            '9'
        ];

    return `
╭━━━〔 🎮 XO 〕━━━╮
┃
${boardText(display)}
┃
┃ ❌ أنت
┃ ⭕ ITACHI
┃
┃ أرسل رقم الخانة
╰━━━━━━━━━━━━━━━━╯
`;
}

function playXO(
    chatId,
    sender,
    position
) {

    const game =
        games.get(chatId);

    if (
        !game ||
        game.type !== 'xo'
    ) {
        return '❌ لا توجد لعبة XO.';
    }

    if (
        game.player !== sender
    ) {
        return '⛔ هذه اللعبة ليست لك.';
    }

    const index =
        Number(position) - 1;

    if (
        index < 0 ||
        index > 8
    ) {
        return '❌ اختر رقمًا من 1 إلى 9.';
    }

    if (
        game.board[index] !== ' '
    ) {
        return '⚠️ الخانة مشغولة.';
    }

    game.board[index] =
        'X';

    let result =
        winner(game.board);

    if (result) {

        games.delete(chatId);

        return `
${boardText(game.board)}

${
            result === 'draw'
                ? '🤝 تعادل!'
                : '🏆 فزت!'
        }
`;
    }

    const move =
        computerMove(
            game.board
        );

    if (move >= 0) {
        game.board[move] = 'O';
    }

    result =
        winner(game.board);

    if (result) {

        games.delete(chatId);

        return `
${boardText(game.board)}

${
            result === 'draw'
                ? '🤝 تعادل!'
                : '🤖 فاز ITACHI!'
        }
`;
    }

    game.updatedAt =
        Date.now();

    const display =
        game.board.map(
            (x, i) =>
                x === ' '
                    ? String(i + 1)
                    : x
        );

    return `
${boardText(display)}

🎯 دورك الآن.
`;
}

/* =========================================================
   GAME ANSWERS
========================================================= */

function checkGameAnswer(
    chatId,
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

    if (
        normalizeText(text) ===
        normalizeText(
            game.answer
        )
    ) {

        games.delete(chatId);

        return `
╭━━━〔 🎉 صحيح 〕━━━╮
┃
┃ 🏆 إجابة صحيحة!
┃
┃ 🔥 ممتاز!
╰━━━━━━━━━━━━━━━━╯
`;
    }

    return `
❌ ليست الإجابة الصحيحة.
💡 حاول مرة أخرى.
`;
}

/* =========================================================
   WEATHER
========================================================= */

function weatherAdvice(data) {

    const temp =
        Number(data?.main?.temp || 0);

    const humidity =
        Number(
            data?.main?.humidity || 0
        );

    const wind =
        Number(
            data?.wind?.speed || 0
        );

    const description =
        String(
            data?.weather?.[0]
                ?.description || ''
        ).toLowerCase();

    const advice = [];

    if (temp >= 40) {

        advice.push(
            '🥵 الحرارة مرتفعة جدًا، يُفضّل تقليل الخروج وقت الظهيرة.'
        );
    } else if (temp >= 35) {

        advice.push(
            '☀️ الجو حار، حاول تقليل التعرض للشمس لفترات طويلة.'
        );
    } else if (temp <= 15) {

        advice.push(
            '🧥 الجو بارد نسبيًا، ارتدِ ملابس مناسبة.'
        );
    }

    if (
        description.includes('rain') ||
        description.includes('مطر')
    ) {

        advice.push(
            '🌧️ توجد أجواء ممطرة، انتبه للطرق الزلقة.'
        );
    }

    if (
        description.includes('storm') ||
        description.includes('عاصفة') ||
        description.includes('رعد')
    ) {

        advice.push(
            '⛈️ توجد أجواء عاصفة، يُفضّل تجنب الخروج أثناء اشتداد العاصفة.'
        );
    }

    if (wind >= 12) {

        advice.push(
            '🌬️ الرياح قوية نسبيًا، انتبه أثناء الخروج.'
        );
    }

    if (humidity >= 80) {

        advice.push(
            '💧 الرطوبة مرتفعة، وقد تشعر بحرارة أعلى من الدرجة المسجلة.'
        );
    }

    /*
     * ملاحظات خاصة ببورتسودان
     */

    const city =
        String(
            data?.name || ''
        ).toLowerCase();

    if (
        city.includes('port') ||
        city.includes('sudan') ||
        city.includes('būr') ||
        city.includes('bur') ||
        city.includes('سودان') ||
        city.includes('بورت')
    ) {

        if (temp >= 35) {

            advice.push(
                '🌊 بورتسودان: مع حرارة البحر والرطوبة قد يكون الإحساس بالحرارة أعلى، حاول شرب الماء بانتظام.'
            );
        }

        if (humidity >= 60) {

            advice.push(
                '🌊 بورتسودان: الرطوبة البحرية قد تزيد الإحساس بالحرارة.'
            );
        }

        if (wind >= 10) {

            advice.push(
                '🌬️ بورتسودان: الرياح نشطة نسبيًا، انتبه إذا كنت قريبًا من البحر.'
            );
        }

        advice.push(
            '☀️ ملاحظة بورتسودان: الأفضل تجنب الشمس القوية في منتصف النهار قدر الإمكان.'
        );
    }

    if (!advice.length) {

        advice.push(
            '✅ الأجواء تبدو مناسبة بشكل عام.'
        );
    }

    return advice.join('\n');
}

async function getWeather(city) {

    if (!WEATHER_API_KEY) {

        return `
❌ مفتاح الطقس غير موجود.

أضف:
WEATHER_API_KEY=YOUR_KEY
`;
    }

    const key =
        city.toLowerCase();

    const cached =
        weatherCache.get(key);

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
                        q: city,
                        appid:
                            WEATHER_API_KEY,
                        units: 'metric',
                        lang: 'ar'
                    },
                    timeout: 10000
                }
            );

        const data =
            response.data;

        const description =
            data.weather?.[0]
                ?.description ||
            'غير معروف';

        const text = `
╭━━━〔 🌤️ الطقس 〕━━━╮
┃
┃ 📍 ${data.name}
┃ 🌡️ الحرارة: ${data.main.temp}°C
┃ 🥵 المحسوسة: ${data.main.feels_like}°C
┃ ☁️ الحالة: ${description}
┃ 💧 الرطوبة: ${data.main.humidity}%
┃ 🌬️ الرياح: ${data.wind?.speed || 0} m/s
┃
╰━━━━━━━━━━━━━━━━━━╯

╭━━━〔 📝 ملاحظات ونصائح 〕━━━╮
${weatherAdvice(data)}
╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯
`;

        weatherCache.set(
            key,
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
❌ لم أتمكن من الحصول على الطقس.

تأكد من اسم المدينة.
مثال:
!طقس بورتسودان
`;
    }
}

/* =========================================================
   GOOGLE SEARCH WITHOUT API KEY
========================================================= */

async function googleSearch(
    query,
    limit = 5
) {

    query =
        String(query || '')
            .trim();

    if (!query) {

        return {
            ok: false,
            text:
                '⚠️ اكتب ما تريد البحث عنه.'
        };
    }

    const cacheKey =
        `${query}:${limit}`;

    const cached =
        googleCache.get(cacheKey);

    if (
        cached &&
        Date.now() -
        cached.time <
        5 * 60 * 1000
    ) {

        return {
            ok: true,
            text: cached.text,
            results:
                cached.results || []
        };
    }

    try {

        const response =
            await axios.get(
                GOOGLE_URL,
                {
                    params: {
                        q: query,
                        num: limit,
                        hl: 'ar',
                        gl: 'sd',
                        safe: 'active'
                    },

                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36',

                        'Accept-Language':
                            'ar,en;q=0.9'
                    },

                    timeout: 15000
                }
            );

        const $ =
            cheerio.load(
                response.data
            );

        const results = [];

        $('div.MjjYud').each(
            (index, element) => {

                if (
                    results.length >=
                    limit
                ) {
                    return;
                }

                const title =
                    $(element)
                        .find('h3')
                        .first()
                        .text()
                        .trim();

                const link =
                    $(element)
                        .find('a')
                        .first()
                        .attr('href');

                let description = '';

                $(element)
                    .find('.VwiC3b')
                    .each(
                        (i, el) => {

                            const text =
                                $(el)
                                    .text()
                                    .trim();

                            if (
                                text &&
                                !description
                            ) {
                                description =
                                    text;
                            }
                        }
                    );

                if (!description) {

                    description =
                        $(element)
                            .find(
                                '[data-sncf]'
                            )
                            .first()
                            .text()
                            .trim();
                }

                if (
                    !title ||
                    !link ||
                    !link.startsWith('http')
                ) {
                    return;
                }

                if (
                    results.some(
                        item =>
                            item.url ===
                            link
                    )
                ) {
                    return;
                }

                results.push({
                    title,
                    url: link,
                    description:
                        description ||
                        'لا يوجد وصف.'
                });
            }
        );

        /*
         * طريقة بديلة إذا تغير شكل Google
         */

        if (!results.length) {

            $('h3').each(
                (index, element) => {

                    if (
                        results.length >=
                        limit
                    ) {
                        return;
                    }

                    const title =
                        $(element)
                            .text()
                            .trim();

                    const parentLink =
                        $(element)
                            .closest('a')
                            .attr('href');

                    if (
                        title &&
                        parentLink &&
                        parentLink.startsWith(
                            'http'
                        )
                    ) {

                        if (
                            !results.some(
                                x =>
                                    x.url ===
                                    parentLink
                            )
                        ) {

                            results.push({
                                title,
                                url:
                                    parentLink,
                                description:
                                    'نتيجة من Google'
                            });
                        }
                    }
                }
            );
        }

        if (!results.length) {

            return {
                ok: false,
                text: `
🔎 لم أجد نتائج مناسبة.

جرّب صياغة البحث بطريقة مختلفة.
`
            };
        }

        let output = `
╔═══━━━─── • ───━━━═══╗
      🔎 𝑮𝑶𝑶𝑮𝑳𝑬
╚═══━━━─── • ───━━━═══╝

🔍 البحث: ${query}

`;

        results.forEach(
            (result, index) => {

                output += `
╭─❖ ${index + 1} ─────────
│ 📌 ${result.title}
│ 📝 ${result.description}
│ 🔗 ${result.url}
╰────────────────────
`;
            }
        );

        output += `
━━━━━━━━━━━━━━━━━━━━━━
🤖 𝑰𝑻𝑨𝑪𝑯𝑰 𝑩𝑶𝑻
`;

        googleCache.set(
            cacheKey,
            {
                text: output,
                results,
                time:
                    Date.now()
            }
        );

        return {
            ok: true,
            text: output,
            results
        };

    } catch (error) {

        console.error(
            'Google Search Error:',
            error.message
        );

        if (
            error.response?.status ===
            429
        ) {

            return {
                ok: false,
                text:
                    '⚠️ Google رفض الطلب مؤقتًا. حاول بعد قليل.'
            };
        }

        return {
            ok: false,
            text:
                '⚠️ تعذر الاتصال بمحرك Google.'
        };
    }
}

/* =========================================================
   FOOTBALL GOOGLE FALLBACK
========================================================= */

async function footballGoogleFallback(
    query = ''
) {

    const searchQuery =
        query
            ? `مباريات ${query} اليوم نتائج`
            : 'مباريات اليوم كرة القدم نتائج مباشر';

    const result =
        await googleSearch(
            searchQuery,
            7
        );

    if (!result.ok) {

        return `
❌ تعذر الحصول على مباريات كرة القدم.

🔄 API الكرة لم يعمل وGoogle لم يرجع نتائج.
`;
    }

    return `
╭━━━〔 ⚽ نتائج Google 〕━━━╮
┃
┃ 🔎 ${searchQuery}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯

${result.text}
`;
}

/* =========================================================
   FOOTBALL API
========================================================= */

async function getFootball(
    searchQuery = ''
) {

    /*
     * إذا لم يوجد Token:
     * استخدم Google مباشرة.
     */

    if (!FOOTBALL_API_KEY) {

        return await footballGoogleFallback(
            searchQuery
        );
    }

    const cacheKey =
        searchQuery || 'live';

    const cached =
        footballCache.get(
            cacheKey
        );

    if (
        cached &&
        Date.now() -
        cached.time <
        120000
    ) {
        return cached.text;
    }

    try {

        let params = {
            live: 'all'
        };

        /*
         * لو المستخدم طلب فريقًا
         * نحاول البحث عن المباريات.
         */

        if (searchQuery) {

            params = {
                live: 'all'
            };
        }

        const response =
            await axios.get(
                'https://v3.football.api-sports.io/fixtures',
                {
                    params,
                    headers: {
                        'x-apisports-key':
                            FOOTBALL_API_KEY
                    },
                    timeout: 10000
                }
            );

        const list =
            response.data?.response ||
            [];

        /*
         * API رجع خطأ أو لا توجد نتائج.
         * ننتقل إلى Google.
         */

        if (
            response.data?.errors &&
            Object.keys(
                response.data.errors
            ).length
        ) {

            console.log(
                '⚠️ Football API error:',
                response.data.errors
            );

            return await footballGoogleFallback(
                searchQuery
            );
        }

        if (!list.length) {

            /*
             * لا نعتبر عدم وجود مباريات
             * فشلًا، ولكن Google قد يعطي
             * معلومات اليوم.
             */

            const google =
                await footballGoogleFallback(
                    searchQuery
                );

            if (
                google &&
                !google.includes(
                    'تعذر'
                )
            ) {
                return google;
            }

            return `
╭━━━〔 ⚽ مباشر 〕━━━╮
┃
┃ لا توجد مباريات مباشرة
┃ حاليًا.
╰━━━━━━━━━━━━━━━━━━╯
`;
        }

        const lines =
            list
                .slice(0, 12)
                .map(
                    item => {

                        const home =
                            item.teams
                                ?.home
                                ?.name ||
                            '?';

                        const away =
                            item.teams
                                ?.away
                                ?.name ||
                            '?';

                        const gh =
                            item.goals
                                ?.home ??
                            0;

                        const ga =
                            item.goals
                                ?.away ??
                            0;

                        const status =
                            item.fixture
                                ?.status
                                ?.short ||
                            '';

                        return `┃ ⚽ ${home} ${gh} - ${ga} ${away} ${status}`;
                    }
                );

        const text = `
╭━━━〔 ⚽ المباريات المباشرة 〕━━━╮
${lines.join('\n')}
╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯
`;

        footballCache.set(
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
            'Football API:',
            error.message
        );

        /*
         * أهم إضافة:
         * عند فشل Token / API
         * لا يتوقف الأمر.
         */

        return await footballGoogleFallback(
            searchQuery
        );
    }
}

/* =========================================================
   WIKIPEDIA
========================================================= */

async function wikipediaSearch(
    query
) {

    if (!query) {

        return `
🔎 اكتب شيئًا للبحث.

مثال:
بحث محمد صلاح
`;
    }

    const key =
        query.toLowerCase();

    const cached =
        searchCache.get(key);

    if (
        cached &&
        Date.now() -
        cached.time <
        10 * 60 * 1000
    ) {
        return cached.text;
    }

    try {

        const response =
            await axios.get(
                'https://ar.wikipedia.org/w/api.php',
                {
                    params: {
                        action:
                            'query',
                        list:
                            'search',
                        srsearch:
                            query,
                        format:
                            'json',
                        utf8: 1,
                        srlimit: 5
                    },
                    timeout: 10000
                }
            );

        const results =
            response.data?.query
                ?.search ||
            [];

        if (!results.length) {

            return `
🔎 لم أجد نتائج لـ:
${query}
`;
        }

        const lines =
            results.map(
                (item, index) =>
                    `┃ ${index + 1} ⟫ ${item.title}`
            );

        const text = `
╭━━━〔 🔎 نتائج ويكيبيديا 〕━━━╮
┃
${lines.join('\n')}
┃
╰━━━━━━━━━━━━━━━━━━━━╯
`;

        searchCache.set(
            key,
            {
                text,
                time:
                    Date.now()
            }
        );

        return text;

    } catch (error) {

        console.error(
            'Wikipedia:',
            error.message
        );

        /*
         * إذا فشلت ويكيبيديا
         * نستخدم Google.
         */

        const google =
            await googleSearch(
                query,
                5
            );

        return google.text;
    }
}

/* =========================================================
   SIMPLE TOOLS
========================================================= */

function randomLuck() {

    return randomNoRepeat(
        luckMessages,
        usedLuck
    );
}

function wisdom() {

    return randomNoRepeat(
        wisdoms,
        usedWisdoms
    );
}

function joke() {

    return randomNoRepeat(
        jokes,
        usedJokes
    );
}

function quote() {

    return randomNoRepeat(
        quotes,
        usedQuotes
    );
}

function randomInfo() {

    return randomNoRepeat(
        infos,
        usedInfos
    );
}

/* =========================================================
   TIME NOTES
========================================================= */

function getKhartoumTime() {

    const now =
        new Date();

    const time =
        now.toLocaleTimeString(
            'ar-SD',
            {
                timeZone:
                    'Africa/Khartoum',
                hour:
                    '2-digit',
                minute:
                    '2-digit',
                second:
                    '2-digit'
            }
        );

    const hour =
        Number(
            new Intl.DateTimeFormat(
                'en-US',
                {
                    timeZone:
                        'Africa/Khartoum',
                    hour:
                        'numeric',
                    hour12:
                        false
                }
            ).format(now)
        );

    let note =
        '🕒 الوقت الحالي في السودان.';

    if (
        hour >= 5 &&
        hour < 11
    ) {

        note =
            '🌅 صباح الخير، بداية يوم جديدة.';
    } else if (
        hour >= 11 &&
        hour < 15
    ) {

        note =
            '☀️ وقت الظهر، انتبه للحرارة خصوصًا في بورتسودان.';
    } else if (
        hour >= 15 &&
        hour < 18
    ) {

        note =
            '🌇 وقت العصر، يمكن أن تبدأ الحرارة بالانخفاض تدريجيًا.';
    } else if (
        hour >= 18 &&
        hour < 22
    ) {

        note =
            '🌙 مساء الخير.';
    } else {

        note =
            '🌙 الوقت متأخر، خذ قسطًا مناسبًا من الراحة.';
    }

    return `
╭━━━〔 🕒 الوقت 〕━━━╮
┃
┃ 🇸🇩 السودان
┃ 🕒 ${time}
┃
╰━━━━━━━━━━━━━━━━━━╯

📝 ${note}
`;
}

/* =========================================================
   STATUS
========================================================= */

function uptime() {

    const sec =
        Math.floor(
            process.uptime()
        );

    const h =
        Math.floor(sec / 3600);

    const m =
        Math.floor(
            (sec % 3600) / 60
        );

    const s =
        sec % 60;

    return `${h}h ${m}m ${s}s`;
}

/* =========================================================
   ADMIN - REMOVE COMMAND
========================================================= */

function removeFromMenu(
    command
) {

    const value =
        normalizeText(
            command
        );

    if (!value) {

        return `
⚠️ اكتب اسم الأمر.

مثال:
حذف من القائمة نكتة
`;
    }

    removedCommands.add(
        value
    );

    return `
╭━━━〔 🗑️ القائمة 〕━━━╮
┃
┃ ✅ تم حذف:
┃ ${command}
┃
┃ من القائمة.
┃
┃ ⚠️ وظيفة الأمر نفسها لم تُحذف.
┃
╰━━━━━━━━━━━━━━━━━━━━╯
`;
}

function restoreFromMenu(
    command
) {

    const value =
        normalizeText(
            command
        );

    if (!value) {

        return `
⚠️ اكتب اسم الأمر.

مثال:
استعادة من القائمة نكتة
`;
    }

    removedCommands.delete(
        value
    );

    return `
♻️ تم استعادة الأمر:
${command}

إلى القائمة.
`;
}

/*
 * "حذف أمر" هنا آمن:
 * لا يقوم بتعديل ملفات المشروع أو حذف
 * كود JavaScript أثناء التشغيل.
 * فقط يخفي الأمر من قائمة البوت.
 */

function deleteCommand(
    command
) {

    if (!command) {

        return `
⚠️ اكتب اسم الأمر.

مثال:
حذف امر نكتة
`;
    }

    return removeFromMenu(
        command
    );
}

/* =========================================================
   ADMIN
========================================================= */

async function adminCommand(
    command,
    chatId,
    args
) {

    if (
        command === 'لوحة'
    ) {
        return adminMenu();
    }

    if (
        command === 'تفعيل'
    ) {

        activatedChats.add(
            chatId
        );

        return `
╭━━━〔 🔓 التفعيل 〕━━━╮
┃
┃ ✅ تم تفعيل ITACHI
┃
┃ 🤖 البوت جاهز.
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
    }

    if (
        command === 'تعطيل'
    ) {

        activatedChats.delete(
            chatId
        );

        return `
🔒 تم تعطيل البوت في هذه الدردشة.
`;
    }

    if (
        command === 'تشغيل_الذكاء'
    ) {

        setGeminiEnabled(true);

        return '🟢 تم تشغيل Gemini.';
    }

    if (
        command === 'ايقاف_الذكاء'
    ) {

        setGeminiEnabled(false);

        return '🔴 تم إيقاف Gemini.';
    }

    if (
        command === 'مسح_الذكاء'
    ) {

        clearAllHistories();

        return '🧹 تم مسح جميع ذاكرة Gemini.';
    }

    if (
        command === 'تنظيف'
    ) {

        games.clear();
        weatherCache.clear();
        footballCache.clear();
        searchCache.clear();
        googleCache.clear();

        return `
🧹 تم تنظيف البيانات المؤقتة.

🎮 الألعاب: 0
🌤️ Cache الطقس: 0
⚽ Cache الكرة: 0
🔎 Cache البحث: 0
🌐 Cache Google: 0
`;
    }

    if (
        command === 'حذف_امر'
    ) {

        return deleteCommand(
            args.join(' ')
        );
    }

    if (
        command === 'حذف_من_القائمة'
    ) {

        return removeFromMenu(
            args.join(' ')
        );
    }

    if (
        command === 'استعادة_من_القائمة'
    ) {

        return restoreFromMenu(
            args.join(' ')
        );
    }

    if (
        command === 'حالة'
    ) {

        const memory =
            process.memoryUsage();

        return `
╭━━━〔 🩺 حالة ITACHI 〕━━━╮
┃
┃ 🟢 الحالة: Online
┃ ⏱️ التشغيل: ${uptime()}
┃ 🧠 الذاكرة: ${
            (
                memory.rss /
                1024 /
                1024
            ).toFixed(1)
        } MB
┃ 🎮 الألعاب: ${games.size}
┃ 🔐 التفعيلات: ${
            activatedChats.size
        }
┃ 🗑️ المحذوف من القائمة: ${
            removedCommands.size
        }
┃ 🤖 AI: ${
            getGeminiStatus()
                .configured
                ? '🟢'
                : '🔴'
        }
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
    }

    if (
        command === 'احصائيات'
    ) {

        return `
╭━━━〔 📊 الإحصائيات 〕━━━╮
┃
┃ 👑 المالك: ${OWNER}
┃ 💬 الدردشات: ${activatedChats.size}
┃ 🎮 الألعاب: ${games.size}
┃ 🌤️ الطقس: ${weatherCache.size}
┃ ⚽ الكرة: ${footballCache.size}
┃ 🔎 البحث: ${searchCache.size}
┃ 🌐 Google: ${googleCache.size}
┃ 🗑️ المخفية: ${removedCommands.size}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
    }

    return null;
}

/* =========================================================
   HANDLE COMMANDS
========================================================= */

async function handleCommand(
    message,
    chatId,
    sender,
    text
) {

    const command =
        getCommand(text);

    const args =
        getArgs(text);

    const owner =
        isOwner(message);

    /* =====================================================
       ADMIN ONLY
    ===================================================== */

    const adminCommands = [
        'لوحة',
        'تفعيل',
        'تعطيل',
        'تشغيل_الذكاء',
        'ايقاف_الذكاء',
        'مسح_الذكاء',
        'تنظيف',
        'حالة',
        'احصائيات',
        'حذف_امر',
        'حذف_من_القائمة',
        'استعادة_من_القائمة'
    ];

    if (
        adminCommands.includes(
            command
        )
    ) {

        if (!owner) {

            return `
⛔ هذا الأمر خاص بمالك البوت فقط.
`;
        }

        return await adminCommand(
            command,
            chatId,
            args
        );
    }

    /* =====================================================
       MENU
    ===================================================== */

    if (
        command === 'قائمة' ||
        command === 'menu' ||
        command === 'اوامر' ||
        command === 'الأوامر'
    ) {

        return mainMenu();
    }

    /* =====================================================
       SECTION NUMBERS
    ===================================================== */

    if (text.trim() === '1') {

        if (!owner) {
            return '⛔ لوحة الإدارة للمالك فقط.';
        }

        return adminMenu();
    }

    if (text.trim() === '2') {
        return aiMenu();
    }

    if (text.trim() === '3') {
        return toolsMenu();
    }

    if (text.trim() === '4') {
        return footballMenu();
    }

    if (text.trim() === '5') {
        return searchMenu();
    }

    if (text.trim() === '6') {
        return gamesMenu();
    }

    if (text.trim() === '7') {

        return `
🌤️ اكتب:

طقس الخرطوم

أو:

!طقس بورتسودان
`;
    }

    if (text.trim() === '8') {
        return entertainmentMenu();
    }

    if (text.trim() === '9') {
        return informationMenu();
    }

    /* =====================================================
       AI
    ===================================================== */

    if (
        command === 'ط' ||
        command === 'ai' ||
        command === 'اسأل'
    ) {

        const question =
            args.join(' ').trim();

        if (!question) {

            return `
🤖 اكتب سؤالك.

مثال:
ط اشرح لي Node.js
`;
        }

        const answer =
            await askGemini(
                question,
                chatId
            );

        return `
╭━━━〔 🤖 ITACHI AI 〕━━━╮
┃
${answer}
┃
╰━━━━━━━━━━━━━━━━━━━━╯
`;
    }

    if (
        command === 'نسيان'
    ) {

        clearHistory(chatId);

        return '🧹 تم مسح ذاكرة AI لهذه الدردشة.';
    }

    /* =====================================================
       WEATHER
    ===================================================== */

    if (
        command === 'طقس'
    ) {

        return await getWeather(
            args.join(' ') ||
            'Port Sudan'
        );
    }

    /* =====================================================
       FOOTBALL
    ===================================================== */

    if (
        command === 'مباريات' ||
        command === 'مباشر' ||
        command === 'أهداف' ||
        command === 'نتائج' ||
        command === 'مباريات_اليوم'
    ) {

        return await getFootball(
            args.join(' ')
        );
    }

    /*
     * أمر بحث مباريات
     */

    if (
        command === 'بحث_مباريات'
    ) {

        return await footballGoogleFallback(
            args.join(' ')
        );
    }

    /* =====================================================
       GOOGLE SEARCH
    ===================================================== */

    if (
        command === 'بحث'
    ) {

        const query =
            args.join(' ');

        const result =
            await googleSearch(
                query,
                5
            );

        return result.text;
    }

    /* =====================================================
       WIKIPEDIA
    ===================================================== */

    if (
        command === 'ويكيبيديا' ||
        command === 'تعريف'
    ) {

        return await wikipediaSearch(
            args.join(' ')
        );
    }

    /* =====================================================
       TOOLS
    ===================================================== */

    if (
        command === 'فحص'
    ) {

        const ai =
            getGeminiStatus();

        return `
╭━━━〔 🩺 فحص النظام 〕━━━╮
┃
┃ 🟢 WhatsApp: ${sock ? 'Online' : 'Offline'}
┃ 🟢 Node.js: ${process.version}
┃ ⏱️ Uptime: ${uptime()}
┃ 🤖 Gemini: ${
            ai.configured
                ? 'Ready'
                : 'Missing Key'
        }
┃ 🎮 Games: ${games.size}
┃ 🔎 Google: Ready
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯
`;
    }

    if (
        command === 'وقت'
    ) {

        return getKhartoumTime();
    }

    if (
        command === 'تاريخ'
    ) {

        return `
📅 التاريخ:

${new Date().toLocaleDateString(
            'ar-SD',
            {
                timeZone:
                    'Africa/Khartoum',
                dateStyle:
                    'full'
            }
        )}

🇸🇩 توقيت السودان
`;
    }

    if (
        command === 'حظ'
    ) {
        return randomLuck();
    }

    if (
        command === 'حكمة' ||
        command === 'حكم'
    ) {
        return wisdom();
    }

    if (
        command === 'نكتة' ||
        command === 'نكت'
    ) {
        return joke();
    }

    if (
        command === 'اقتباس'
    ) {
        return quote();
    }

    if (
        command === 'معلومة' ||
        command === 'معلومات'
    ) {
        return randomInfo();
    }

    if (
        command === 'نرد'
    ) {

        return `
🎲 نتيجة النرد:

${Math.floor(
            Math.random() * 6
        ) + 1}
`;
    }

    if (
        command === 'عملة'
    ) {

        return `
🪙 نتيجة العملة:

${
            Math.random() < 0.5
                ? 'صورة'
                : 'كتابة'
        }
`;
    }

    if (
        command === 'خط'
    ) {

        return `
╭━━━〔 🔤 خطوط 〕━━━╮

𝑰𝑻𝑨𝑪𝑯𝑰

𝓘𝓣𝓐𝓒𝓗𝓘

𝕀𝕋𝔸ℂℍ𝕀

𝐈𝐓𝐀𝐂𝐇𝐈

𝙄𝙏𝘼𝘾𝙃𝙄

╰━━━━━━━━━━━━━━━━━━╯
`;
    }

    if (
        command === 'رقم'
    ) {

        return `
🔢 الرقم العشوائي:

${Math.floor(
            Math.random() * 1000
        ) + 1}
`;
    }

    if (
        command === 'معرف'
    ) {

        return `
🆔 معرف الدردشة:

${chatId}

👤 المرسل:

${sender}
`;
    }

    if (
        command === 'بوت'
    ) {

        return `
╭━━━〔 ⚔️ ITACHI 〕━━━╮
┃
┃ 🤖 WhatsApp AI Bot
┃ 🧠 Gemini
┃ ⚽ Football
┃ 🌤️ Weather
┃ 🎮 Games
┃ 🔎 Google Search
┃ 📚 Wikipedia
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
    }

    if (
        command === 'المطور'
    ) {

        return `
╭━━━〔 👑 المطور 〕━━━╮
┃
┃ ⚔️ ITACHI
┃ 📱 ${OWNER}
┃
╰━━━━━━━━━━━━━━━━━━╯
`;
    }

    /* =====================================================
       GAMES
    ===================================================== */

    if (
        command === 'xo' ||
        command === 'اكسو'
    ) {

        return startXO(
            chatId,
            sender
        );
    }

    if (
        command === 'لغز'
    ) {

        return startRiddle(
            chatId
        );
    }

    if (
        command === 'رياضيات'
    ) {

        return startMath(
            chatId
        );
    }

    if (
        command === 'كلمة'
    ) {

        return startWord(
            chatId
        );
    }

    if (
        command === 'لاعب'
    ) {

        return `
⚽ اللاعب:

${
            players[
                Math.floor(
                    Math.random() *
                    players.length
                )
            ]
        }
`;
    }

    if (
        command === 'فريق'
    ) {

        return `
🏆 الفريق:

${
            teams[
                Math.floor(
                    Math.random() *
                    teams.length
                )
            ]
        }
`;
    }

    if (
        command === 'انمي'
    ) {

        return `
🍥 شخصية الأنمي:

${
            anime[
                Math.floor(
                    Math.random() *
                    anime.length
                )
            ]
        }
`;
    }

    if (
        command === 'حجر' ||
        command === 'ورق' ||
        command === 'مقص'
    ) {

        const choices = [
            'حجر',
            'ورق',
            'مقص'
        ];

        const bot =
            choices[
                Math.floor(
                    Math.random() *
                    choices.length
                )
            ];

        let result =
            '🤝 تعادل';

        if (
            command === bot
        ) {
            result = '🤝 تعادل';
        } else if (
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
            result = '🏆 فزت!';
        } else {
            result = '🤖 فاز ITACHI!';
        }

        return `
╭━━━〔 🎮 RPS 〕━━━╮
┃
┃ 👤 أنت: ${command}
┃ 🤖 ITACHI: ${bot}
┃
┃ ${result}
╰━━━━━━━━━━━━━━━━━━╯
`;
    }

    return null;
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function handleMessage(
    message
) {

    const key =
        message?.key || {};

    if (!key.id) {
        return;
    }

    if (
        botSentMessages.has(
            key.id
        )
    ) {
        return;
    }

    if (
        alreadyProcessed(
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
        getSender(message);

    const text =
        getText(message);

    if (!text) {
        return;
    }

    const owner =
        isOwner(message);

    console.log(
        `📩 ${text} | ${chatId} | owner=${owner}`
    );

    /* =====================================================
       ACTIVATION BEFORE SECURITY
    ===================================================== */

    if (
        owner &&
        (
            text === 'تفعيل' ||
            text === '!تفعيل'
        )
    ) {

        activatedChats.add(
            chatId
        );

        await sendText(
            chatId,
            `
╭━━━〔 🔓 ITACHI 〕━━━╮
┃
┃ ✅ تم تفعيل البوت
┃
┃ 👑 المالك:
┃ ${OWNER}
┃
┃ 🤖 جاهز للعمل
┃
╰━━━━━━━━━━━━━━━━━━╯
`
        );

        return;
    }

    if (
        owner &&
        (
            text === 'تعطيل' ||
            text === '!تعطيل'
        )
    ) {

        activatedChats.delete(
            chatId
        );

        await sendText(
            chatId,
            '🔒 تم تعطيل البوت.'
        );

        return;
    }

    /* =====================================================
       ADMIN PANEL CAN BE USED BY OWNER
       EVEN BEFORE CHAT ACTIVATION
    ===================================================== */

    if (
        owner &&
        (
            text === 'لوحة' ||
            text === '!لوحة'
        )
    ) {

        await sendText(
            chatId,
            adminMenu()
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
       GAME ANSWERS
    ===================================================== */

    const game =
        games.get(chatId);

    if (
        game &&
        game.type !== 'xo' &&
        !text.startsWith('!')
    ) {

        const answer =
            checkGameAnswer(
                chatId,
                text
            );

        if (answer) {

            await sendText(
                chatId,
                answer
            );

            return;
        }
    }

    /* =====================================================
       XO
    ===================================================== */

    if (
        /^[1-9]$/.test(
            text.trim()
        )
    ) {

        const game =
            games.get(chatId);

        if (
            game?.type === 'xo'
        ) {

            const answer =
                playXO(
                    chatId,
                    sender,
                    text.trim()
                );

            await sendText(
                chatId,
                answer
            );

            return;
        }
    }

    /* =====================================================
       COMMANDS
    ===================================================== */

    const response =
        await handleCommand(
            message,
            chatId,
            sender,
            text
        );

    if (response) {

        await sendText(
            chatId,
            response
        );

        return;
    }

    /* =====================================================
       DIRECT AI FOR OWNER
    ===================================================== */

    if (
        owner &&
        !text.startsWith('!')
    ) {

        try {

            const answer =
                await askGemini(
                    text,
                    chatId
                );

            await sendText(
                chatId,
                `
🤖 𝑰𝑻𝑨𝑪𝑯𝑰 AI

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
   CLEANUP
========================================================= */

setInterval(
    () => {

        const now =
            Date.now();

        for (
            const [
                id,
                game
            ] of games
        ) {

            if (
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
            ] of botSentMessages
        ) {

            if (
                now - time >
                MESSAGE_TIMEOUT
            ) {
                botSentMessages.delete(
                    id
                );
            }
        }

    },
    60 * 1000
).unref();

/* =========================================================
   START BOT
   الاتصال هنا كما هو
========================================================= */

async function startBot() {

    if (starting) {
        return;
    }

    starting = true;

    try {

        console.log('');
        console.log(
            '╔══════════════════════════════╗'
        );
        console.log(
            '║       ⚔️ ITACHI BOT         ║'
        );
        console.log(
            '╚══════════════════════════════╝'
        );
        console.log(
            `👑 Owner: ${OWNER}`
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
                    connection === 'open'
                ) {

                    starting =
                        false;

                    console.log('');
                    console.log(
                        '╔══════════════════════════════╗'
                    );
                    console.log(
                        '║    ✅ ITACHI CONNECTED       ║'
                    );
                    console.log(
                        '╚══════════════════════════════╝'
                    );
                    console.log('');
                }

                if (
                    connection === 'close'
                ) {

                    starting =
                        false;

                    const code =
                        lastDisconnect
                            ?.error
                            ?.output
                            ?.statusCode;

                    console.log(
                        `⚠️ Connection closed: ${code || 'unknown'}`
                    );

                    if (
                        code ===
                        DisconnectReason.loggedOut
                    ) {

                        console.log(
                            '❌ WhatsApp session logged out.'
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
                                        console.error
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

                for (
                    const message
                    of event.messages || []
                ) {

                    try {

                        await handleMessage(
                            message
                        );

                    } catch (error) {

                        console.error(
                            '❌ Handler:',
                            error.stack ||
                            error.message
                        );
                    }
                }
            }
        );

        /* =================================================
           PAIRING CODE
        ================================================= */

        if (
            !state.creds.registered
        ) {

            console.log('');
            console.log(
                '📱 الحساب غير مرتبط.'
            );

            console.log(
                '⏳ جاري إنشاء كود الربط...'
            );

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        3000
                    )
            );

            const code =
                await sock.requestPairingCode(
                    OWNER
                );

            console.log('');
            console.log(
                '╔════════════════════════════╗'
            );
            console.log(
                '║      🔑 كود ربط واتساب     ║'
            );
            console.log(
                '╠════════════════════════════╣'
            );
            console.log(
                `║       ${code}        ║`
            );
            console.log(
                '╚════════════════════════════╝'
            );
            console.log('');
            console.log(
                '📱 واتساب > الأجهزة المرتبطة'
            );
            console.log(
                '🔗 ربط جهاز > الربط برقم الهاتف'
            );
            console.log(
                `🔢 أدخل الكود: ${code}`
            );
            console.log('');

        } else {

            console.log(
                '✅ توجد جلسة محفوظة.'
            );

            console.log(
                '🔄 جاري الاتصال...'
            );
        }

    } catch (error) {

        starting =
            false;

        sock = null;

        console.error(
            '❌ Start error:',
            error.stack ||
            error.message
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
                            console.error
                        );

                },
                10000
            );
    }
}

/* =========================================================
   PROCESS
========================================================= */

process.on(
    'unhandledRejection',
    error => {

        console.error(
            '❌ Unhandled Rejection:',
            error
        );
    }
);

process.on(
    'uncaughtException',
    error => {

        console.error(
            '❌ Uncaught Exception:',
            error
        );
    }
);

/* =========================================================
   START
========================================================= */

startBot();
