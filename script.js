/* Place your JavaScript in this file */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- config */
  var SRC          = "https://chat-widget.produs1.ciscoccservice.com/js/imichatinit.js";
  var READY_EVENT  = "imichat-widget:ready";
  var WATCHDOG_MS  = 10000;
  var DEBUG        = /[?&]wxccdebug=1/.test(location.search);

  /* Pages where the launcher must never appear, so it cannot cover a
     conversion step or sit over a PCI form. */
  var SUPPRESS_ON = [
    /^\/checkout/,
    /^\/payment/,
    /^\/legal\/esign/
  ];

  /* ----------------------------------------------------------------- state */
  var failureReported = false;
  var widgetReady     = false;
  var lastFocus       = null;

  var anchorEl   = document.getElementById("divicw");
  var ctaEl      = document.getElementById("wxcc-cta");
  var fallbackEl = document.getElementById("wxcc-fallback");

  /* ----------------------------------------------------------------- utils */
  function log() {
    if (DEBUG && window.console) console.log.apply(console, arguments);
  }

  function suppressed() {
    return SUPPRESS_ON.some(function (re) { return re.test(location.pathname); });
  }

  /* ------------------------------------------------- 2. failure analytics */
  function reportFailure(reason) {
    if (failureReported) return;      // one beacon per page view
    failureReported = true;
    log("widget failure:", reason);

    var payload = {
      reason: reason,
      path: location.pathname,
      ua: navigator.userAgent
    };

    /* Swap these for your real analytics client. sendBeacon survives unload. */
    if (window.analytics && typeof analytics.track === "function") {
      analytics.track("chat_widget_failed", payload);
    } else if (navigator.sendBeacon) {
      try {
        navigator.sendBeacon("/api/telemetry/chat-widget",
          new Blob([JSON.stringify(payload)], { type: "application/json" }));
      } catch (e) { /* telemetry must never break the page */ }
    }
  }

  /* ------------------------------------------- 1 & 5. fallback dialog UX */
  function onFallbackKey(e) {
    if (e.key === "Escape" || e.key === "Esc") hideFallback();
  }

  function showFallback() {
    if (!fallbackEl || !fallbackEl.hidden) return;
    lastFocus = document.activeElement;
    fallbackEl.hidden = false;
    fallbackEl.querySelector(".wxcc-close").focus();
    document.addEventListener("keydown", onFallbackKey);
  }

  function hideFallback() {
    if (!fallbackEl || fallbackEl.hidden) return;
    fallbackEl.hidden = true;
    document.removeEventListener("keydown", onFallbackKey);   /* listener is removed */
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function failHard(reason) {
    reportFailure(reason);
    showFallback();
    if (ctaEl) ctaEl.disabled = true;
  }

  /* ------------------------------------------------------ 3. clean loader */
  function loadWidget() {
    if (!anchorEl) return;

    var s = document.createElement("script");
    s.src         = SRC;               /* no ?t= cache-buster */
    s.async       = true;
    s.crossOrigin = "anonymous";

    s.addEventListener("load",  function () { log("loader fetched"); });
    s.addEventListener("error", function () { failHard("script_load_error"); });

    anchorEl.insertAdjacentElement("afterend", s);

    /* ------------------------------------------------- 4. silent-failure watchdog
       Catches what the stock error handler cannot: a proxy returning an empty
       200, a CSP block, or a script that parses but never initialises. */
    setTimeout(function () {
      if (!widgetReady) failHard("ready_timeout");
    }, WATCHDOG_MS);

    /* The SDK attaches window.imichatwidget asynchronously, so poll briefly
       for the global before we can register the ready handler on it. */
    var tries = 0;
    var poll = setInterval(function () {
      if (window.imichatwidget) {
        clearInterval(poll);
        bindReadyHandler();
      } else if (++tries * 100 >= WATCHDOG_MS) {
        clearInterval(poll);
      }
    }, 100);
  }

  /* ------------------------------------------------- 4 & 7. readiness gate */
  function bindReadyHandler() {
    try {
      imichatwidget.on(READY_EVENT, function (appId) {
        widgetReady = true;
        log("widget ready", appId);
        hideFallback();                 /* in case a slow load beat the watchdog */
        seedMetadata();
        if (ctaEl && !suppressed()) ctaEl.disabled = false;
        maybeAutoOpen();
      });
    } catch (e) {
      failHard("ready_bind_error");
    }
  }

  /* ------------------------------------------------ 7. seed custom fields
     Every key below MUST already exist as a custom chat field in the Webex
     Engage client admin console. Unknown keys are ignored silently — the SDK
     does not throw — so a typo here fails invisibly. Verify before shipping. */
  function buildPayload(extra) {
    var fields = {
      "Account Tier": getAccountTier(),
      "Product Area": getProductArea(),
      "Page URL":     location.pathname,
      "Session ID":   getSessionId()
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) fields[k] = extra[k];
      }
    }
    return JSON.stringify({ custom_chat_fields: fields });
  }

  function seedMetadata() {
    try {
      imichatwidget.init(buildPayload(), function (response) {
        log("init ack", response);
      });
    } catch (e) {
      log("init failed", e);
    }
  }

  /* On SPA route changes, refresh context so the agent sees where the customer
     is now. Note: init() is not retroactive — it will not re-tag chats that
     were already created from the widget. */
  function refreshMetadata() {
    if (!widgetReady || typeof imichatwidget.update !== "function") return;
    imichatwidget.update(buildPayload(), function (r) { log("update ack", r); });

    if (suppressed()) {
      hideLauncher();
      if (ctaEl) ctaEl.disabled = true;
    }
  }

  /* -------------------------------------------------- 6 & 8. show / suppress */
  function openChat() {
    if (!widgetReady) { failHard("cta_before_ready"); return; }
    anchorEl.classList.remove("wxcc-hidden");
    imichatwidget.show();
    if (typeof imichatwidget.maximizeWindow === "function") imichatwidget.maximizeWindow();
    track("chat_opened", { source: "cta" });
  }

  function hideLauncher() {
    if (widgetReady && typeof imichatwidget.hide === "function") imichatwidget.hide();
    if (anchorEl) anchorEl.classList.add("wxcc-hidden");
  }

  /* Auto-open on one high-intent page only. Sitewide auto-open trains
     customers to dismiss the widget on reflex. */
  function maybeAutoOpen() {
    if (location.pathname.indexOf("/support/contact") === 0) openChat();
  }

  /* ------------------------------------------------ 8. abandonment guard */
  function guardAbandonment() {
    window.addEventListener("beforeunload", function (e) {
      if (!widgetReady || typeof imichatwidget.hasInitiatedChat !== "function") return;
      if (imichatwidget.hasInitiatedChat()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  /* ------------------------------------------------------------- app hooks
     Replace these four stubs with your real data layer. */
  function getAccountTier() { return (window.APP_USER && APP_USER.tier) || "Unknown"; }
  function getSessionId()   { return (window.APP_USER && APP_USER.sessionId) || ""; }
  function getProductArea() { return document.body.getAttribute("data-product-area") || "General"; }
  function track(evt, props) {
    if (window.analytics && typeof analytics.track === "function") analytics.track(evt, props);
  }

  /* ----------------------------------------------------------- bootstrap */
  if (fallbackEl) {
    fallbackEl.querySelector(".wxcc-close").addEventListener("click", hideFallback);
  }
  if (ctaEl) ctaEl.addEventListener("click", openChat);

  if (suppressed()) {
    log("launcher suppressed on", location.pathname);
  } else {
    loadWidget();
    guardAbandonment();
  }

  window.addEventListener("popstate", refreshMetadata);

  /* If you use a history-based SPA router, also call refreshMetadata() from
     your router's navigation hook — popstate does not fire on pushState. */
  window.wxccRefreshChatContext = refreshMetadata;
})();
