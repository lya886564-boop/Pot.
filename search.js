'use strict';

/*
╔════════════════════════════════════════════╗
║              🔎 ITACHI SEARCH             ║
║          Google Search Module             ║
╚════════════════════════════════════════════╝
*/

const axios = require('axios');
const cheerio = require('cheerio');

const GOOGLE_URL =
    'https://www.google.com/search';

/* =========================================================
   CACHE
========================================================= */

const cache = new Map();

const CACHE_TIME =
    5 * 60 * 1000;

/* =========================================================
   GOOGLE SEARCH
========================================================= */

async function googleSearch(
    query,
    limit = 5
) {

    query =
        String(query || '')
            .trim();

    if (!query) {

        return `
⚠️ اكتب ما تريد البحث عنه.

مثال:

بحث محمد صلاح
`;
    }

    limit =
        Math.min(
            Math.max(
                Number(limit) || 5,
                1
            ),
            10
        );

    const cacheKey =
        `${query.toLowerCase()}_${limit}`;

    const cached =
        cache.get(cacheKey);

    if (
        cached &&
        Date.now() - cached.time <
        CACHE_TIME
    ) {

        return cached.text;
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

                        'Accept':
                            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

                        'Accept-Language':
                            'ar,en;q=0.9',

                        'Cache-Control':
                            'no-cache'
                    },

                    timeout: 15000,

                    maxRedirects: 5
                }
            );

        const $ =
            cheerio.load(
                response.data
            );

        const results = [];

        /* =====================================================
           GOOGLE RESULT BLOCKS
        ===================================================== */

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

                let link =
                    $(element)
                        .find('a')
                        .first()
                        .attr('href');

                let description = '';

                $(element)
                    .find(
                        '.VwiC3b, .yXK7lf, [data-sncf]'
                    )
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

                if (
                    !link ||
                    !link.startsWith('http')
                ) {
                    return;
                }

                /*
                 * منع روابط Google الداخلية
                 */

                if (
                    link.includes(
                        'google.com/search'
                    ) ||
                    link.includes(
                        'google.com/url'
                    )
                ) {
                    return;
                }

                if (
                    !title ||
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
                        'لا يوجد وصف متاح.'
                });
            }
        );

        /* =====================================================
           FALLBACK
        ===================================================== */

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

                    let link =
                        $(element)
                            .closest('a')
                            .attr('href');

                    if (
                        !link
                    ) {
                        return;
                    }

                    if (
                        !link.startsWith(
                            'http'
                        )
                    ) {
                        return;
                    }

                    if (
                        link.includes(
                            'google.com'
                        )
                    ) {
                        return;
                    }

                    if (
                        !title ||
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
                            'نتيجة من Google'
                    });
                }
            );
        }

        /* =====================================================
           NO RESULTS
        ===================================================== */

        if (!results.length) {

            return `
╭━━━〔 🔎 Google 〕━━━╮
┃
┃ لم أجد نتائج مناسبة.
┃
┃ 🔍 البحث:
┃ ${query}
┃
┃ جرّب صياغة البحث بطريقة
┃ مختلفة.
╰━━━━━━━━━━━━━━━━━━━━╯
`;
        }

        /* =====================================================
           FORMAT
        ===================================================== */

        let output = `
╔═══━━━─── • ───━━━═══╗
        🔎 𝑮𝑶𝑶𝑮𝑳𝑬
╚═══━━━─── • ───━━━═══╝

🔍 البحث:
${query}

`;

        results.forEach(
            (result, index) => {

                output += `
╭─❖ ${index + 1} ─────────
│ 📌 ${result.title}
│
│ 📝 ${result.description}
│
│ 🔗 ${result.url}
╰────────────────────
`;
            }
        );

        output += `
━━━━━━━━━━━━━━━━━━━━━━
🤖 𝑰𝑻𝑨𝑪𝑯𝑰 𝑩𝑶𝑻
`;

        cache.set(
            cacheKey,
            {
                text: output,
                time: Date.now()
            }
        );

        return output;

    } catch (error) {

        console.error(
            '❌ Google Search Error:',
            error.message
        );

        if (
            error.response?.status ===
            429
        ) {

            return `
⚠️ Google رفض الطلب مؤقتًا.

🔄 حاول البحث مرة أخرى بعد قليل.
`;
        }

        if (
            error.code ===
            'ECONNABORTED'
        ) {

            return `
⏳ انتهت مهلة الاتصال بـ Google.

🔄 حاول مرة أخرى.
`;
        }

        return `
⚠️ تعذر الاتصال بمحرك Google.

🔄 حاول مرة أخرى بعد قليل.
`;
    }
}

/* =========================================================
   CACHE CONTROL
========================================================= */

function clearSearchCache() {

    cache.clear();

    return true;
}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
    googleSearch,
    clearSearchCache
};
