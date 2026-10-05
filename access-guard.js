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

  // Consent to personal data processing (shown once, before anything else).
  function showConsent(policyUrl, initData) {
    if (document.getElementById("kz-consent")) return;
    var css = "#kz-consent{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(40,34,28,.42);font-family:'Helvetica Neue',Arial,sans-serif}" +
      "#kz-consent .box{width:min(100%,520px);max-height:92vh;overflow:auto;box-sizing:border-box;padding:28px 24px calc(24px + env(safe-area-inset-bottom));border-radius:28px 28px 0 0;background:#faf8f4;color:#2c3134;box-shadow:0 -20px 60px rgba(60,40,20,.25)}" +
      "#kz-consent .eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#a96c22}" +
      "#kz-consent h2{margin:10px 0 12px;font-weight:300;font-size:24px;line-height:1.15}" +
      "#kz-consent p{margin:0 0 12px;font-size:15px;line-height:1.55;color:#4d5458}" +
      "#kz-consent a{color:#a96c22}" +
      "#kz-consent button{width:100%;min-height:54px;margin-top:8px;border:0;border-radius:999px;color:#fff;font-size:16px;background:linear-gradient(115deg,#8c5517,#a96c22 30%,#c38a3d 60%,#b0722a);box-shadow:0 12px 26px rgba(128,78,20,.25);cursor:pointer}" +
      "#kz-consent button:disabled{opacity:.6}";
    var style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
    var wrap = document.createElement("div"); wrap.id = "kz-consent"; wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-modal", "true");
    wrap.innerHTML = '<div class="box"><div class="eyebrow">к Женщине</div><h2>Согласие на обработку персональных данных</h2>' +
      '<p>Чтобы открыть тебе пространство, записывать на встречи и присылать важные сообщения, нам нужно обрабатывать твои данные: имя, имя пользователя и ID в Telegram, а также то, что ты сама укажешь (телефон, email, город).</p>' +
      '<p>Нажимая «Согласна», ты подтверждаешь, что ознакомилась с <a href="#" id="kz-policy">Политикой обработки персональных данных</a> и даёшь согласие на обработку своих данных на её условиях. Отозвать согласие можно в любой момент, написав нам.</p>' +
      '<button type="button" id="kz-agree">Согласна</button></div>';
    document.body.appendChild(wrap);
    document.getElementById("kz-policy").addEventListener("click", function (e) {
      e.preventDefault();
      var wa = window.Telegram && window.Telegram.WebApp;
      if (wa && wa.openLink && /^https?:/.test(policyUrl)) wa.openLink(policyUrl); else window.open(policyUrl, "_blank", "noopener");
    });
    document.getElementById("kz-agree").addEventListener("click", function () {
      var btn = this; btn.disabled = true; btn.textContent = "Сохраняем…";
      fetch("/api/auth/access", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ initData: initData, consent: true }) })
        .then(function (r) { if (!r.ok) throw new Error(); window.location.reload(); })
        .catch(function () { btn.disabled = false; btn.textContent = "Не получилось — нажми ещё раз"; });
    });
  }

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
    if (access.consent === false) { showConsent(access.policy_url, initData); return; }
    if (access.full_access === false) {
      if (kind !== "entry") go("/index.html?access=subscription_required");
      return;
    }
    if (access.full_access !== true || kind === "app") return;
    // Opened on purpose from the app (e.g. "Открыть ритуал" on "Пространство"): no redirect.
    if (kind === "ritual" && /[?&]open=1(&|$)/.test(window.location.search)) return;
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
