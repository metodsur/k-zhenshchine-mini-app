// Shared buttons behaviour for app pages.
//  [data-link="key"]  → link set on the admin page ("Ссылки"); without it the button says "Скоро".
//  [data-href="/page"] → an in-app page.
//  [data-club-pay]     → club payment (Tribute); for club members it becomes "Перейти в клуб".
(function appLinks() {
  var CLUB_PAYMENT_URL = "https://t.me/tribute/app?startapp=s17IJ";
  var webApp = window.Telegram && window.Telegram.WebApp;

  function openUrl(url) {
    if (!url) return;
    if (url.charAt(0) === "/") { window.location.href = url; return; }
    if (webApp && webApp.initData) {
      if (/^https:\/\/t\.me\//.test(url) && webApp.openTelegramLink) return webApp.openTelegramLink(url);
      if (webApp.openLink) return webApp.openLink(url);
    }
    window.open(url, "_blank", "noopener");
  }
  function setLabel(el, text) {
    var arrow = el.querySelector("span, strong, b");
    el.textContent = text + " ";
    if (arrow) el.appendChild(arrow); else { var s = document.createElement("span"); s.textContent = "→"; el.appendChild(s); }
  }

  // Shared request for the public schedule (links, prices, dates); other scripts may reuse it.
  window.kzSchedule = window.kzSchedule || fetch("/api/schedule", { cache: "no-store" })
    .then(function (r) { return r.json(); }).catch(function () { return null; });

  function bind() {
    document.querySelectorAll("[data-href]").forEach(function (el) {
      el.addEventListener("click", function (e) { e.preventDefault(); openUrl(el.getAttribute("data-href")); });
    });
    document.querySelectorAll("[data-link]").forEach(function (el) {
      el.addEventListener("click", function (e) { e.preventDefault(); openUrl(el.getAttribute("data-url")); });
    });
    document.querySelectorAll("[data-club-pay]").forEach(function (el) {
      el.addEventListener("click", function (e) { e.preventDefault(); openUrl(el.getAttribute("data-url") || CLUB_PAYMENT_URL); });
    });

    window.kzSchedule.then(function (data) {
      var links = (data && data.links) || {};
      document.querySelectorAll("[data-link]").forEach(function (el) {
        var url = links[el.getAttribute("data-link")];
        if (url) el.setAttribute("data-url", url);
        else { el.classList.add("is-soon"); el.setAttribute("aria-disabled", "true"); setLabel(el, "Скоро"); }
      });
    });

    var clubButtons = document.querySelectorAll("[data-club-pay]");
    var initData = webApp && webApp.initData;
    if (!clubButtons.length || !initData) return;
    fetch("/api/auth/access", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ initData: initData, club: true }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (access) {
        if (!access || !access.club || !access.club.member) return;
        clubButtons.forEach(function (el) {
          el.setAttribute("data-url", access.club.url || CLUB_PAYMENT_URL);
          setLabel(el, access.club.url ? "Перейти в клуб" : "Я в клубе");
        });
      })
      .catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
})();
