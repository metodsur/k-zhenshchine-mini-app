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

  try {
    const initData = await getTelegramInitData();
    if (!initData) return;

    const response = await fetch("/api/auth/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ initData })
    });

    if (!response.ok) return;
    const access = await response.json();
    if (access.full_access === false) redirect("subscription_required");
  } catch (error) {
    /* A temporary check failure must not revoke an existing UI session. */
  }
})();
