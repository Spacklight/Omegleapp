import { createRoot } from "react-dom/client";
import { OmegleApp } from "@/components/omegle/app";
import { AdminPage } from "@/components/omegle/admin";
import "@/styles.css";

// The Worker serves this one page for every path; /admin shows the dashboard.
const isAdmin = window.location.pathname.replace(/\/+$/, "") === "/admin";

createRoot(document.getElementById("root")!).render(isAdmin ? <AdminPage /> : <OmegleApp />);
