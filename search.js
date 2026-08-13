const axios=require('axios');
const KEY=process.env.SERPAPI_KEY||'';
async function googleSearch(q,n=5){
 if(!KEY)return`🔎 SERPAPI_KEY غير موجود.\n🌐 https://www.google.com/search?q=${encodeURIComponent(q)}`;
 try{
  const r=await axios.get('https://serpapi.com/search.json',{params:{engine:'google',q,api_key:KEY,num:n,hl:'ar'},timeout:20000});
  const a=(r.data.organic_results||[]).slice(0,n);
  return a.length?'🔎 النتائج:\n'+a.map((x,i)=>`${i+1}. ${x.title}\n${x.link}\n${x.snippet||''}`).join('\n\n'):'❌ لا توجد نتائج.';
 }catch(e){return'❌ فشل البحث.';}
}
module.exports={googleSearch};
