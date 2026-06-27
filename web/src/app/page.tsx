"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Share2, ShieldAlert, FileCode2, Boxes } from "lucide-react";
import { Logo, GithubMark } from "@/components/ui";
import { ScanOverlay } from "@/components/ScanOverlay";
import { createScan } from "@/lib/api";

const SAMPLES = ["fastify/fastify-plugin", "fastify/fastify-autoload", "stripe/stripe-node"];

const FEATURES = [
  {
    icon: Boxes,
    title: "See the whole system",
    body: "Every service, queue, database, and external API rendered as a navigable 3D graph, clustered by domain.",
  },
  {
    icon: Share2,
    title: "Connections over nodes",
    body: "Click any edge: exact code, request/response contract, failure behavior, and where the real risk sits.",
  },
  {
    icon: ShieldAlert,
    title: "Confidence, not assumptions",
    body: "Every node and link tagged confirmed, inferred, or uncertain. You never walk away with false certainty.",
  },
  {
    icon: FileCode2,
    title: "Agent-ready context",
    body: "One markdown file per node and link — a structured package your agents can operate on without guessing.",
  },
];

export default function LandingPage() {
  const [repo, setRepo] = React.useState("");
  const [scanning, setScanning] = React.useState(false);
  const [scanId, setScanId] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  async function start(url?: string) {
    const target = (url ?? repo).trim();
    if (!target) return;
    setRepo(target);
    setSubmitError(null);
    setScanId(null);

    try {
      const scan = await createScan(target);
      setScanId(scan.id);
      setScanning(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Unable to start a real repository scan");
      setScanning(false);
    }
  }

  return (
    <main className="flex min-h-full flex-col bg-[#0c0d10]">
      {/* ── Nav ── */}
      <header className="border-b border-[#2a2c36]">
        <nav className="mx-auto flex h-12 max-w-5xl items-center justify-between px-6">
          <Logo />
          <div className="flex items-center gap-1">
            <Link
              href="/explore"
              className="px-3 py-1.5 text-sm text-[#8b8d98] transition-colors duration-150 hover:text-[#e8e9ed]"
            >
              Workspace
            </Link>
            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer"
              className="flex cursor-pointer items-center gap-2 rounded rounded-lg border border-[#2a2c36] px-3 py-1.5 text-sm text-[#8b8d98] transition-colors duration-150 hover:border-[#3a3c48] hover:text-[#e8e9ed]"
            >
              <GithubMark className="h-3.5 w-3.5" />
              GitHub
            </a>
          </div>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-start px-6 pt-24 pb-20">
        <div className="mb-8 inline-flex items-center gap-2 rounded-lg border border-[#2a2c36] px-3 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" />
          <span className="font-mono text-[12px] text-[#5c5e6a]">Real repo scans · workspace graph</span>
        </div>

        <h1 className="mb-5 max-w-2xl text-[48px] font-semibold leading-[1.06] tracking-tight text-[#e8e9ed]">
          Understand any codebase before you touch it.
        </h1>

        <p className="mb-10 max-w-xl text-[17px] leading-relaxed text-[#8b8d98]">
          Paste a GitHub repo and Atlas turns the full system — services, queues, databases,
          external APIs — into a navigable 3D graph with agent-ready context for every connection.
        </p>

        {/* ── Input ── */}
        <form
          onSubmit={(e) => { e.preventDefault(); void start(); }}
          className="mb-4 flex w-full max-w-xl items-center gap-0 rounded-lg border border-[#2a2c36] bg-[#181a22] focus-within:border-[#818cf8]/50"
        >
          <label htmlFor="repo" className="sr-only">GitHub repository URL</label>
          <div className="flex flex-1 items-center gap-2.5 pl-4">
            <GithubMark className="h-4 w-4 shrink-0 text-[#5c5e6a]" />
            <input
              id="repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="github.com/acme/payments-platform"
              className="w-full bg-transparent py-3 text-[14px] text-[#e8e9ed] placeholder:text-[#5c5e6a] focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={scanning}
            className="flex shrink-0 cursor-pointer items-center gap-2 rounded-r-lg bg-[#818cf8] px-4 py-3 text-sm font-semibold text-white transition-colors duration-150 hover:bg-[#6366f1] disabled:pointer-events-none disabled:opacity-50"
          >
            Visualize
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>

        {submitError && (
          <p className="mb-4 max-w-xl text-[12px] text-[#fbbf24]">
            {submitError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#5c5e6a]">
          <span>Try:</span>
          {SAMPLES.map((s) => (
            <button
              key={s}
              onClick={() => void start(s)}
              className="cursor-pointer rounded-md border border-[#2a2c36] bg-[#181a22] px-2.5 py-1 font-mono text-[#8b8d98] transition-colors duration-150 hover:border-[#3a3c48] hover:text-[#e8e9ed]"
            >
              {s}
            </button>
          ))}
        </div>
      </section>

      {/* ── Divider ── */}
      <div className="border-t border-[#2a2c36]" />

      {/* ── Features ── */}
      <section className="mx-auto w-full max-w-5xl px-6 py-16">
        <div className="grid gap-px overflow-hidden rounded-xl border border-[#2a2c36] bg-[#2a2c36] sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-[#0c0d10] p-8">
              <f.icon className="mb-4 h-5 w-5 text-[#5c5e6a]" />
              <h3 className="mb-2 text-[15px] font-semibold text-[#e8e9ed]">{f.title}</h3>
              <p className="text-sm leading-relaxed text-[#8b8d98]">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-[#2a2c36]">
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-6">
          <span className="font-mono text-[12px] text-[#5c5e6a]">Atlas · hackathon build · 2026</span>
          <Link href="/explore" className="flex items-center gap-1.5 text-[13px] text-[#5c5e6a] transition-colors duration-150 hover:text-[#e8e9ed]">
            Open workspace <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </footer>

      {scanning && <ScanOverlay repo={repo} scanId={scanId} />}
    </main>
  );
}
