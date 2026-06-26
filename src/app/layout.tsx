import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Kereskedő Bot — döntés-napló",
  description: "Hibrid AI (ML + GLM) által vezérelt kripto-trading, látható érveléssel.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hu">
      <head>
        {/* Tipográfia: Space Grotesk (műszer-feliratok), IBM Plex Sans (az AI érvelése),
            IBM Plex Mono (gépi adat). Böngésző-oldali betöltés (nincs build-idejű fetch). */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Grotesk:wght@500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
