"use client";

/**
 * Last-resort error UI for the App Router.
 *
 * global-error.tsx replaces the root layout when the root layout itself
 * throws, so it MUST define its own <html> and <body> — you can't rely on
 * app/layout.tsx being mounted. That's why the Pages-Router `<NextError
 * statusCode={0} />` pattern doesn't work here: it's not designed to be
 * the root document, and App Router rejects the result with "missing
 * required error components".
 *
 * Keep this file intentionally tiny — no imports from `@/lib/api`,
 * next-auth, or any component that itself might throw. If the failure is
 * catastrophic enough to land here, simpler is safer.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  // Inline a minimal styled page so we don't pull in tailwind globals that
  // might not be loaded (the root layout may have failed to mount).
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#fafaf7",
          color: "#1f1f1f",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', sans-serif",
          padding: "1rem",
        }}
      >
        <main
          style={{
            maxWidth: 420,
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
            alignItems: "center",
          }}
        >
          <div style={{ fontSize: "3rem" }}>🦆</div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0 }}>
            Something broke.
          </h1>
          <p
            style={{
              fontSize: "0.95rem",
              color: "#5a5a5a",
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            The page failed to load. The team has been notified — try again
            in a moment.
          </p>
          {error.digest && (
            <p
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                color: "#9a9a9a",
                margin: 0,
                wordBreak: "break-all",
              }}
            >
              ref: {error.digest}
            </p>
          )}
          {reset && (
            <button
              type="button"
              onClick={() => reset()}
              style={{
                marginTop: "0.5rem",
                padding: "0.625rem 1.25rem",
                borderRadius: "0.75rem",
                border: "1px solid #d8d8d4",
                background: "#fff",
                color: "#1f1f1f",
                fontSize: "0.9rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          )}
        </main>
      </body>
    </html>
  );
}
