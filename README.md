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
- **Email alerts:** each new message from Mido, which leaves the chat marked Needs reply, sends an email right away with the subject "[Mido] New message needs reply". It includes the chat name, the sender, the full text, the time and a link to the chat (`/?chat=<id>`), but never the passkey. The email is sent from the same request that saves the message, never twice for one message, and a failed send is only logged.
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
| `RESEND_API_KEY` | [Resend](https://resend.com) API key for the email alerts. Without it no email is sent |
| `NOTIFY_EMAIL_TO` | Who gets the alerts (comma-separate several) |
| `NOTIFY_EMAIL_FROM` | Optional sender. Default `Mido <onboarding@resend.dev>`, which Resend only delivers to the address the Resend account was created with. Verify a domain in Resend to send from your own address |
| `SITE_URL`, `NOTIFY_TIMEZONE` | Optional: base of the link in the email (default `https://miduinvesting.vercel.app`) and the time zone for its timestamp (default `Africa/Cairo`) |
| `REPLY_API_KEY` | Secret for `POST /api/reply`, sent in the `x-api-key` header. Generate it yourself and keep it only here. Without it the endpoint rejects every request |
| `NOTIFY_WEBHOOK_URL` | Optional. Every new message from Mido is POSTed here as JSON (Zapier, Make, n8n…), useful to ping Instinct |
| `GOOGLE_SERVICES_JSON` | The Android app's `google-services.json` from Firebase (paste the file's contents, or base64). Turns on push notifications that arrive while the app is closed. See *Notifications when the app is closed* |

### 3. Building the apps

`.github/workflows/apps.yml` builds both apps on every push that touches the UI or app code (or from **Actions → Build apps → Run workflow**). It needs no GitHub secrets: it trades its GitHub OIDC token for `APP_KEY` and the Android keystore at `/api/provision`, which only answers this repository's workflow.

The apps are **never published**. They contain the app key, so they stay private: open **Actions → Build apps → the latest green run → Artifacts** (signed in to GitHub) and download `windows` (Instinct-Setup.exe) and `android` (Instinct.apk). Artifacts are kept for 90 days; run the workflow again for fresh copies. Don't share the files. If one ever leaks, change `APP_KEY` on Vercel and rebuild.

Windows may show SmartScreen ("unknown publisher") the first time because the installer isn't code-signed: **More info → Run anyway**. On Android, allow installing from your browser or file manager when asked.

### 4. Notifications when the app is closed

**Android** gets real push notifications through Firebase Cloud Messaging. Android shows them even after the app is swiped away or the phone restarts. The server sends them with the same `FIREBASE_SERVICE_ACCOUNT` that stores the chats, so there's no extra server key. Every new message goes to the other side's phones. Tapping one opens that chat.

