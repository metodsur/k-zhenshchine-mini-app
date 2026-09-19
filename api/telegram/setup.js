function sendJson(res,status,body){
  res.statusCode=status;
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendHtml(res,status,html){
  res.statusCode=status;
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.setHeader("Cache-Control","no-store");
  res.end(html);
}

function getBody(req){
  if(typeof req.body==="string"){
    return Object.fromEntries(new URLSearchParams(req.body));
  }
  return req.body || {};
}

module.exports=async function handler(req,res){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret=process.env.TELEGRAM_WEBHOOK_SECRET;
  const setupSecret=process.env.TELEGRAM_SETUP_SECRET;
  const baseUrl=(process.env.APP_BASE_URL || "").replace(/\/$/,"");

  if(!token || !webhookSecret || !setupSecret || !baseUrl){
    return sendJson(res,500,{ok:false,error:"Server configuration error"});
  }

  if(req.method==="GET"){
    return sendHtml(res,200,`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram webhook setup</title></head>
<body style="font-family:system-ui;padding:24px;max-width:520px;margin:auto">
<h2>Telegram webhook setup</h2>
<p>Enter TELEGRAM_SETUP_SECRET. It stays between your browser and this server.</p>
<form method="POST">
<input name="setup_secret" type="password" autocomplete="off"
style="width:100%;box-sizing:border-box;padding:12px;margin:10px 0" required>
<button type="submit" style="padding:12px 18px">Connect webhook</button>
</form></body></html>`);
  }

  if(req.method!=="POST") return sendJson(res,405,{ok:false});

  const body=getBody(req);
  const supplied=req.headers["x-setup-secret"] || body.setup_secret;
  if(supplied!==setupSecret) return sendJson(res,403,{ok:false,error:"Forbidden"});

  const response=await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      url:`${baseUrl}/api/telegram/webhook`,
      secret_token:webhookSecret,
      allowed_updates:["message"]
    })
  });

  const data=await response.json();
  return sendJson(res,response.ok && data.ok ? 200 : 502,{
    ok:Boolean(data.ok),
    description:data.description || null
  });
};
