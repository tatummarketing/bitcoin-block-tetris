import Image from "next/image";
import BlockTetris from "@/components/organisms/BlockTetris";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[#0d0f22] text-white">
      <header className="border-b border-white/10">
        <div className="mx-auto flex h-12 max-w-[1500px] items-center justify-between px-4 md:px-6">
          <a
            href="https://tatum.io"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3"
          >
            <Image
              src="/tatum.svg"
              alt="Tatum"
              width={76}
              height={18}
              priority
              className="brightness-0 invert"
            />
            <span className="hidden text-sm font-semibold text-white/90 sm:inline">
              Bitcoin Block Tetris
            </span>
          </a>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <a
              href="https://tatum.io/chain/bitcoin"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-lg px-3 py-1.5 text-white/80 hover:bg-white/10 hover:text-white sm:inline"
            >
              Bitcoin RPC
            </a>
            <a
              href="https://dashboard.tatum.io"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-[#4f37fd] px-3 py-1.5 text-white hover:bg-[#3f2ae6]"
            >
              Get API Key
            </a>
          </div>
        </div>
      </header>

      <div className="px-4 py-5 md:px-6">
        <BlockTetris />
      </div>
    </main>
  );
}
