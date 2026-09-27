# Foleam Voice server

Optional server module for the Mailan1 Express/Socket.IO application. It is not bundled into the desktop executable.

Mount `installFoleamVoice({ app, io, db, sessionMiddleware, ensureCsrfToken })` after the application's session setup. The database must provide the existing Mailan1 `users` table. `APP_URL` or `SITE_URL` must be the exact HTTPS site origin. Existing TURN settings are read through `chat-call-ice.js`; never place TURN secrets in client files.

Serve the files from `voice-client` and the existing `/socket.io/socket.io.js` client. The public invitation page is `/foleam-voice.html#CODE`. Authentication is mandatory. Rooms are in memory, expire after four hours, and disappear on server restart or when the last participant leaves. Maximum room size is eight; media uses peer-to-peer WebRTC or TURN, not an SFU. The server does not record audio.

Run `node scripts/package-voice.cjs` before building the launcher when changing addon assets. This writes the versioned addon package and its pinned SHA-256 catalog. Publish the exact package from `dist` to its catalog URL; never overwrite an already released addon version. Bump both addon version and launcher version for changes to pinned addon assets.
