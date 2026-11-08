# Talkivo

Talk to strangers by **text, voice or video** — **one-on-one** or in a **group of up to 4**.
Runs on **Termux** (Android) and on **Cloudflare Workers**, from one codebase.

## What's new in this version

| Feature | How it works |
|---|---|
| **Light / dark theme** | Moon/sun button on every screen. **Light is the default**; your choice is remembered. |
| **Music in live calls** | In a voice or video call tap the music button, add songs from your device. Your mic and the music are mixed into one audio track, so everyone in the call hears both. Play/pause, next/previous, repeat, volume, queue. Muting your mic does not stop the music. Files play from your device — nothing is uploaded to the server. |
| **Group rooms (max 4)** | In the lobby choose **One-on-one** or **Group · up to 4**, for text, voice and video. Group rooms stay open for newcomers until full; people can join and leave freely; a full room never takes a 5th person. Group voice/video is a peer-to-peer mesh (each person connects to the other 3). |

| **Accounts** | Anyone can create an account with just an **email address**: we email a 6-digit code (sent and checked by Smartbase), they type it, done. No password. The same two steps sign in later. |
| **Chat-time limits** | **No account:** 10 minutes of chat in total, per device, and it **never refreshes**. **With an account:** 30 minutes, and once it is used up it comes back **2 hours later**. A countdown shows in the chat; when time runs out the chat ends and a message explains why. |
| **Admin dashboard** | `/admin` — sign in with an admin email and see every registered user (joined, last sign-in, sign-ins, chat time), search them, export CSV. |
| **Android app prompt** | Android visitors get an "Install the Talkivo app" popup on every visit until they tap *Not now* or *Install app*. |

Strangers who picked different options are never mixed: text, voice and video rooms are separate, and one-on-one users never land in a group.

## Run on Termux

```bash
pkg update && pkg install -y nodejs unzip
unzip talkivo-platform.zip && cd talkivo-platform
npm install
npm run termux          # serves on http://localhost:8080
```

Open `http://localhost:8080` in the phone's browser.

**Camera, microphone and music need a secure address.** `localhost` counts as secure, so it works on the same phone. For friends on other devices, expose it over https with a Cloudflare quick tunnel:

```bash
pkg install -y cloudflared
cloudflared tunnel --url http://localhost:8080
```

Share the `https://….trycloudflare.com` link. Run a **single** server process — the lobby lives in its memory.

## Deploy to Cloudflare Workers

```bash
npm install
npx wrangler login
npm run cf:deploy       # builds the app, then deploys the Worker + Durable Object
```

You get an `https://<worker-name>.<you>.workers.dev` address (https, so camera/mic/music work). `npm run cf:dev` previews it locally.

## How it fits together

```
src/lib/omegle/engine.ts      matchmaking: 1:1 + group rooms, signalling relay (shared!)
src/lib/omegle/lobby.server.ts  Node/Termux HTTP wrapper around the engine
cloudflare/worker.js          Worker + Durable Object wrapper around the same engine
cloudflare/spa, vite.config   builds the same React app as a static site for Workers
src/components/omegle/app.tsx the app UI
src/components/omegle/call.ts  WebRTC: one call per person (mesh)
src/components/omegle/mixer.ts mic + music mixer
src/components/omegle/theme*.ts light/dark
```

**Long polling (fewer requests).** The app doesn't ask the server for news every second. Each request is held open (up to ~25 s) and answered the instant something happens: a message, a call signal, someone joining/leaving/typing, or a match. A quiet chat therefore costs about 2–3 requests a minute instead of 60, while messages still arrive immediately. The stats counter refreshes every 30 s and pauses while the tab is hidden. This is what stretches Cloudflare's free request allowance (roughly 100k/day; check current limits) across many more users. Typing indicators are sent separately, at most every 1.5 s.

Text goes through the lobby server. Voice, video and music go **directly between people** (WebRTC); the server only relays the call setup.

## Settings

Set these as environment variables on Termux, or in the Cloudflare dashboard (**your worker → Settings → Variables and Secrets**; add the key as a *Secret*, the rest as plain variables). None of them belong in GitHub.

| Name | What it does |
|---|---|
| `SMARTBASE_API_KEY` | Your Smartbase project key (`sb_live_…`). Needed to email codes. **Keep it secret.** Without it, Cloudflare sign-in shows "could not send the email", and on Termux the code is printed in the server console instead (handy for trying it out). |
| `SMARTBASE_URL` | Optional. Default `https://smartemail.de5.net`. |
| `ADMIN_EMAILS` | Comma-separated emails allowed into `/admin`, e.g. `you@gmail.com,friend@gmail.com`. They sign in at `/admin` like anyone else. |
| `ANDROID_APP_URL` | Where *Install app* goes. Set it to `/talkivo.apk` to download the APK hosted by this project (see below), or a Play Store / direct link. The prompt stays hidden until this is set. |
| `GUEST_MINUTES`, `ACCOUNT_MINUTES`, `ACCOUNT_REFRESH_HOURS` | Optional. Defaults 10, 30, 2. |
| `OMEGLE_DATA` | Termux only: where accounts and used time are saved. Default `data/omegle.json`. |

