import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  Cloud,
  Copy,
  Cpu,
  Database,
  Link2,
  LockKeyhole,
  MonitorUp,
  QrCode,
  Smartphone,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Index,
});

const installCommand = "npx github:Sassouni1/hello-world";

function Index() {
  const [copied, setCopied] = useState(false);

  const steps = useMemo(
    () => [
      {
        icon: Terminal,
        label: "Install bridge",
        text: "Run one command on the computer that already has the desktop agent.",
      },
      {
        icon: QrCode,
        label: "Pair account",
        text: "Scan the account QR from phone or another browser.",
      },
      {
        icon: Link2,
        label: "Sync sessions",
        text: "Chats, repos, running state, files, and attachments flow through the bridge.",
      },
    ],
    [],
  );

  const copyInstallCommand = async () => {
    await navigator.clipboard.writeText(installCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <main className="min-h-screen overflow-hidden bg-[#0f0f0f] text-[#f5f5f1]">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-4 sm:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-violet-500 text-lg font-semibold text-black">
            C
          </div>
          <div>
            <div className="text-lg font-semibold leading-none">
              Command IQ <span className="text-violet-300">Console</span>
            </div>
            <div className="mt-1 text-xs uppercase tracking-[0.22em] text-white/[0.42]">AI connector</div>
          </div>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/70 sm:flex">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          Schema ready
        </div>
      </header>

      <section className="mx-auto grid w-full max-w-7xl gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:py-14">
        <div className="flex min-h-[620px] flex-col justify-between rounded-[2rem] border border-white/10 bg-[#171717] p-5 shadow-2xl shadow-black/30 sm:p-7">
          <div>
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-sm text-sky-200">
              <MonitorUp className="h-4 w-4" />
              Desktop agent bridge
            </div>
            <h1 className="max-w-3xl text-5xl font-semibold leading-[0.95] tracking-tight sm:text-7xl">
              Pair any device to the AI running on your computer.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-white/62">
              Command IQ Console is the web surface. The bridge runs locally, connects to the real
              desktop agent, and relays private session updates through Supabase.
            </p>
          </div>

          <div className="mt-10 rounded-3xl border border-white/10 bg-black/35 p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 rounded-2xl bg-black px-4 py-4 font-mono text-sm text-white/[0.86]">
                {installCommand}
              </div>
              <Button
                className="h-12 rounded-2xl bg-white px-5 text-black hover:bg-white/90"
                onClick={copyInstallCommand}
              >
                {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-4">
          <div className="rounded-[2rem] border border-white/10 bg-[#151515] p-5 sm:p-6">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-2xl font-semibold">Launch flow</h2>
              <ArrowRight className="h-5 w-5 text-white/45" />
            </div>
            <div className="grid gap-3">
              {steps.map((step) => (
                <div key={step.label} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                  <div className="flex items-start gap-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/[0.08] text-sky-200">
                      <step.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="font-semibold">{step.label}</div>
                      <div className="mt-1 text-sm leading-6 text-white/55">{step.text}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <StatusCard icon={Database} label="Supabase" value="Auth, pairing, sessions, attachments" />
            <StatusCard icon={Cpu} label="Desktop" value="Local bridge, agent server, repo access" />
            <StatusCard icon={Smartphone} label="Mobile" value="QR pairing and remote chat control" />
            <StatusCard icon={LockKeyhole} label="Isolation" value="Account-scoped rows and storage" />
          </div>

          <div className="rounded-[2rem] border border-white/10 bg-gradient-to-br from-sky-400/16 via-white/[0.035] to-violet-500/16 p-5">
            <div className="flex items-center gap-3 text-white">
              <Cloud className="h-5 w-5 text-sky-200" />
              <span className="font-semibold">Next production step</span>
            </div>
            <p className="mt-3 text-sm leading-6 text-white/62">
              Deploy the Vite site through Lovable/Cloudflare, apply the Supabase migration, then
              publish the desktop bridge command so pairing is one command plus one QR scan.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function StatusCard({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-[#151515] p-5">
      <Icon className="mb-4 h-5 w-5 text-violet-200" />
      <div className="font-semibold">{label}</div>
      <div className="mt-2 text-sm leading-6 text-white/52">{value}</div>
    </div>
  );
}
