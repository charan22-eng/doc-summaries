import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Digest — AI Text Summariser",
  description:
    "A purpose-built, high-performance text summarisation engine powered by Anthropic Claude.",
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
      <body className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 antialiased selection:bg-indigo-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
