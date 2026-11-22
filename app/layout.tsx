import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Digest — Purpose-Built AI Text Summariser",
  description:
    "A quiet, editorial text summarisation engine powered by Google Gemini.",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased selection:bg-[var(--accent-soft)] selection:text-[var(--accent-hover)]">
        {children}
      </body>
    </html>
  );
}
