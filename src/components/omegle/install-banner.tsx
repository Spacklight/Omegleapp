import { useEffect, useState } from "react";
import { Download, Smartphone, X } from "lucide-react";
import { api } from "./account";

const KEY = "omegle-app-prompt"; // "dismissed" | "installed"

function remembered(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

function remember(value: "dismissed" | "installed") {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* shown again next visit */
  }
}

/** A link straight to the APK file starts downloading at once; a store page opens in a new tab. */
function isDirectFile(url: string): boolean {
  return /\.apk($|\?)/i.test(url);
}

function insideApp(): boolean {
  const ua = navigator.userAgent;
  // The Android app's own web view, or the page opened as an installed app.
  if (/; wv\)/.test(ua) || /(Omegle|Talkivo)App/i.test(ua)) return true;
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

/**
 * Asks Android visitors to install the Talkivo app. It keeps appearing on every
 * visit until they tap "Not now" or install it. The web can't see whether an
 * Android app is installed, so tapping Install counts as installing.
 */
export function InstallBanner() {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!/Android/i.test(navigator.userAgent) || insideApp() || remembered()) return;
    let stop = false;
    api<{ ok: true; androidAppUrl: string | null }>("/api/config")
      .then((cfg) => {
        if (!stop && cfg.androidAppUrl) setUrl(cfg.androidAppUrl);
      })
      .catch(() => {});
    const done = () => {
      remember("installed");
      setUrl(null);
    };
    window.addEventListener("appinstalled", done);
    return () => {
      stop = true;
      window.removeEventListener("appinstalled", done);
    };
  }, []);

  if (!url) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center p-3" role="dialog" aria-label="Get the Talkivo app">
      <div className="safe-bottom w-full max-w-md rounded-xl border border-line bg-surface p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-fg">
            <Smartphone className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Get the Talkivo app</p>
            <p className="mt-0.5 text-sm text-pretty text-muted">
              Install the Android app for a faster, smoother way to meet people.
            </p>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="flex min-h-11 min-w-11 items-center justify-center"
            onClick={() => {
              remember("dismissed");
              setUrl(null);
            }}
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            className="min-h-11 rounded-lg border border-line text-sm font-medium"
            onClick={() => {
              remember("dismissed");
              setUrl(null);
            }}
          >
            Not now
          </button>
          <a
            href={url}
            target={isDirectFile(url) ? undefined : "_blank"}
            download={isDirectFile(url) ? "Talkivo.apk" : undefined}
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-fg"
            onClick={() => {
              remember("installed");
              setUrl(null);
            }}
          >
            <Download className="size-4" />
            Install app
          </a>
        </div>
      </div>
    </div>
  );
}
