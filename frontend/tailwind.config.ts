import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        canvas: "var(--canvas)",
        surface: {
          1: "var(--surface-1)",
          2: "var(--surface-2)",
        },
        line: "var(--line)",
        marigold: {
          DEFAULT: "var(--marigold)",
          deep: "var(--marigold-deep)",
        },
        mint: "var(--mint)",
        coral: "var(--coral)",
        ink: {
          DEFAULT: "var(--text)",
          dim: "var(--text-dim)",
          faint: "var(--text-faint)",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      letterSpacing: {
        tightest: "-0.04em",
      },
      animation: {
        ping: "vs-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite",
        dot: "vs-dot 1.3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
