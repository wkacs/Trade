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
        panel: "#13171c", // panel
        panel2: "#1c2128", // emelt panel / sorok
        line: "#232a32", // vonal / keret
        ink: "#e8ebee", // elsődleges szöveg
        dim: "#8b929b", // másodlagos szöveg
        faint: "#59616b", // halvány / címke
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
