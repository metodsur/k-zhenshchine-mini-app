(async function enforceChannelAccess() {
  const publicPage = "/index.html";

  function redirect(reason) {
    window.location.replace(`${publicPage}?access=${encodeURIComponent(reason)}`);
  }

  async function getTelegramInitData() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const webApp = window.Telegram && window.Telegram.WebApp;
      if (webApp && webApp.initData) {
        webApp.ready();
        return webApp.initData;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return "";
  }

  async function checkAccess(initData) {
    const response = await fetch("/api/auth/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ initData })
    });
    const body = await response.json();
    return { response, body };
  }

  try {
    const initData = await getTelegramInitData();
    if (!initData) return redirect("authorization_required");

    let result = await checkAccess(initData);
    if (!result.response.ok) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = await checkAccess(initData);
    }

    if (!result.response.ok) return redirect("authorization_required");
    if (result.body.full_access !== true) return redirect("subscription_required");
  } catch (error) {
    redirect("server_unavailable");
  }
})();
