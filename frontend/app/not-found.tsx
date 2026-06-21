"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function NotFound() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    Sentry.captureMessage("404 Not Found", {
      level: "warning",
      tags: { page: "not-found" },
    });
  }, []);

  // Authed users who hit a bad URL (e.g. malformed /quiz/<id>) bounce to the
  // dashboard instead of staring at a 404. Unauth users keep the duck.
  useEffect(() => {
    if (status === "authenticated" && session) {
      router.replace("/dashboard");
    }
  }, [status, session, router]);

  const authed = status === "authenticated" && !!session;

  return (
    <main className="min-h-screen bg-yellow-50 flex flex-col items-center justify-center text-center px-6">
      <div className="text-7xl mb-6">🦆</div>
      <h1 className="text-4xl font-extrabold text-gray-900 mb-2">404</h1>
      <p className="text-gray-500 mb-8">
        The duck couldn&apos;t find that page.
      </p>
      <Link
        href={authed ? "/dashboard" : "/"}
        className="px-6 py-3 rounded-xl bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-semibold transition"
      >
        {authed ? "Back to dashboard" : "Go home"}
      </Link>
    </main>
  );
}