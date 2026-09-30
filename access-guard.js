(async function enforceChannelAccess() {
  var path = window.location.pathname.replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  // Start flow: entry page → start pages → ritual page → (button "Пройти ритуал в Telegram") → app.
  var ENTRY = ["/", "/index"];
  var START_PAGES = ["/welcome-personal-telegram-ready", "/welcome-mission", "/welcome-rituals"];
  var RITUAL_PAGE = "/rituals";
  var kind = ENTRY.indexOf(path) !== -1 ? "entry" : START_PAGES.indexOf(path) !== -1 ? "start" : path === RITUAL_PAGE ? "ritual" : "app";
  var MAIN_PAGE = "/space.html";
  var FIRST_START_PAGE = "/welcome-personal-telegram-ready.html";
  var RITUAL_URL = "/rituals.html";

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
      body: JSON.stringify({ initData: initData, mark: kind === "ritual" ? "rituals_seen" : undefined })
    });

    if (!response.ok) return;
    var access = await response.json();
    if (access.full_access === false) {
      if (kind !== "entry") go("/index.html?access=subscription_required");
      return;
    }
    if (access.full_access !== true || kind === "app") return;
    // Ritual button pressed: every entry opens "Пространство".
    if (access.onboarded) return go(MAIN_PAGE);
    // Reached the ritual page but has not pressed the button yet: back to the ritual page.
    if (access.rituals_seen && kind !== "ritual") return go(RITUAL_URL);
    // First visit as a member: the start pages from the beginning.
    if (kind === "entry") go(FIRST_START_PAGE);
  } catch (error) {
    /* A temporary check failure must not revoke an existing UI session. */
  }
})();
