import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0A0D14", // pilótafülke-fekete (kék árnyalat)
        panel: "#10141E",
        panel2: "#161B28",
        line: "#222A3B",
        ink: "#E8ECF5",
        dim: "#8A92A6",
        faint: "#565E73",
        iris: "#7C83FF", // AI/rendszer-akcentus (nem kripto-zöld)
        irisBright: "#A7ABFF",
        up: "#45C08A", // valódi nyereség — CSAK kimenetnél
        down: "#E76A82", // valódi veszteség
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
