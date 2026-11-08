import { createFileRoute } from "@tanstack/react-router";
import { OmegleApp } from "@/components/omegle/app";

export const Route = createFileRoute("/")({ component: OmegleApp });
