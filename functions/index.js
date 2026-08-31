const { onValueCreated } = require("firebase-functions/v2/database");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

exports.sendChatNotification = onValueCreated(
  {
    ref: "/{day}/{messageId}",
    region: "us-central1",
  },
  async (event) => {
    const message = event.data.val();

    // This path also contains the `clear` timestamp. Only notify for messages.
    if (
      !message ||
      typeof message !== "object" ||
      ![1, 2].includes(message.sender) ||
      (!message.msg && !message.img)
    ) {
      return;
    }

    const recipient = message.sender === 1 ? 2 : 1;
    const tokensSnapshot = await getDatabase()
      .ref(`/pushTokens/u${recipient}`)
      .get();

    if (!tokensSnapshot.exists()) return;

    const entries = [];
    tokensSnapshot.forEach((child) => {
      const value = child.val();
      if (value && typeof value.token === "string") {
        entries.push({
          key: child.key,
          token: value.token,
          page: value.page === "me.html" ? "me.html" : "index.html",
        });
      }
    });

    if (!entries.length) return;

    const staleKeys = [];
    for (let offset = 0; offset < entries.length; offset += 500) {
      const batch = entries.slice(offset, offset + 500);
      const response = await getMessaging().sendEach(
        batch.map((entry) => ({
          token: entry.token,
          data: {
            title: "New message",
            body: "Open the chat to read.",
            page: entry.page,
          },
          webpush: {
            headers: { Urgency: "high" },
          },
        }))
      );

      response.responses.forEach((result, index) => {
        if (result.success) return;
        const code = result.error && result.error.code;
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          staleKeys.push(batch[index].key);
        } else {
          logger.warn("Push delivery failed", { code });
        }
      });
    }

    if (staleKeys.length) {
      const updates = {};
      staleKeys.forEach((key) => {
        updates[key] = null;
      });
      await getDatabase().ref(`/pushTokens/u${recipient}`).update(updates);
    }
  }
);
