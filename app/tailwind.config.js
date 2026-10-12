/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "Consolas", "ui-monospace", "monospace"],
        /** Institutional footer / quality seal — refined serif, minimal */
        seal: [
          '"Cormorant Garamond"',
          "Georgia",
          "Cambria",
          "Times New Roman",
          "ui-serif",
          "serif",
        ],
      },
      colors: {
        inst: {
          bg: "#FFFFFF",
          navy: "#0F172A",
          accent: "#00C2FF",
          border: "#E2E8F0",
          muted: "#64748B",
          surface: "#F8FAFC",
          /** Footer seal copy — subtle dark gray on white */
          seal: "#5A6570",
        },
        term: {
          bg: "#0a0e0d",
          panel: "#0f1614",
          border: "#1a3328",
          green: "#3afb9d",
          dim: "#2d7a54",
          red: "#ff4d6a",
          warn: "#e8c547",
        },
      },
      boxShadow: {
        inst: "0 4px 24px -4px rgba(15, 23, 42, 0.08), 0 2px 8px -2px rgba(15, 23, 42, 0.06)",
        "inst-lg":
          "0 20px 50px -12px rgba(15, 23, 42, 0.12), 0 8px 16px -4px rgba(15, 23, 42, 0.08)",
      },
      borderRadius: {
        inst: "24px",
      },
    },
  },
  plugins: [],
};