1. In the [Firebase console](https://console.firebase.google.com), open the **same project** as `FIREBASE_SERVICE_ACCOUNT` → **Project settings → General → Add app → Android**. Package name: `com.mido.instinct`. Register, then download `google-services.json`. You can skip the other steps.
2. Under **Project settings → Cloud Messaging**, check that **Firebase Cloud Messaging API (V1)** says *Enabled*.
3. On Vercel, add `GOOGLE_SERVICES_JSON` with the contents of that file, then redeploy.
4. Run **Actions → Build apps**, then install the new APK over the old one. On first launch, allow notifications. Use **⋯ → Send a test notification** and close the app to check that it works.

Without `GOOGLE_SERVICES_JSON`, the APK still builds. It only notifies while it's running, as before.

**Windows**: closing the window keeps Instinct running in the system tray (next to the clock), so notifications keep coming. It also starts with Windows, hidden in the tray. Click the tray icon to open it. Right-click the icon for **Start with Windows** (on by default) and **Quit Instinct**.

## API (for Instinct or scripts)

Pin a chat: `PATCH /api/chats {id, pinned: true}` (in the app: hover a chat and click ⋯, right-click it, or long-press it on a phone).

Send the passkey in the `X-Mido-Key` header (or `?key=` on GET). `X-Mido-As: instinct|mido` picks the sender on the web key; the default is `instinct`.

| Method | Path | |
| --- | --- | --- |
| GET | `/api/inbox` | Plain-text list of chats waiting for Instinct, with the unanswered messages (`&format=json` for JSON) |
| POST | `/api/messages` | `{ "chat": "<id>", "text": "…" }` sends a message. Leave out `chat` to start a new one |
| GET | `/api/messages?chat=<id>` | Full history of a chat |
| GET | `/api/chats` | All chats with unread / needs-reply flags |
| GET | `/api/search?q=…` | Search every message |
| POST | `/api/upload` | `{ "name", "type", "size", "kind": "image"/"audio"/"file" }` starts an upload and returns `{ id, partSize, parts }` |
| PUT | `/api/upload?id=…&n=…` | Raw bytes of part `n` (2 MB each, in order). Then send the message with `"attachments": ["<id>"]` |
| PATCH | `/api/messages` | `{ "chat", "i", "transcribe": true }` transcribes that message's voice notes again |
| GET | `/api/file?id=…` | Downloads an attachment (`&n=…` for one part, `&download=1` to save it) |
| GET | `/api/email-test` | Sends one sample alert email and returns the sender address (one per minute) |
| POST | `/api/sync` | What the apps poll: changes, presence, new messages |

### Voice notes, photos and files

The paperclip attaches photos and files (or paste / drag them in on a computer), and the microphone records a voice note: tap it, talk, then tap send, or the bin to discard. Up to 10 attachments per message and 25 MB per file; big photos are scaled down first, like a messenger does.

Attachments are stored in the same Firebase database as the chats, split into 2 MB parts, and can only be downloaded with the passkey or the apps' key. There are no public links. `/api/inbox` lists each attachment with its download link for Instinct. Deleting a message or a chat deletes its files too. Firebase's free plan holds 1 GB, which is many hours of voice notes, but large videos will fill it quickly.

On Android, saving a file opens the share sheet so you can save it to Files or open it in another app. The first voice note asks for microphone access.

### Voice note transcripts

Every voice note is turned into text on the server as soon as it finishes uploading, before the message is saved. The transcript is stored with the message (`attachments[].transcript`) and shown under the voice note. It also goes in the email alert (the `Transcript:` line right after `Chat ID:`), in `/api/inbox` and in search, so Instinct can read and answer a voice note without playing it.

It uses Whisper through any OpenAI-compatible speech-to-text API. Add **one** of these on Vercel (Production, Sensitive) and redeploy:

| Variable | Service |
|---|---|
| `GROQ_API_KEY` | [Groq](https://console.groq.com/keys): free tier, Whisper large v3, detects Arabic and English by itself. Used first if both are set. |
| `OPENAI_API_KEY` | OpenAI (`gpt-4o-mini-transcribe`), paid per minute |

Optional: `TRANSCRIBE_LANGUAGE` (for example `ar`) to force one language, `TRANSCRIBE_MODEL` to change the model.

Without a key, voice notes still work, just without text. `GET /api/health?key=…` shows whether transcription is on, and `&stt=1` also tests the key with a second of silence. A note that could not be transcribed shows **Try again** in the chat (`PATCH /api/messages {chat, i, transcribe: true}`). That never sends a second email. The key is only ever sent to the speech-to-text API and is never logged or returned.

### Reply API (no browser needed)

```
POST https://miduinvesting.vercel.app/api/reply
x-api-key: <REPLY_API_KEY>
Content-Type: application/json

{"chatId": "<chat id>", "text": "…"}
```

Saves the text as a reply from Instinct in that chat and clears its "Needs reply" status. Returns `{"ok": true}`. Every alert email shows the chat ID to use.
Errors: `401` missing or wrong key, `400` no `chatId` or `text`, `404` unknown chat, `405` not POST. The key is never logged.

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
