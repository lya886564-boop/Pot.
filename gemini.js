const axios=require('axios');
const API_KEY=process.env.GEMINI_API_KEY||process.env.GEMINI_API||'';
const MODEL=process.env.GEMINI_MODEL||'gemini-3.6-flash';
const chats=new Map();
function getGeminiStatus(){return{configured:!!API_KEY,enabled:!!API_KEY,model:MODEL};}
async function askGemini(prompt,chatId='default'){
 if(!API_KEY)return'❌ أضف GEMINI_API_KEY.';
 const h=chats.get(chatId)||[];
 h.push({role:'user',parts:[{text:String(prompt)}]});
 try{
  const r=await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(API_KEY)}`,
   {contents:h.slice(-12),generationConfig:{temperature:.7,maxOutputTokens:1200}},
   {timeout:60000});
  const a=r.data?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('').trim();
  if(!a)throw new Error('Empty response');
  h.push({role:'model',parts:[{text:a}]});chats.set(chatId,h.slice(-12));return a;
 }catch(e){console.error('Gemini:',e.response?.data?.error?.message||e.message);return'❌ تعذر الاتصال بـ Gemini.';}
}
module.exports={askGemini,getGeminiStatus};
