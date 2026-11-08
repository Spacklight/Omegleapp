import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { THEME_BOOT_SCRIPT } from "@/components/omegle/theme";
import appCss from "../styles.css?url";


export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Talkivo – Talk to Strangers From Different Locations and Countries Through Live Audio, Video and Text Chat" },
      {
        name: "description",
        content: "Talk to strangers from different locations and countries through live audio, video and text chat. One-on-one or in a group of up to four. Start right away, or create a free account for more chat time.",
      },
      { name: "theme-color", content: "#f6f4ec" },
    ],
    links: [
      { rel: "canonical", href: "https://talkivo.de5.net/" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,560;0,9..144,680;1,9..144,560&family=Outfit:wght@380;500;640&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
    // Sets light/dark before first paint so a saved dark choice never flashes white.
    scripts: [{ children: THEME_BOOT_SCRIPT }],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="antialiased">
        <PreviewHostBridge />
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
