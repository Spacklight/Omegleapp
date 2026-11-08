import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const { handleApi } = await import("@/lib/omegle/lobby.server");
  return handleApi(request);
}

// One catch-all for the whole API: /api/omegle, /api/auth/*, /api/admin/*, /api/config.
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
