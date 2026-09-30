(async function enforceChannelAccess() {
  var path = window.location.pathname.replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  // Public entry page and the one-time start (onboarding) pages.
  var ENTRY = ["/", "/index"];
  var ONBOARDING = ["/welcome-personal-telegram-ready", "/welcome-mission", "/rituals", "/welcome-rituals"];
  var kind = ENTRY.indexOf(path) !== -1 ? "entry" : ONBOARDING.indexOf(path) !== -1 ? "onboarding" : "app";
  var MAIN_PAGE = "/space.html";
  var FIRST_START_PAGE = "/welcome-personal-telegram-ready.html";

  function go(url) { if (window.location.pathname !== url) window.location.replace(url); }

  async function getTelegramInitData() {
    for (var attempt = 0; attempt < 20; attempt += 1) {
      var webApp = window.Telegram && window.Telegram.WebApp;
      if (webApp && webApp.initData) {
        webApp.ready();
        return webApp.initData;
      }
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
    return "";
  }

  try {
    var initData = await getTelegramInitData();
    if (!initData) return;

    var response = await fetch("/api/auth/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ initData: initData, mark: kind === "app" ? "onboarded" : undefined })
    });

    if (!response.ok) return;
    var access = await response.json();
    if (access.full_access === false) {
      if (kind !== "entry") go("/index.html?access=subscription_required");
      return;
    }
    if (access.full_access !== true) return;
    // Returning members skip the start pages and land in "Пространство".
    if (kind !== "app" && access.onboarded) go(MAIN_PAGE);
    // A member who has not seen the start pages yet begins with them.
    else if (kind === "entry" && !access.onboarded) go(FIRST_START_PAGE);
  } catch (error) {
    /* A temporary check failure must not revoke an existing UI session. */
  }
})();
