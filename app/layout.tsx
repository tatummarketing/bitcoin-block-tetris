import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://apps.tatum.io/bitcoin-block-tetris"),
  title: "Bitcoin Block Tetris · Tatum",
  description:
    "Stack real Bitcoin blocks. Each piece is shaped by its transaction count. Hover a piece for its block stats. Powered by Tatum RPC.",
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png", sizes: "32x32" }],
    apple: [
      { url: "/apple-touch-icon.png", type: "image/png", sizes: "256x256" },
    ],
    shortcut: "/favicon.png",
  },
  openGraph: {
    title: "Bitcoin Block Tetris · Tatum",
    description:
      "Live Bitcoin mainnet blocks fall as pieces. Stack them, clear lines, top the leaderboard.",
    url: "https://apps.tatum.io/bitcoin-block-tetris",
    siteName: "Tatum",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Bitcoin Block Tetris · Tatum",
    description:
      "Live Bitcoin mainnet blocks fall as pieces. Stack them, clear lines, top the leaderboard.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={poppins.className}>{children}</body>
    </html>
  );
}
