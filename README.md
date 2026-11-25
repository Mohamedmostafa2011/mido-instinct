# Instinct · Mido

A private chat line between Mido and [Instinct](https://instinct.com). Mido writes, Instinct opens the website in its own browser and answers, and every chat is saved with its history.

- **Website:** https://miduinvesting.vercel.app (also https://mido-instinct.vercel.app). Asks for the passkey once, then remembers it in that browser.
- **Windows app:** `Instinct-Setup.exe`, a normal installer. Opens straight into the chats, no passkey. Private, not published.
- **Android app:** `Instinct.apk`. Opens straight into the chats, no passkey. Private, not published.

All three use the same design and the same chats.

## How it works

```
 Mido (Windows / Android app, or the website)  ──┐
                                                 ├──  Vercel: index.html + /api  ──  Upstash Redis (chats, history)
 Instinct (its browser, with the passkey)  ──────┘
```

- Opening the website asks **who is signing in**: Instinct or Mido. Instinct's replies show up as Instinct.
- The passkey is saved in the browser the first time. After that the site opens on its own. A sign-in link (`/?key=…&as=instinct`) works too: open it once and it is saved.
- The apps have a built-in app key, so they never ask for the passkey and always send as Mido.
- Chats waiting for an answer are marked **Needs reply** for Instinct. The sidebar has All, Needs reply and Unread filters plus search across every message.
- Other features: read receipts (Sent / Seen), a typing indicator, "here now" presence, reply to a message, edit and delete your own messages, pin and rename chats, Markdown (bold, lists, links, code), Arabic and right-to-left text, notifications, dark mode, drafts saved per chat.

### Message to send Instinct on WhatsApp

> I set up a private chat site for us: https://mido-instinct.vercel.app
> The passkey is: `<your passkey>`
> Open the site, enter the passkey, choose “Instinct” and press “Open the chats”. Your browser will remember it.
> Check it regularly. Chats marked “Needs reply” end with a message from me. Open each one, read it and answer in the box at the bottom.
> If it's easier, https://mido-instinct.vercel.app/api/inbox?key=<your passkey> lists everything waiting for you as plain text.

## Setup (one time)

### 1. Connect storage (required, otherwise chats are not kept)

Pick one:

**Firebase Realtime Database**
1. In the [Firebase console](https://console.firebase.google.com), create a project (Analytics can stay off).
2. Go to **Build → Realtime Database → Create Database** and choose **Start in locked mode**. The site signs in as an admin from the server, so the rules can stay locked.
3. Copy the database URL shown at the top, for example `https://your-project-default-rtdb.firebaseio.com`.
4. Go to **Project settings (gear) → Service accounts → Generate new private key** to download a JSON file.
5. In Vercel, add `FIREBASE_DATABASE_URL` (the URL) and `FIREBASE_SERVICE_ACCOUNT` (the whole JSON file contents) as Sensitive variables, then redeploy.

**Upstash Redis:** in Vercel go to **Storage → Create Database → Upstash for Redis** (free), connect it to the project and redeploy. It provides `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).

When both are set, Firebase is used. Until either is set, the sidebar shows a note that storage isn't connected.

### 2. Environment variables on Vercel

| Name | What it does |
| --- | --- |
| `PASSKEY` | The passkey for the website. Change it any time; browsers that saved the old one will ask again |
| `APP_KEY` | Built into the Windows and Android apps so they skip the passkey. If you change it, rebuild the apps |
| `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD` | Signing key for the APK, so new versions install over old ones |
| `NOTIFY_WEBHOOK_URL` | Optional. Every new message from Mido is POSTed here as JSON (Zapier, Make, n8n…), useful to ping Instinct |

### 3. Building the apps

`.github/workflows/apps.yml` builds both apps on every push that touches the UI or app code (or from **Actions → Build apps → Run workflow**). It needs no GitHub secrets: it trades its GitHub OIDC token for `APP_KEY` and the Android keystore at `/api/provision`, which only answers this repository's workflow.

The apps are **never published**. They contain the app key, so they stay private: open **Actions → Build apps → the latest green run → Artifacts** (signed in to GitHub) and download `windows` (Instinct-Setup.exe) and `android` (Instinct.apk). Artifacts are kept for 90 days; run the workflow again for fresh copies. Don't share the files. If one ever leaks, change `APP_KEY` on Vercel and rebuild.

Windows may show SmartScreen ("unknown publisher") the first time because the installer isn't code-signed: **More info → Run anyway**. On Android, allow installing from your browser or file manager when asked.

## API (for Instinct or scripts)

Send the passkey in the `X-Mido-Key` header (or `?key=` on GET). `X-Mido-As: instinct|mido` picks the sender on the web key; the default is `instinct`.

| Method | Path | |
| --- | --- | --- |
| GET | `/api/inbox` | Plain-text list of chats waiting for Instinct, with the unanswered messages (`&format=json` for JSON) |
| POST | `/api/messages` | `{ "chat": "<id>", "text": "…" }` sends a message. Leave out `chat` to start a new one |
| GET | `/api/messages?chat=<id>` | Full history of a chat |
| GET | `/api/chats` | All chats with unread / needs-reply flags |
| GET | `/api/search?q=…` | Search every message |
| POST | `/api/sync` | What the apps poll: changes, presence, new messages |

## Local development

```bash
npm run dev          # http://localhost:3000, passkey: mido-dev, chats saved to .data/db.json
cd desktop && npm install && npm start     # Windows app against the live site
cd mobile && npm install && npm run android:sync && npx cap open android   # needs Android Studio
```

## Files

```
index.html, assets/      the chat UI (one HTML file, one CSS file, one JS file, no build step)
config.js                empty on the web; the app builds overwrite it with the API address and app key
api/, lib/               Vercel serverless functions and storage
desktop/                 Electron wrapper and NSIS installer config
mobile/                  Capacitor Android wrapper and icons
scripts/                 build helpers for the apps
dev-server.mjs           local server that runs /api like Vercel
```
