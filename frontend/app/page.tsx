"use client";

import { signIn, signOut, useSession } from "next-auth/react";

export default function Home() {
  const { data: session, status } = useSession();

  // P1-F5: the dashboard bounces unauthenticated users to "/?callbackUrl=<path>"
  // so we can send them back where they were headed after sign-in. Read the
  // hint at click time (not render time) — that way we don't need a
  // Suspense boundary for useSearchParams in this static page.
  const signInWithCallback = () => {
    const cb =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("callbackUrl") ??
          "/dashboard"
        : "/dashboard";
    signIn("github", { callbackUrl: cb });
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-yellow-50 via-white to-orange-50">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-4 border-b border-yellow-100">
        <div className="flex items-center gap-2">
          <span className="text-3xl">🦆</span>
          <span className="font-bold text-xl text-gray-900">VibeSchool</span>
        </div>
        <div>
          {status === "loading" ? null : session ? (
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">{session.user?.name}</span>
              <button
                onClick={() => signOut()}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 transition"
              >
                Sign out
              </button>
              <a
                href="/dashboard"
                className="px-4 py-2 text-sm rounded-lg bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-medium transition"
              >
                Dashboard →
              </a>
            </div>
          ) : (
            <button
              onClick={signInWithCallback}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-gray-900 hover:bg-gray-700 text-white font-medium transition"
            >
              <GitHubIcon className="w-4 h-4" />
              Sign in with GitHub
            </button>
          )}
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center text-center px-6 pt-24 pb-16">
        <div className="text-7xl mb-6 animate-bounce">🦆</div>
        <h1 className="text-5xl font-extrabold text-gray-900 max-w-2xl leading-tight mb-4">
          Your PRs are teaching moments.{" "}
          <span className="text-yellow-500">Start learning them.</span>
        </h1>
        <p className="text-lg text-gray-600 max-w-xl mb-10">
          VibeSchool turns your merged GitHub pull requests into spaced-repetition
          voice quizzes — complete with a savage roast of your own code, delivered
          by a banana duck.
        </p>
        {session ? (
          <a
            href="/dashboard"
            className="px-8 py-4 rounded-xl bg-yellow-400 hover:bg-yellow-500 text-gray-900 text-lg font-bold shadow-lg transition"
          >
            Go to Dashboard →
          </a>
        ) : (
          <button
            onClick={signInWithCallback}
            className="flex items-center gap-3 px-8 py-4 rounded-xl bg-gray-900 hover:bg-gray-700 text-white text-lg font-bold shadow-lg transition"
          >
            <GitHubIcon className="w-6 h-6" />
            Get started with GitHub
          </button>
        )}
      </section>

      {/* How it works */}
      <section className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">
          How it works
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              icon: "🔀",
              title: "Merge a PR",
              desc: "Connect your GitHub repo. Every merged PR is automatically ingested and analyzed.",
            },
            {
              icon: "🦆",
              title: "Get roasted",
              desc: "Claude extracts the CS concepts from your diff and generates a brutal-but-educational roast of your code choices.",
            },
            {
              icon: "🎤",
              title: "Speak your answer",
              desc: "The duck reads the question aloud. You answer by voice. It grades you and schedules your next review via spaced repetition.",
            },
          ].map((step) => (
            <div
              key={step.title}
              className="flex flex-col items-center text-center p-6 rounded-2xl bg-white shadow-sm border border-yellow-100"
            >
              <span className="text-4xl mb-4">{step.icon}</span>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{step.title}</h3>
              <p className="text-sm text-gray-600">{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Tech badges */}
      <section className="py-10 border-t border-yellow-100">
        <p className="text-center text-xs text-gray-400 mb-6 uppercase tracking-widest">
          Powered by
        </p>
        <div className="flex flex-wrap justify-center gap-4 px-8">
          {[
            "Anthropic Claude",
            "Deepgram",
            "Redis",
            "Token Company Bear-2",
            "Sentry",
            "Poke API",
          ].map((badge) => (
            <span
              key={badge}
              className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600"
            >
              {badge}
            </span>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center py-8 text-xs text-gray-400">
        Built at UC Berkeley AI Hackathon 2026 · Aryan + Samuel
      </footer>
    </main>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={`fill-current ${className}`} viewBox="0 0 24 24">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.38.6.11.82-.26.82-.58v-2.04c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 3-.4c1.02 0 2.04.13 3 .4 2.28-1.55 3.29-1.23 3.29-1.23.66 1.65.25 2.87.12 3.17.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.56 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}
