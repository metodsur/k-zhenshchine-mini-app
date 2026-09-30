// Shared Telegram Mini App shell for every app page.
// Keeps the app full-height so the fixed bottom menu does not drift on iOS.
(function setupTelegramShell() {
  var webApp = window.Telegram && window.Telegram.WebApp;
  if (!webApp || !webApp.initData) return;

  try { webApp.ready(); } catch (e) {}
  try { webApp.expand(); } catch (e) {}
  // Scrolling up must scroll the page, not start collapsing the Telegram sheet
  // (the sheet resize is what leaves the fixed menu stuck mid-screen on iPhone).
  try { if (typeof webApp.disableVerticalSwipes === "function") webApp.disableVerticalSwipes(); } catch (e) {}

  function repaintNav() {
    var nav = document.querySelector(".nav");
    if (!nav) return;
    // Force WebKit to recompute the fixed layer against the new viewport.
    nav.style.transform = "translateX(-50%) translateZ(0)";
    void nav.offsetHeight;
    nav.style.transform = "";
  }

  try {
    webApp.onEvent("viewportChanged", function (event) {
      if (!event || event.isStateStable) repaintNav();
      if (!webApp.isExpanded) { try { webApp.expand(); } catch (e) {} }
    });
  } catch (e) {}

  window.addEventListener("pageshow", repaintNav);
  window.addEventListener("orientationchange", function () { setTimeout(repaintNav, 250); });
})();
