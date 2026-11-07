(function () {
  "use strict";
  var STORAGE_KEY = "kz.practiceRemote.v1";
  var paths = ["/practice", "/integrity", "/accept", "/abundance", "/mirror"];
  var device = null;
  var timer = null;
  var busy = false;

  function getInitData() {
    var wa = window.Telegram && window.Telegram.WebApp;
    return wa && typeof wa.initData === "string" ? wa.initData : "";
  }
  function readSaved() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && /^[a-f0-9-]{36}$/.test(saved.deviceId) && /^[a-f0-9]{64}$/.test(saved.token)) return saved;
    } catch (_) {}
    return null;
  }
  function persist(value) {
    try { if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }
  function newId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }
  function post(payload) {
    return fetch("/api/practice-remote", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify(Object.assign({ initData: getInitData() }, payload))
    }).then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || "Ошибка управления"); return data; }); });
  }
  function showControl(enabled) {
    if (window.location.pathname !== "/practice") return;
    var card = document.getElementById("practice-remote-control");
    if (!card) {
      card = document.createElement("section");
      card.id = "practice-remote-control";
      card.className = "surface";
      card.style.cssText = "margin:16px 0;padding:16px;border:1px solid rgba(183,122,43,.22);border-radius:18px";
      card.innerHTML = '<div style="font-size:.85rem;margin-bottom:10px">Удалённое управление практиками · только для владелицы</div><div id="practice-remote-status" role="status" style="font-size:.8rem;opacity:.8;margin-bottom:10px"></div><button id="practice-remote-toggle" type="button" style="padding:10px 14px;border:0;border-radius:999px;background:#a96c22;color:#fff;font:inherit;cursor:pointer"></button>';
      var main = document.querySelector("main.app");
      if (main) main.appendChild(card);
      document.getElementById("practice-remote-toggle").addEventListener("click", toggle);
    }
    var button = document.getElementById("practice-remote-toggle");
    var status = document.getElementById("practice-remote-status");
    if (button) { button.disabled = busy; button.textContent = enabled ? "Выключить удалённое управление" : "Включить на этом устройстве на 30 минут"; }
    if (status) status.textContent = enabled ? "Приём команд включён на этом устройстве. Не закрывайте Telegram Mini App." : "Приём команд выключен.";
  }
  function poll() {
    if (!device || busy) return;
    fetch("/api/practice-remote?deviceId=" + encodeURIComponent(device.deviceId), {
      headers: { Authorization: "Bearer " + device.token, "X-Telegram-Init-Data": getInitData() }, cache: "no-store"
    }).then(function (r) {
      if (r.status === 403) { if (timer) clearInterval(timer); timer = null; return null; }
      if (r.status === 401) { device = null; persist(null); if (timer) clearInterval(timer); showControl(false); return null; }
      if (!r.ok) return null;
      return r.json();
    }).then(function (result) {
      var command = result && result.command;
      if (command && paths.indexOf(command.path) !== -1 && /^[a-f0-9-]{36}$/.test(command.id)) {
        window.location.replace(command.path);
      }
    }).catch(function () {});
  }
  function startPolling() {
    if (timer) clearInterval(timer);
    if (!device) return;
    poll();
    timer = setInterval(poll, 4000);
  }
  function toggle() {
    if (busy) return;
    busy = true;
    showControl(Boolean(device));
    if (device) {
      var previous = device;
      post({ action: "disable", deviceId: previous.deviceId }).then(function () {
        device = null; persist(null); if (timer) clearInterval(timer); showControl(false);
      }).catch(function (error) { setMessage(error.message); }).finally(function () { busy = false; showControl(Boolean(device)); });
      return;
    }
    var id = newId();
    post({ action: "enable", deviceId: id }).then(function (result) {
      device = { deviceId: id, token: result.token }; persist(device); showControl(true); startPolling();
    }).catch(function (error) { setMessage(error.message); }).finally(function () { busy = false; showControl(Boolean(device)); });
  }
  function setMessage(text) {
    var status = document.getElementById("practice-remote-status");
    if (status) status.textContent = text;
  }
  function init() {
    if (paths.indexOf(window.location.pathname) === -1) return;
    var saved = readSaved();
    if (saved) { device = saved; startPolling(); }
    if (window.location.pathname !== "/practice") return;
    var initData = getInitData();
    if (!initData) return;
    post({ action: "status", deviceId: saved ? saved.deviceId : undefined }).then(function (result) {
      if (!result.isOwner) return;
      showControl(Boolean(result.enabled && device));
    }).catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
