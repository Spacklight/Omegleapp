/**
 * HTTP face of the platform for the Node / Termux server. All the logic lives
 * in `platform.ts` (shared with the Cloudflare Durable Object). It is held in
 * memory on `globalThis` so dev-server hot reloads don't wipe the lobby — run
 * one server process and everyone meets in it.
 *
 * Accounts and used chat time are saved to a JSON file (default
 * `data/omegle.json`; change it with OMEGLE_DATA).
 *
 * Settings (environment variables), all optional:
 *   SMARTBASE_API_KEY   email codes via Smartbase (without it, codes are printed in this console)
 *   SMARTBASE_URL       default https://smartemail.de5.net
 *   ADMIN_EMAILS        comma-separated emails allowed to open /admin
 *   ANDROID_APP_URL     where the "install the app" banner sends Android visitors
 *   GUEST_MINUTES, ACCOUNT_MINUTES, ACCOUNT_REFRESH_HOURS   (10, 30, 2)
 */
import { Platform } from "./platform.ts";
import { FileStore } from "./store.node.ts";
import { consoleVerifier, smartbaseVerifier } from "./verifier.ts";

const g = globalThis as typeof globalThis & { __omeglePlatform?: Platform };

function platform(): Platform {
  if (!g.__omeglePlatform) {
    const env = process.env;
    const verifier = env.SMARTBASE_API_KEY
      ? smartbaseVerifier({ apiKey: env.SMARTBASE_API_KEY, baseUrl: env.SMARTBASE_URL })
      : consoleVerifier();
    g.__omeglePlatform = new Platform({
      store: new FileStore(env.OMEGLE_DATA ?? "data/omegle.json"),
      verifier,
      env,
    });
  }
  return g.__omeglePlatform;
}

export function handleApi(request: Request): Promise<Response> {
  return platform().handle(request);
}
