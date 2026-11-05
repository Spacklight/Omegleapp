/**
 * Omegle on Cloudflare Workers.
 *
 * - The Worker serves the built app (cloudflare/dist, the same React UI that
 *   runs on Termux) through the ASSETS binding.
 * - Everything under /api/ goes to ONE Durable Object, the lobby. It runs the
 *   same platform code as the Node server (src/lib/omegle/platform.ts):
 *   matchmaking (1:1 and groups of up to 4), the WebRTC signalling relay,
 *   email-code accounts, chat-time limits and the admin dashboard's data.
 *   Accounts and used time are kept in the Durable Object's storage.
 *   Voice, video and music itself is peer to peer and never touches the Worker.
 *
 * Settings (Cloudflare dashboard > omegle > Settings > Variables and Secrets):
 *   SMARTBASE_API_KEY   (secret)  email codes via Smartbase
 *   ADMIN_EMAILS        comma-separated emails allowed to open /admin
 *   ANDROID_APP_URL     where the "install the app" banner sends Android visitors
 *   GUEST_MINUTES, ACCOUNT_MINUTES, ACCOUNT_REFRESH_HOURS   optional (10, 30, 2)
 *
 *   npm run cf:deploy
 */
import { Platform } from "../src/lib/omegle/platform.ts";
import { smartbaseVerifier } from "../src/lib/omegle/verifier.ts";

/** Durable Object storage, in the shape the platform expects. */
function doStore(storage) {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    delete: async (key) => {
      await storage.delete(key);
    },
    list: async (prefix) => [...(await storage.list({ prefix })).entries()],
  };
}

/** Used when SMARTBASE_API_KEY has not been set yet: sign-in says so instead of silently failing. */
const noEmail = {
  async send() {
    throw new Error("SMARTBASE_API_KEY is not set");
  },
  async check() {
    return false;
  },
};

// Durable Object class name kept as `Lobby` so existing deployments migrate cleanly.
export class Lobby {
  constructor(ctx, env) {
    const verifier = env.SMARTBASE_API_KEY
      ? smartbaseVerifier({ apiKey: env.SMARTBASE_API_KEY, baseUrl: env.SMARTBASE_URL })
      : noEmail;
    this.platform = new Platform({ store: doStore(ctx.storage), verifier, env });
  }

  fetch(request) {
    return this.platform.handle(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return env.LOBBY.get(env.LOBBY.idFromName("global")).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
