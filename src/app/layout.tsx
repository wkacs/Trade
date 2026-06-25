import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Kereskedő Bot",
  description: "Hibrid AI által vezérelt kripto-trading dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="hu">
      <body className="antialiased">{children}</body>
    </html>
  );
}
