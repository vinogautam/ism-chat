/* Background Firebase Cloud Messaging handler. */
importScripts("https://www.gstatic.com/firebasejs/5.5.8/firebase-app.js");
importScripts("https://www.gstatic.com/firebasejs/5.5.8/firebase-messaging.js");

firebase.initializeApp({
  apiKey: "AIzaSyDKG2g_JD6iFH0qgTeOzCGdEZprHdL1B3c",
  authDomain: "ism-chat-ea48a.firebaseapp.com",
  databaseURL: "https://ism-chat-ea48a-default-rtdb.firebaseio.com/",
  projectId: "ism-chat-ea48a",
  storageBucket: "ism-chat-ea48a.appspot.com",
  messagingSenderId: "902636413859",
  appId: "1:902636413859:web:2496478a858c50b9adf016"
});

var messaging = firebase.messaging();

messaging.setBackgroundMessageHandler(function (payload) {
  var data = payload.data || {};
  var page = data.page === "me.html" ? "me.html" : "index.html";

  return self.registration.showNotification("New message", {
    body: "Open the chat to read.",
    tag: "ism-chat",
    renotify: true,
    data: { page: page }
  });
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var page =
    event.notification.data && event.notification.data.page === "me.html"
      ? "me.html"
      : "index.html";
  var target = new URL(page, self.registration.scope).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        if (windows[i].url === target && "focus" in windows[i]) {
          return windows[i].focus();
        }
      }
      return clients.openWindow ? clients.openWindow(target) : undefined;
    })
  );
});
