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
        // "Trading Terminal" paletta — mély, neutrális fekete + amber akcent.
        bg: "#0a0c0f", // terminál-fekete
        panel: "rgb(var(--panel-rgb) / <alpha-value>)", // panel (sávonként árnyalva)
        panel2: "rgb(var(--panel2-rgb) / <alpha-value>)", // emelt panel / sorok
        line: "rgb(var(--line-rgb) / <alpha-value>)", // vonal / keret
        ink: "#e8ebee", // elsődleges szöveg
        dim: "#9aa2ad", // másodlagos szöveg (4,5:1 fölött a panelen)
        faint: "#848c97", // címke / halvány — még olvasható, nem dekoráció
        accent: "#e3a542", // amber/arany — AI/rendszer-akcentus
        accentBright: "#f2b75e", // világosabb amber (hover/kiemelés)
        accentDim: "#b97a1e", // sötétebb amber (keret/gradient)
        up: "#41c46f", // valódi nyereség
        down: "#e8685f", // valódi veszteség
        info: "#5b9bd5", // másodlagos (kék) jelzés
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
