import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

const OG_IMAGE =
  "https://cdn.prod.website-files.com/618a9dc0e5826661c77e6a67/6abb5894d28a591d590aed07_bitcoin-block-tetris-og.png";

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
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: "Bitcoin Block Tetris" }],
  },
  twitter: {
    card: "summary_large_image",
    images: [OG_IMAGE],
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
