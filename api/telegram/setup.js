function send(res,status,body){
  res.statusCode=status;
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
module.exports=async function handler(req,res){
  if(req.method!=="POST") return send(res,405,{ok:false});
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret=process.env.TELEGRAM_WEBHOOK_SECRET;
  const setupSecret=process.env.TELEGRAM_SETUP_SECRET;
  const baseUrl=(process.env.APP_BASE_URL || "").replace(/\/$/,"");
  if(!token || !webhookSecret || !setupSecret || !baseUrl)
    return send(res,500,{ok:false,error:"Server configuration error"});
  if(req.headers["x-setup-secret"]!==setupSecret) return send(res,403,{ok:false});
  const response=await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({url:`${baseUrl}/api/telegram/webhook`,secret_token:webhookSecret,allowed_updates:["message"]})
  });
  const data=await response.json();
  return send(res,response.ok && data.ok ? 200 : 502,{ok:Boolean(data.ok),description:data.description || null});
};
