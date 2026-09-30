import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

const OG_IMAGE =
  "https://cdn.prod.website-files.com/618a9dc0e5826661c77e6a67/6abb5f682e5be3f82678c5bf_bitcoin-block-tetris-og-v2.png";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://apps.tatum.io/bitcoin-block-tetris"),
  title: "Bitcoin Block Tetris · Tatum",
  description:
    "Stack real Bitcoin transactions from the latest block. Each piece is shaped by how much BTC it sends. Powered by Tatum RPC.",
  openGraph: {
    title: "Bitcoin Block Tetris · Tatum",
    description:
      "Transactions from the latest Bitcoin block fall as pieces. Stack them, clear lines, top the leaderboard.",
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
      "Transactions from the latest Bitcoin block fall as pieces. Stack them, clear lines, top the leaderboard.",
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
