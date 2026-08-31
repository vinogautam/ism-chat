/*
 * Shared chat logic. Each page sets window.CHAT_CONFIG = { me: 1|2, peerName: '...' }
 * before loading this file. Sender 1 = index.html, sender 2 = me.html.
 *
 * Realtime DB layout:
 *   /<yyyy-mm-dd>/<pushId>  -> { sender, ts, msg }
 *   /<yyyy-mm-dd>/clear     -> ts of the last "clear chat"
 *   /presence/u<id>         -> { online, lastSeen }
 *   /typing/u<id>           -> true while composing
 *   /read/<yyyy-mm-dd>/u<id>-> ts of the newest message that user has read
 *   /call                   -> WebRTC signaling {from,status,offer,answer,ice}
 */
(function () {
  var firebaseConfig = {
    apiKey: "AIzaSyDKG2g_JD6iFH0qgTeOzCGdEZprHdL1B3c",
    authDomain: "ism-chat-ea48a.firebaseapp.com",
    databaseURL: "https://ism-chat-ea48a-default-rtdb.firebaseio.com/",
    projectId: "ism-chat-ea48a",
    storageBucket: "ism-chat-ea48a.appspot.com",
    messagingSenderId: "902636413859",
    appId: "1:902636413859:web:2496478a858c50b9adf016"
  };
  firebase.initializeApp(firebaseConfig);

  var cfg = window.CHAT_CONFIG || {};
  var ME = cfg.me === 2 ? 2 : 1;
  var PEER = ME === 1 ? 2 : 1;
  var PUSH_VAPID_KEY = cfg.pushVapidKey || "";

  var today = new Date().toJSON().split("T")[0];
  var db = firebase.database();
  var msgsRef = db.ref("/" + today);
  var clearRef = db.ref("/" + today + "/clear");
  var myStateRef = db.ref("/presence/u" + ME);
  var peerStateRef = db.ref("/presence/u" + PEER);
  var myTypingRef = db.ref("/typing/u" + ME);
  var peerTypingRef = db.ref("/typing/u" + PEER);
  var myReadRef = db.ref("/read/" + today + "/u" + ME);
  var peerReadRef = db.ref("/read/" + today + "/u" + PEER);

  var el = {
    list: document.getElementById("msg-container"),
    input: document.getElementById("msg"),
    send: document.getElementById("send-msg"),
    form: document.getElementById("composer"),
    clear: document.getElementById("clear"),
    statusWrap: document.getElementById("peer-status"),
    statusText: document.getElementById("peer-status-text"),
    pill: document.getElementById("unread-pill"),
    jump: document.getElementById("jump"),
    jumpCount: document.getElementById("jump-count"),
    peerName: document.getElementById("peer-name"),
    avatar: document.getElementById("peer-avatar"),
    callBtn: document.getElementById("call-btn"),
    notifBtn: document.getElementById("notif-btn")
  };

  var peerName = cfg.peerName || "Friend";
  el.peerName.textContent = peerName;
  el.avatar.textContent = peerName.charAt(0).toUpperCase();
  var baseTitle = document.title;

  var messages = [];
  var clearval = new Date(today + " 00:00").getTime();
  var peerRead = 0;
  var myRead = 0;
  var unreadFrom = 0; // my read marker when the page was opened, drives the divider
  var peerOnline = false;
  var peerLastSeen = 0;
  var peerTyping = false;
  var pendingNew = 0;
  var pillDismissed = false;
  var notifyEnabled = localStorage.getItem("ismChatNotify") === "1";
  var notifiedUpTo = 0;
  var activeNotif = null;
  var messaging = null;
  var pushTokenRef = null;
  var pushReady = false;
  var swReg = null;

  /* ---------- helpers ---------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function linkify(s) {
    return s.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      return '<a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>";
    });
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var h = d.getHours();
    var m = d.getMinutes();
    var ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + (m < 10 ? "0" : "") + m + " " + ap;
  }

  function dayLabel(ts) {
    var d = new Date(ts);
    var now = new Date();
    var diff = Math.round(
      (new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
        new Date(d.getFullYear(), d.getMonth(), d.getDate())) /
        86400000
    );
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  }

  function lastSeenLabel(ts) {
    if (!ts) return "offline";
    var label = dayLabel(ts);
    return "last seen " + label.toLowerCase() + " at " + fmtTime(ts);
  }

  function nearBottom() {
    return el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 80;
  }

  function scrollToBottom(smooth) {
    el.list.scrollTo({
      top: el.list.scrollHeight,
      behavior: smooth ? "smooth" : "auto"
    });
  }

  function visible() {
    return document.visibilityState !== "hidden";
  }

  function tickHtml(m) {
    var read = peerRead >= m.ts;
    var delivered = read || peerOnline;
    var path = delivered
      ? "M1 6.2 3.4 8.6 8.6 3.4M6.4 6.2 8.8 8.6 14 3.4"
      : "M2 6.2 4.6 8.8 11 2.4";
    return (
      '<svg class="tick' +
      (read ? " read" : "") +
      '" viewBox="0 0 16 12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="' +
      path +
      '"/></svg>'
    );
  }

  /* ---------- rendering ---------- */

  function visibleMessages() {
    return messages
      .filter(function (m) {
        return m.ts > clearval;
      })
      .sort(function (a, b) {
        return a.ts - b.ts;
      });
  }

  function render() {
    var list = visibleMessages();
    var stick = nearBottom();

    if (!list.length) {
      el.list.innerHTML =
        '<div class="empty"><strong>No messages yet</strong>' +
        "Say hi to " +
        escapeHtml(peerName) +
        " — messages reset every day.</div>";
      updateBadges(list);
      return;
    }

    var html = '<div class="day-divider"><span>' + dayLabel(list[0].ts) + "</span></div>";
    var dividerDone = false;

    list.forEach(function (m, i) {
      var mine = m.sender === ME;
      if (!mine && !dividerDone && m.ts > unreadFrom) {
        html += '<div class="unread-divider"><span>Unread messages</span></div>';
        dividerDone = true;
      }
      var prev = list[i - 1];
      var grouped =
        prev && prev.sender === m.sender && m.ts - prev.ts < 3 * 60 * 1000 &&
        !(dividerDone && !mine && prev.ts <= unreadFrom);

      html +=
        '<div class="row ' +
        (mine ? "me" : "you") +
        (grouped ? " grouped" : "") +
        '"><div class="bubble"><div class="text">' +
        linkify(escapeHtml(m.msg)) +
        '</div><div class="meta"><span class="time">' +
        fmtTime(m.ts) +
        "</span>" +
        (mine ? tickHtml(m) : "") +
        "</div></div></div>";
    });

    if (peerTyping) {
      html += '<div class="typing"><i></i><i></i><i></i></div>';
    }

    el.list.innerHTML = html;
    if (stick) scrollToBottom(false);
    updateBadges(list);
  }

  function updateBadges(list) {
    var unread = list.filter(function (m) {
      return m.sender === PEER && m.ts > myRead;
    }).length;

    document.title = unread ? "(" + unread + ") " + baseTitle : baseTitle;

    var sinceOpen = list.filter(function (m) {
      return m.sender === PEER && m.ts > unreadFrom;
    }).length;
    if (sinceOpen && !pillDismissed) {
      el.pill.textContent = sinceOpen;
      el.pill.hidden = false;
    } else {
      el.pill.hidden = true;
    }

    if (nearBottom()) pendingNew = 0;
    el.jump.hidden = nearBottom();
    el.jumpCount.textContent = pendingNew ? pendingNew + " new" : "Latest";
  }

  function renderStatus() {
    el.statusWrap.classList.toggle("is-online", peerOnline && !peerTyping);
    el.statusWrap.classList.toggle("is-typing", peerTyping);
    el.statusText.textContent = peerTyping
      ? "typing…"
      : peerOnline
      ? "online"
      : lastSeenLabel(peerLastSeen);
    render();
  }

  /* ---------- read receipts ---------- */

  function markRead() {
    if (!visible()) return;
    var last = 0;
    visibleMessages().forEach(function (m) {
      if (m.sender === PEER && m.ts > last) last = m.ts;
    });
    if (last > myRead) {
      myRead = last;
      myReadRef.set(last);
      updateBadges(visibleMessages());
    }
  }

  /* ---------- notifications ---------- */

  /* Notifications never carry message text: the peer name and a count only. */
  function notifySupported() {
    return "Notification" in window;
  }

  function notifyOn() {
    return notifyEnabled && notifySupported() && Notification.permission === "granted";
  }

  function updateNotifBtn() {
    if (!el.notifBtn) return;
    var on = notifyOn();
    el.notifBtn.classList.toggle("is-on", on);
    el.notifBtn.title = on ? "Notifications on" : "Notifications off";
    el.notifBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function toggleNotifications() {
    if (!notifySupported()) {
      alert("This browser does not support notifications.");
      return;
    }
    if (notifyOn()) {
      notifyEnabled = false;
      localStorage.setItem("ismChatNotify", "0");
      unregisterPushToken();
      updateNotifBtn();
      return;
    }
    if (Notification.permission === "denied") {
      alert(
        "Notifications are blocked for this site. Allow them in your browser's site settings."
      );
      return;
    }
    Notification.requestPermission().then(function (perm) {
      notifyEnabled = perm === "granted";
      localStorage.setItem("ismChatNotify", notifyEnabled ? "1" : "0");
      updateNotifBtn();
      if (!notifyEnabled) return;
      showNotification("Notifications on", "You'll be alerted about new messages.", true);
      registerPushToken().catch(function (err) {
        console.warn("Background push is not ready:", err);
      });
    });
  }

  function tokenKey(token) {
    var hash = 2166136261;
    for (var i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash +=
        (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return "t" + (hash >>> 0).toString(36);
  }

  function validVapidKey() {
    return (
      PUSH_VAPID_KEY &&
      PUSH_VAPID_KEY !== "PASTE_FIREBASE_WEB_PUSH_VAPID_KEY_HERE"
    );
  }

  function thisPage() {
    return ME === 1 ? "index.html" : "me.html";
  }

  function ensureServiceWorker() {
    if (swReg) return Promise.resolve(swReg);
    if (!("serviceWorker" in navigator)) {
      return Promise.reject(new Error("No service worker"));
    }
    return navigator.serviceWorker
      .register("./firebase-messaging-sw.js")
      .then(function (registration) {
        swReg = registration;
        return registration;
      });
  }

  function savePushToken(token) {
    var key = tokenKey(token);
    pushTokenRef = db.ref("/pushTokens/u" + ME + "/" + key);
    return pushTokenRef
      .set({
        token: token,
        page: thisPage(),
        updated: firebase.database.ServerValue.TIMESTAMP
      })
      .then(function () {
        pushReady = true;
      });
  }

  function registerPushToken() {
    if (!notifyOn()) return Promise.reject(new Error("Notifications are off."));
    if (!("serviceWorker" in navigator) || !firebase.messaging) {
      return Promise.reject(new Error("Background push is unsupported."));
    }
    return ensureServiceWorker().then(function (registration) {
      messaging = firebase.messaging();
      messaging.useServiceWorker(registration);
      if (validVapidKey()) messaging.usePublicVapidKey(PUSH_VAPID_KEY);
      return messaging.getToken();
    })
      .then(function (token) {
        if (!token) throw new Error("FCM did not return a device token.");
        return savePushToken(token);
      });
  }

  function unregisterPushToken() {
    pushReady = false;
    var remove = pushTokenRef ? pushTokenRef.remove() : Promise.resolve();
    pushTokenRef = null;
    if (messaging) {
      remove.then(function () {
        return messaging.getToken();
      }).then(function (token) {
        if (token) messaging.deleteToken(token);
      }).catch(function () {});
    }
  }

  function notificationOptions(body) {
    return {
      body: body,
      tag: "ism-chat",
      renotify: true,
      data: { page: thisPage() }
    };
  }

  function showViaConstructor(title, body) {
    try {
      activeNotif = new Notification(title, notificationOptions(body));
      activeNotif.onclick = function () {
        window.focus();
        closeNotification();
        markRead();
      };
      return true;
    } catch (e) {
      return false;
    }
  }

  function showViaServiceWorker(title, body) {
    return ensureServiceWorker().then(function (registration) {
      return registration.showNotification(title, notificationOptions(body));
    });
  }

  function needsServiceWorkerNotify() {
    return /Android/i.test(navigator.userAgent);
  }

  function showNotification(title, body, force) {
    if (!notifyOn()) return;
    if (!force && visible() && document.hasFocus()) return;
    closeNotification();
    if (needsServiceWorkerNotify()) {
      showViaServiceWorker(title, body).catch(function () {
        showViaConstructor(title, body);
      });
      return;
    }
    if (!showViaConstructor(title, body)) {
      showViaServiceWorker(title, body).catch(function () {});
    }
  }

  function closeNotification() {
    if (activeNotif) {
      try {
        activeNotif.close();
      } catch (e) {}
      activeNotif = null;
    }
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration().then(function (registration) {
      if (!registration || !registration.getNotifications) return;
      return registration.getNotifications({ tag: "ism-chat" }).then(function (list) {
        list.forEach(function (n) {
          n.close();
        });
      });
    }).catch(function () {});
  }

  function notifyNewMessages(list) {
    var fresh = list.filter(function (m) {
      return m.sender === PEER && m.ts > notifiedUpTo;
    });
    if (!fresh.length) return;
    fresh.forEach(function (m) {
      if (m.ts > notifiedUpTo) notifiedUpTo = m.ts;
    });
    if (pushReady) return;
    showNotification(
      fresh.length > 1 ? fresh.length + " new messages" : "New message",
      peerName + " — open the chat to read."
    );
  }

  function initNotifications() {
    notifiedUpTo = Date.now();
    if (!notifySupported()) {
      if (el.notifBtn) el.notifBtn.hidden = true;
      return;
    }
    if (el.notifBtn) el.notifBtn.addEventListener("click", toggleNotifications);
    updateNotifBtn();
    if (notifyOn()) {
      ensureServiceWorker().catch(function () {});
      registerPushToken().catch(function (err) {
        console.warn("Background push is not ready:", err);
      });
    }
  }

  /* ---------- presence & typing ---------- */

  function initPresence() {
    db.ref(".info/connected").on("value", function (snap) {
      if (snap.val() === false) return;
      myStateRef.onDisconnect().set({
        online: false,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
      });
      myTypingRef.onDisconnect().remove();
      myStateRef.set({
        online: true,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
      });
    });

    peerStateRef.on("value", function (snap) {
      var v = snap.val() || {};
      peerOnline = !!v.online;
      peerLastSeen = v.lastSeen || 0;
      renderStatus();
    });

    peerTypingRef.on("value", function (snap) {
      peerTyping = !!snap.val();
      renderStatus();
    });
  }

  var typingTimer = null;
  function signalTyping() {
    myTypingRef.set(true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 2000);
  }

  function stopTyping() {
    clearTimeout(typingTimer);
    myTypingRef.remove();
  }

  /* ---------- voice call (WebRTC + Firebase signaling) ---------- */

  var callRef = db.ref("/call");
  var ICE_SERVERS = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  };
  var pc = null;
  var localStream = null;
  var remoteAudio = null;
  var callRole = null;
  var appliedAnswer = false;
  var pendingIce = [];
  var iceListener = null;
  var ringTimer = null;
  var durationTimer = null;
  var ringtoneTimer = null;
  var ringtoneCtx = null;
  var callBusy = false;
  var lastCallStatus = null;

  function ensureCallUi() {
    if (document.getElementById("call-overlay")) return;
    var wrap = document.createElement("div");
    wrap.id = "call-overlay";
    wrap.className = "call-overlay";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="call-pulse" id="call-avatar">F</div>' +
      "<h2 id=\"call-name\"></h2>" +
      '<div class="call-sub" id="call-sub">Calling…</div>' +
      '<div class="call-error" id="call-error"></div>' +
      '<div class="call-actions">' +
      '<div class="call-fab-wrap" id="wrap-mute"><button class="call-fab mute" id="mute-btn" type="button" aria-label="Mute">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 19v3"/></svg>' +
      "</button><span>Mute</span></div>" +
      '<div class="call-fab-wrap" id="wrap-accept"><button class="call-fab accept" id="accept-btn" type="button" aria-label="Accept">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.74-1.27a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z"/></svg>' +
      "</button><span>Accept</span></div>" +
      '<div class="call-fab-wrap" id="wrap-hangup"><button class="call-fab hangup" id="hangup-btn" type="button" aria-label="Hang up">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 6 6l1.74-1.27a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 24 20.31v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07"/><path d="M1 1l22 22"/><path d="M15.2 8.4A7 7 0 0 1 19 11M9.5 4.5A16 16 0 0 0 3.2 7.3 2 2 0 0 0 2 9.2v3a2 2 0 0 0 2.18 2c.5-.07.99-.18 1.46-.32"/></svg>' +
      "</button><span id=\"hangup-label\">Decline</span></div>" +
      "</div>";
    document.querySelector(".chat-app").appendChild(wrap);
    remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute("playsinline", "true");
    document.body.appendChild(remoteAudio);

    document.getElementById("accept-btn").addEventListener("click", acceptCall);
    document.getElementById("hangup-btn").addEventListener("click", function () {
      endCall(callRole === "callee" && lastCallStatus === "ringing" ? "declined" : "ended");
    });
    document.getElementById("mute-btn").addEventListener("click", toggleMute);
  }

  function showCallUi(mode, sub) {
    ensureCallUi();
    var overlay = document.getElementById("call-overlay");
    overlay.hidden = false;
    document.getElementById("call-name").textContent = peerName;
    document.getElementById("call-avatar").textContent = peerName.charAt(0).toUpperCase();
    document.getElementById("call-sub").textContent = sub || "";
    document.getElementById("call-error").textContent = "";
    document.getElementById("wrap-accept").hidden = mode !== "incoming";
    document.getElementById("wrap-mute").hidden = mode === "incoming";
    document.getElementById("hangup-label").textContent =
      mode === "incoming" ? "Decline" : "End";
    if (el.callBtn) el.callBtn.classList.toggle("call-active", mode !== "incoming");
  }

  function hideCallUi() {
    var overlay = document.getElementById("call-overlay");
    if (overlay) overlay.hidden = true;
    if (el.callBtn) el.callBtn.classList.remove("call-active");
    stopRingtone();
    stopDuration();
  }

  function setCallError(msg) {
    var node = document.getElementById("call-error");
    if (node) node.textContent = msg || "";
  }

  function startRingtone() {
    stopRingtone();
    try {
      ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      return;
    }
    function beep(freq, at) {
      var osc = ringtoneCtx.createOscillator();
      var g = ringtoneCtx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.07, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(g);
      g.connect(ringtoneCtx.destination);
      osc.start(at);
      osc.stop(at + 0.36);
    }
    function ring() {
      if (!ringtoneCtx) return;
      var t = ringtoneCtx.currentTime;
      beep(880, t);
      beep(988, t + 0.22);
    }
    ring();
    ringtoneTimer = setInterval(ring, 1400);
    if (navigator.vibrate) navigator.vibrate([180, 80, 180, 80, 400]);
  }

  function stopRingtone() {
    clearInterval(ringtoneTimer);
    ringtoneTimer = null;
    if (ringtoneCtx) {
      try {
        ringtoneCtx.close();
      } catch (e) {}
      ringtoneCtx = null;
    }
    if (navigator.vibrate) navigator.vibrate(0);
  }

  function startDuration() {
    stopDuration();
    var started = Date.now();
    function tick() {
      var s = Math.floor((Date.now() - started) / 1000);
      var m = Math.floor(s / 60);
      s = s % 60;
      var node = document.getElementById("call-sub");
      if (node) node.textContent = m + ":" + (s < 10 ? "0" : "") + s;
    }
    tick();
    durationTimer = setInterval(tick, 1000);
  }

  function stopDuration() {
    clearInterval(durationTimer);
    durationTimer = null;
  }

  function getMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false
    });
  }

  function createPc() {
    pc = new RTCPeerConnection(ICE_SERVERS);
    pendingIce = [];
    pc.onicecandidate = function (e) {
      if (e.candidate) {
        callRef.child("ice/u" + ME).push({
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex
        });
      }
    };
    pc.ontrack = function (e) {
      if (remoteAudio) {
        remoteAudio.srcObject = e.streams[0] || new MediaStream([e.track]);
        remoteAudio.play().catch(function () {});
      }
    };
    pc.onconnectionstatechange = function () {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        stopRingtone();
        startDuration();
        showCallUi("incall", "Connected");
      }
      if (pc.connectionState === "failed") {
        setCallError("Call failed — try again on the same Wi‑Fi or HTTPS.");
        setTimeout(function () {
          endCall("ended");
        }, 1500);
      }
    };
    if (localStream) {
      localStream.getTracks().forEach(function (t) {
        pc.addTrack(t, localStream);
      });
    }
    listenPeerIce();
  }

  function listenPeerIce() {
    if (iceListener) {
      callRef.child("ice/u" + PEER).off("child_added", iceListener);
    }
    iceListener = function (snap) {
      var c = snap.val();
      if (!c || !c.candidate) return;
      var cand = new RTCIceCandidate(c);
      if (pc && pc.remoteDescription) {
        pc.addIceCandidate(cand).catch(function () {});
      } else {
        pendingIce.push(cand);
      }
    };
    callRef.child("ice/u" + PEER).on("child_added", iceListener);
  }

  function flushIce() {
    if (!pc) return;
    pendingIce.forEach(function (c) {
      pc.addIceCandidate(c).catch(function () {});
    });
    pendingIce = [];
  }

  function armDisconnectCleanup() {
    callRef.onDisconnect().remove();
  }

  function startCall() {
    if (callBusy || callRole) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Voice calls need a modern browser.");
      return;
    }
    callBusy = true;
    callRole = "caller";
    showCallUi("outgoing", peerOnline ? "Calling…" : "Ringing (peer may be offline)…");
    getMic()
      .then(function (stream) {
        localStream = stream;
        createPc();
        return pc.createOffer();
      })
      .then(function (offer) {
        return pc.setLocalDescription(offer);
      })
      .then(function () {
        armDisconnectCleanup();
        return callRef.set({
          from: ME,
          to: PEER,
          status: "ringing",
          offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          ts: Date.now()
        });
      })
      .then(function () {
        callBusy = false;
        clearTimeout(ringTimer);
        ringTimer = setTimeout(function () {
          if (callRole === "caller" && lastCallStatus === "ringing") {
            endCall("ended");
          }
        }, 45000);
      })
      .catch(function (err) {
        callBusy = false;
        setCallError(micError(err));
        setTimeout(function () {
          endCall("ended");
        }, 1800);
      });
  }

  function acceptCall() {
    if (callBusy) return;
    callBusy = true;
    callRole = "callee";
    stopRingtone();
    showCallUi("connecting", "Connecting…");
    getMic()
      .then(function (stream) {
        localStream = stream;
        createPc();
        return callRef.once("value");
      })
      .then(function (snap) {
        var v = snap.val() || {};
        if (!v.offer) throw new Error("Call already ended");
        return pc.setRemoteDescription(new RTCSessionDescription(v.offer));
      })
      .then(function () {
        flushIce();
        return pc.createAnswer();
      })
      .then(function (answer) {
        return pc.setLocalDescription(answer);
      })
      .then(function () {
        armDisconnectCleanup();
        return callRef.update({
          status: "accepted",
          answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
        });
      })
      .then(function () {
        callBusy = false;
      })
      .catch(function (err) {
        callBusy = false;
        setCallError(micError(err));
        setTimeout(function () {
          endCall("ended");
        }, 1800);
      });
  }

  function micError(err) {
    var name = (err && err.name) || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "Mic permission denied — allow microphone and try again.";
    }
    if (name === "NotFoundError") return "No microphone found.";
    return (err && err.message) || "Could not start the call.";
  }

  function toggleMute() {
    if (!localStream) return;
    var live = localStream.getAudioTracks().some(function (t) {
      return t.enabled;
    });
    localStream.getAudioTracks().forEach(function (t) {
      t.enabled = !live;
    });
    document.getElementById("mute-btn").classList.toggle("is-on", live);
  }

  function endCall(status) {
    clearTimeout(ringTimer);
    var hadCall = !!callRole || !!pc;
    localHangup();
    if (hadCall) {
      callRef.onDisconnect().cancel();
      if (status === "declined") {
        callRef.update({ status: "declined" }).then(function () {
          setTimeout(function () {
            callRef.remove();
          }, 400);
        });
      } else {
        callRef.remove();
      }
    }
  }

  function localHangup() {
    callRole = null;
    callBusy = false;
    appliedAnswer = false;
    lastCallStatus = null;
    pendingIce = [];
    stopRingtone();
    stopDuration();
    if (iceListener) {
      callRef.child("ice/u" + PEER).off("child_added", iceListener);
      iceListener = null;
    }
    if (pc) {
      try {
        pc.close();
      } catch (e) {}
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(function (t) {
        t.stop();
      });
      localStream = null;
    }
    if (remoteAudio) remoteAudio.srcObject = null;
    hideCallUi();
  }

  function onRemoteCall(snap) {
    var v = snap.val();
    if (!v) {
      if (callRole || pc) localHangup();
      return;
    }
    lastCallStatus = v.status;
    if (v.status === "ended" || v.status === "declined") {
      localHangup();
      return;
    }
    if (v.from === PEER && v.status === "ringing" && !callRole) {
      callRole = "callee";
      showCallUi("incoming", "Incoming voice call");
      startRingtone();
      showNotification("Incoming voice call", peerName + " is calling.");
    }
    if (v.from === ME && v.status === "accepted" && callRole === "caller" && v.answer && pc && !appliedAnswer) {
      appliedAnswer = true;
      pc.setRemoteDescription(new RTCSessionDescription(v.answer))
        .then(flushIce)
        .catch(function () {
          setCallError("Could not connect.");
        });
    }
  }

  function initCall() {
    ensureCallUi();
    if (el.callBtn) {
      el.callBtn.addEventListener("click", startCall);
    }
    callRef.on("value", onRemoteCall);
  }

  /* ---------- wiring ---------- */

  function sendMessage() {
    var val = el.input.value.trim();
    if (!val) return;
    msgsRef.push({ sender: ME, ts: new Date().getTime(), msg: val });
    el.input.value = "";
    el.send.disabled = true;
    stopTyping();
    pillDismissed = true;
    scrollToBottom(true);
    el.input.focus();
  }

  el.form.addEventListener("submit", function (e) {
    e.preventDefault();
    sendMessage();
  });

  el.input.addEventListener("input", function () {
    el.send.disabled = !el.input.value.trim();
    if (el.input.value.trim()) signalTyping();
    else stopTyping();
  });

  el.input.addEventListener("focus", function () {
    pillDismissed = true;
    markRead();
  });

  el.jump.addEventListener("click", function () {
    pendingNew = 0;
    scrollToBottom(true);
  });

  el.list.addEventListener("scroll", function () {
    if (nearBottom()) {
      pendingNew = 0;
      markRead();
    }
    el.jump.hidden = nearBottom();
    el.jumpCount.textContent = pendingNew ? pendingNew + " new" : "Latest";
  });

  if (el.clear) {
    el.clear.addEventListener("click", function () {
      if (!confirm("Clear this chat for both of you?")) return;
      clearRef.set(new Date().getTime());
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (visible()) closeNotification();
    markRead();
  });
  window.addEventListener("focus", function () {
    closeNotification();
    markRead();
  });

  /* ---------- start ---------- */

  function start() {
    myRead = unreadFrom;
    initNotifications();
    initPresence();
    initCall();

    peerReadRef.on("value", function (snap) {
      peerRead = snap.val() || 0;
      render();
    });

    clearRef.on("value", function (snap) {
      if (snap.val()) {
        clearval = snap.val();
        render();
      }
    });

    msgsRef.on("value", function (snap) {
      var val = snap.val() || {};
      var prevCount = messages.length;
      messages = Object.keys(val)
        .map(function (k) {
          return val[k];
        })
        .filter(function (m) {
          return m && typeof m === "object" && m.ts && m.msg;
        });

      var atBottom = nearBottom();
      if (!atBottom && messages.length > prevCount) {
        pendingNew += messages.length - prevCount;
      }
      notifyNewMessages(visibleMessages());
      render();
      if (atBottom) scrollToBottom(false);
      markRead();
    });

    el.send.disabled = true;
    el.input.focus();
  }

  myReadRef
    .once("value")
    .then(function (snap) {
      unreadFrom = snap.val() || 0;
      start();
    })
    .catch(start);
})();
