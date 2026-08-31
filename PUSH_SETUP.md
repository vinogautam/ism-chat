# Background notifications

The browser stores one FCM token per chat user under `/pushTokens`. A Realtime
Database Cloud Function sends a data-only notification to the other user. The
notification never contains the message text.

## One-time Firebase setup

1. In Firebase Console, open **Project settings → Cloud Messaging**.
2. Under **Web Push certificates**, generate a key pair.
3. Replace `PASTE_FIREBASE_WEB_PUSH_VAPID_KEY_HERE` in both `index.html` and
   `me.html` with the public key.
4. Upgrade the Firebase project to Blaze (Cloud Functions deployment requires
   billing, though the free allowance may cover this small app).
5. From this repository, run:

   ```sh
   npx firebase-tools login
   npx firebase-tools deploy --only functions,database
   ```

6. Deploy the updated web files to the HTTPS site. On each device, open the
   appropriate page and enable the bell once.

For iPhone/iPad background web push, add the site to the Home Screen first
(iOS/iPadOS 16.4 or newer).