Termux example: `SMARTBASE_API_KEY=sb_live_xxx ADMIN_EMAILS=you@gmail.com npm run termux`

Accounts and used chat time are stored in the Durable Object's storage on Cloudflare, and in `data/omegle.json` on Termux.

## Your own domain (Cloudflare)

Add `talkivo.de5.net` under **Workers & Pages → your worker → Settings → Domains & Routes → Add → Custom domain** (the domain must be in your Cloudflare account). The `…workers.dev` address keeps working, so both open the same app. The page's canonical link points to `https://talkivo.de5.net/`, and `robots.txt` / `sitemap.xml` are included. To appear on Google, add the domain in Google Search Console, then submit `https://talkivo.de5.net/sitemap.xml` and request indexing; Google decides when and how results show.

## The Android app (direct download)

Put the app file in `cloudflare/spa/public/` and name it exactly **`talkivo.apk`** (under 25 MB for Cloudflare). Then set `ANDROID_APP_URL` to `/talkivo.apk`. The Install button then downloads the file immediately from your own domain; `cloudflare/spa/public/_headers` makes browsers download it instead of opening it. To update the app, replace the file and push again. Android shows its own "unknown source" warnings for apps not on Google Play.

## Google Search Console

Add `https://<your domain>/` as a *URL-prefix* property. If Google gives you an HTML verification file, ask for a one-line Worker patch to serve it (the Worker answers that exact path), or use the DNS method instead. Then submit `https://<your domain>/sitemap.xml`. `robots.txt` and `sitemap.xml` are in `cloudflare/spa/public/`; if your domain is not `talkivo.de5.net`, edit the address in `index.html`, `robots.txt`, `sitemap.xml` and `src/routes/__root.tsx`.

## Docs, Privacy Policy, Terms

User documentation, the Privacy Policy and the Terms & Conditions are plain static pages: `docs.html`, `privacy.html`, `terms.html`. They exist in **both** `cloudflare/spa/public/` (Cloudflare) and `public/` (Termux), so edit a page in both places. On Cloudflare they open at `/docs`, `/privacy` and `/terms` and are listed in `sitemap.xml`. The app's start screen links to them and shows "Built by Miyoni" with the contact email `prof200619@gmail.com`. These texts describe what the app really does today (what is stored, who processes it); update them if you change that, and have a lawyer review them before relying on them.

## Admin access

Only the emails in `ADMIN_EMAILS` can use `/admin`. The admin page's sign-in refuses every other address *before* sending it a code, the server checks again before showing the user list, and with `ADMIN_EMAILS` unset nobody is an admin. Signing in as an admin on the main app page also works, since it is the same account.

## Tests



```bash
npm test      # includes ~45 tests: 1:1, groups capped at 4, late joiners, leaving, rate limits, long polling, email sign-in, 10/30-minute limits and refresh, admin access…
```

## Things to know

- **Limits are per device for guests.** A guest's 10 minutes are counted against an id stored in their browser, so clearing site data or using another browser gives a new 10 minutes. Closing that gap completely would mean tracking IP addresses or fingerprints, which wrongly blocks people who share a network (common on mobile). Accounts can't be reset this way.
- **The Smartbase calls follow the API examples you pasted** (`send-verification`, `verify-code`, header `X-Smartbase-Key`). Smartbase's exact reply format wasn't visible, so a code is accepted when `verify-code` answers 2xx and doesn't say `valid: false`. If sign-in misbehaves, `src/lib/omegle/verifier.ts` is the only place to adjust.

- **Long polling on Cloudflare is untested on a live account** by the author: held requests are waiting time, not CPU time, but check your Workers/Durable Object usage after the first day.

- **The lobby is in memory** (one Node process, or one Durable Object). The earlier Postgres lobby was replaced so groups work identically on both hosts. Don't run several copies of the Node server behind a load balancer.
- **No TURN server.** Calls use public STUN. Most networks connect; strict mobile/corporate NATs may fail (text still works). Group video sends your camera to up to 3 people, so it uses lighter 640×480 video. Add a TURN server in `src/components/omegle/call.ts` if needed.
- **Everyone in a call can learn the others' network addresses** (inherent to peer-to-peer). The app says so on the lobby and Safety screens.
- **Moderation is not included.** Random-chat sites attract abuse; before opening this publicly add age checks, reporting/bans and terms suited to your country. Users must tick an 18+ box.
- Only play music you have the right to share.
