(async function enforceChannelAccess() {
  const publicPage = "/index.html";
  try {
    const telegram = window.Telegram && window.Telegram.WebApp;
    const initData = telegram && telegram.initData;
    if (!initData) throw new Error("Telegram authorization is unavailable");

    const response = await fetch("/api/auth/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ initData })
    });
    const access = await response.json();
    if (!response.ok || access.full_access !== true) {
      window.location.replace(`${publicPage}?access=subscription_required`);
    }
  } catch (error) {
    window.location.replace(`${publicPage}?access=authorization_required`);
  }
})();
