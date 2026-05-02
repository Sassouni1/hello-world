import { createFileRoute } from "@tanstack/react-router";
import type { Session, User } from "@supabase/supabase-js";
import {
  ArrowRight,
  Bot,
  Check,
  CircleCheck,
  Copy,
  Download,
  ImagePlus,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  MonitorUp,
  Plus,
  QrCode,
  Send,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Square,
  Terminal,
  Unplug,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";

export const Route = createFileRoute("/")({
  component: Index,
});

type Account = Database["public"]["Tables"]["bridge_accounts"]["Row"];
type Device = Database["public"]["Tables"]["bridge_devices"]["Row"];
type BridgeSession = Database["public"]["Tables"]["bridge_sessions"]["Row"];
type BridgeMessage = Database["public"]["Tables"]["bridge_messages"]["Row"];
type BridgeCommand = Database["public"]["Tables"]["bridge_commands"]["Row"];
type BridgeAttachment = {
  bucket: "bridge-attachments";
  path: string;
  name: string;
  type: string;
  size: number;
};

const installCommand = "npx github:Sassouni1/hello-world";
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";

function Index() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<BridgeSession[]>([]);
  const [messages, setMessages] = useState<BridgeMessage[]>([]);
  const [commands, setCommands] = useState<BridgeCommand[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [setupPayload, setSetupPayload] = useState("");
  const [copied, setCopied] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeAccount = accounts.find((account) => account.id === activeAccountId) || null;
  const selectedSession = sessions.find((item) => item.id === selectedSessionId) || null;
  const latestCommand = commands[0] || null;
  const activeDevice = devices.find((device) => device.status === "online") || devices[0] || null;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user || null);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setUser(nextSession?.user || null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setAccounts([]);
      setActiveAccountId("");
      setSessions([]);
      setMessages([]);
      setCommands([]);
      return;
    }
    void loadAccounts(user.id);
    // loadAccounts is intentionally tied to the authenticated user changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!activeAccountId) return;
    void refreshBridgeData(activeAccountId);
    const timer = window.setInterval(() => void refreshBridgeData(activeAccountId), 2500);
    const channel = supabase
      .channel(`bridge-account-${activeAccountId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bridge_sessions",
          filter: `account_id=eq.${activeAccountId}`,
        },
        () => void refreshBridgeData(activeAccountId),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bridge_messages",
          filter: `account_id=eq.${activeAccountId}`,
        },
        () => void refreshBridgeData(activeAccountId),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bridge_commands",
          filter: `account_id=eq.${activeAccountId}`,
        },
        () => void refreshBridgeData(activeAccountId),
      )
      .subscribe();
    return () => {
      window.clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [activeAccountId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedSessionId);
  }, [selectedSessionId]);

  const bridgeSetup = useMemo(() => {
    if (!session || !activeAccount) return null;
    return {
      supabaseUrl,
      supabaseAnonKey,
      accountId: activeAccount.id,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    };
  }, [activeAccount, session]);

  const showCopied = (key: string) => {
    setCopied(key);
    window.setTimeout(() => setCopied(""), 1600);
  };

  const copyText = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    showCopied(key);
  };

  const signInWithEmail = async () => {
    if (!email.trim()) return;
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    setNotice(error ? error.message : "Check your email for the login link.");
  };

  const signInAnonymously = async () => {
    setBusy(true);
    const { error } = await supabase.auth.signInAnonymously();
    setBusy(false);
    if (error) setNotice(error.message);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setNotice("");
  };

  const loadAccounts = async (ownerUserId: string) => {
    const { data, error } = await supabase
      .from("bridge_accounts")
      .select("*")
      .eq("owner_user_id", ownerUserId)
      .order("created_at", { ascending: true });
    if (error) {
      setNotice(error.message);
      return;
    }
    if (!data.length) {
      const created = await createAccount(ownerUserId);
      if (created) return;
    }
    setAccounts(data);
    setActiveAccountId((current) => current || data[0]?.id || "");
  };

  const createAccount = async (ownerUserId = user?.id) => {
    if (!ownerUserId) return null;
    const { data, error } = await supabase
      .from("bridge_accounts")
      .insert({
        owner_user_id: ownerUserId,
        display_name: "Personal console",
        status: "disconnected",
      })
      .select("*")
      .single();
    if (error) {
      setNotice(error.message);
      return null;
    }
    setAccounts((current) => [...current, data]);
    setActiveAccountId(data.id);
    return data;
  };

  const refreshBridgeData = async (accountId: string) => {
    const [sessionResult, deviceResult, commandResult] = await Promise.all([
      supabase
        .from("bridge_sessions")
        .select("*")
        .eq("account_id", accountId)
        .order("activity_at", { ascending: false }),
      supabase
        .from("bridge_devices")
        .select("*")
        .eq("account_id", accountId)
        .order("last_seen_at", { ascending: false, nullsFirst: false }),
      supabase
        .from("bridge_commands")
        .select("*")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(8),
    ]);
    if (sessionResult.error) setNotice(sessionResult.error.message);
    else {
      setSessions(sessionResult.data || []);
      setSelectedSessionId((current) => current || sessionResult.data?.[0]?.id || "");
    }
    if (deviceResult.error) setNotice(deviceResult.error.message);
    else setDevices(deviceResult.data || []);
    if (commandResult.error) setNotice(commandResult.error.message);
    else setCommands(commandResult.data || []);
  };

  const loadMessages = async (sessionId: string) => {
    const { data, error } = await supabase
      .from("bridge_messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) setNotice(error.message);
    else setMessages(data || []);
  };

  const createPairingCode = async () => {
    if (!activeAccount) return;
    const code = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const { error } = await supabase.from("bridge_pairing_codes").insert({
      account_id: activeAccount.id,
      code_hash: code,
      expires_at: expiresAt,
    });
    if (error) {
      setNotice(error.message);
      return;
    }
    await copyText("pairing", code);
    setNotice("Pairing code copied. It expires in 15 minutes.");
  };

  const revealSetupPayload = () => {
    if (!bridgeSetup) return;
    const payload = BufferSafe.btoa(JSON.stringify(bridgeSetup));
    setSetupPayload(payload);
  };

  const uploadFiles = async (files: File[]): Promise<BridgeAttachment[]> => {
    if (!user || !activeAccount || !files.length) return [];
    const uploaded: BridgeAttachment[] = [];
    for (const file of files.slice(0, 6)) {
      const safeName = file.name.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 90) || "image";
      const objectPath = `${user.id}/${activeAccount.id}/${crypto.randomUUID()}-${safeName}`;
      const { error } = await supabase.storage.from("bridge-attachments").upload(objectPath, file, {
        contentType: file.type || "application/octet-stream",
      });
      if (error) throw error;
      uploaded.push({
        bucket: "bridge-attachments",
        path: objectPath,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
      });
    }
    return uploaded;
  };

  const queueMessage = async () => {
    if (!user || !activeAccount || (!prompt.trim() && !pendingFiles.length)) return;
    setBusy(true);
    try {
      const attachments = await uploadFiles(pendingFiles);
      const targetSession = selectedSession || (await createWebSession(prompt.trim(), attachments));
      if (!targetSession) throw new Error("Could not create a session.");
      const body = prompt.trim() || (attachments.length ? "Please review the attached image." : "");
      const attachmentJson = attachments as unknown as Json;
      await supabase.from("bridge_messages").insert({
        account_id: activeAccount.id,
        session_id: targetSession.id,
        role: "user",
        body,
        attachments: attachmentJson,
      });
      const { error } = await supabase.from("bridge_commands").insert({
        account_id: activeAccount.id,
        session_id: targetSession.id,
        requested_by: user.id,
        kind: "message",
        body,
        attachments: attachmentJson,
      });
      if (error) throw error;
      await supabase
        .from("bridge_sessions")
        .update({
          status: "working",
          activity_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", targetSession.id);
      setPrompt("");
      setPendingFiles([]);
      setSelectedSessionId(targetSession.id);
      await refreshBridgeData(activeAccount.id);
      await loadMessages(targetSession.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message failed.");
    } finally {
      setBusy(false);
    }
  };

  const createWebSession = async (seedText: string, attachments: BridgeAttachment[]) => {
    if (!activeAccount) return null;
    const title = seedText || attachments[0]?.name || "New remote chat";
    const { data, error } = await supabase
      .from("bridge_sessions")
      .insert({
        account_id: activeAccount.id,
        provider: "codex",
        provider_session_id: `web-${crypto.randomUUID()}`,
        title: title.slice(0, 90),
        status: "working",
      })
      .select("*")
      .single();
    if (error) throw error;
    setSessions((current) => [data, ...current]);
    return data;
  };

  const queueStop = async () => {
    if (!user || !activeAccount || !selectedSession) return;
    const { error } = await supabase.from("bridge_commands").insert({
      account_id: activeAccount.id,
      session_id: selectedSession.id,
      requested_by: user.id,
      kind: "stop",
      status: "queued",
    });
    if (error) setNotice(error.message);
    else setNotice("Stop command queued.");
  };

  return (
    <main className="min-h-screen overflow-hidden bg-[#0f0f0f] text-[#f5f5f1]">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-4 sm:px-8">
        <Brand />
        <div className="flex items-center gap-2">
          {user ? (
            <>
              <StatusPill
                icon={MonitorUp}
                label={activeDevice ? "Bridge seen" : "Bridge offline"}
                active={Boolean(activeDevice)}
              />
              <Button
                className="rounded-xl bg-white/[0.08] text-white hover:bg-white/[0.12]"
                onClick={signOut}
              >
                Sign out
              </Button>
            </>
          ) : (
            <StatusPill icon={LockKeyhole} label="Sign in required" />
          )}
        </div>
      </header>

      {!user ? (
        <SignedOut
          busy={busy}
          copied={copied}
          email={email}
          notice={notice}
          setEmail={setEmail}
          signInAnonymously={signInAnonymously}
          signInWithEmail={signInWithEmail}
          copyInstall={() => copyText("install", installCommand)}
        />
      ) : (
        <section className="grid min-h-[calc(100vh-73px)] grid-cols-1 lg:grid-cols-[360px_1fr_420px]">
          <aside className="border-r border-white/10 bg-[#111]">
            <div className="space-y-4 border-b border-white/10 p-4">
              <Button
                className="w-full rounded-2xl bg-white text-black hover:bg-white/90"
                onClick={() => void createAccount()}
              >
                <Plus className="mr-2 h-4 w-4" />
                New account
              </Button>
              <div className="grid gap-2">
                {accounts.map((account) => (
                  <button
                    key={account.id}
                    className={`rounded-2xl border px-4 py-3 text-left ${
                      account.id === activeAccountId
                        ? "border-sky-400/50 bg-sky-400/10"
                        : "border-white/10 bg-white/[0.03]"
                    }`}
                    onClick={() => setActiveAccountId(account.id)}
                  >
                    <div className="font-semibold">{account.display_name}</div>
                    <div className="mt-1 text-xs uppercase tracking-[0.18em] text-white/[0.42]">
                      {account.status}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4">
              <div className="mb-3 flex items-center justify-between text-sm text-white/55">
                <span>Sessions</span>
                <span>{sessions.length}</span>
              </div>
              <div className="grid gap-1">
                {sessions.map((item) => (
                  <button
                    key={item.id}
                    className={`flex items-center justify-between gap-3 border-b border-white/[0.08] px-2 py-3 text-left ${
                      item.id === selectedSessionId ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
                    }`}
                    onClick={() => setSelectedSessionId(item.id)}
                  >
                    <span className="min-w-0 truncate font-medium">{item.title}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-white/45">
                      {item.status === "working" && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      {item.status}
                    </span>
                  </button>
                ))}
                {!sessions.length && (
                  <div className="py-12 text-center text-sm text-white/45">
                    No synced sessions yet.
                  </div>
                )}
              </div>
            </div>
          </aside>

          <section className="relative flex min-h-[720px] flex-col">
            <div className="border-b border-white/10 px-5 py-4">
              <h1 className="text-2xl font-semibold">
                {selectedSession?.title || "Command IQ Console"}
              </h1>
              <div className="mt-1 text-xs uppercase tracking-[0.2em] text-white/[0.42]">
                {selectedSession?.provider_session_id || activeAccount?.id || "No account"}
              </div>
            </div>

            <div className="flex-1 space-y-5 overflow-auto px-5 py-6 pb-52">
              {messages.map((message) => (
                <MessageRow key={message.id} message={message} />
              ))}
              {!messages.length && (
                <div className="mx-auto mt-20 max-w-lg text-center text-white/45">
                  Queue a prompt below. The desktop bridge will claim it, run the local assistant,
                  and write the result back here.
                </div>
              )}
            </div>

            <div className="absolute inset-x-0 bottom-0 border-t border-white/10 bg-[#0f0f0f]/95 p-4 backdrop-blur">
              <div className="mx-auto max-w-4xl rounded-[1.6rem] border border-white/[0.12] bg-[#1f1f1f] p-3 shadow-2xl shadow-black/30">
                {!!pendingFiles.length && (
                  <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {pendingFiles.map((file) => (
                      <div
                        key={`${file.name}-${file.size}`}
                        className="truncate rounded-xl bg-white/[0.08] px-3 py-2 text-xs text-white/70"
                      >
                        {file.name}
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  className="min-h-16 w-full resize-none bg-transparent px-2 py-2 text-base text-white outline-none placeholder:text-white/[0.35]"
                  placeholder="Message the connected desktop assistant..."
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      className="hidden"
                      type="file"
                      multiple
                      accept="image/*"
                      onChange={(event) =>
                        setPendingFiles(Array.from(event.target.files || []).slice(0, 6))
                      }
                    />
                    <Button
                      className="h-10 rounded-full bg-white/[0.08] px-3 text-white hover:bg-white/[0.12]"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <ImagePlus className="h-4 w-4" />
                    </Button>
                    <Button
                      className="h-10 rounded-full bg-white/[0.08] px-3 text-white hover:bg-white/[0.12]"
                      onClick={queueStop}
                    >
                      <Square className="mr-2 h-4 w-4" />
                      Stop
                    </Button>
                  </div>
                  <Button
                    className="h-11 rounded-full bg-white px-5 text-black hover:bg-white/90"
                    disabled={busy || (!prompt.trim() && !pendingFiles.length) || !activeAccount}
                    onClick={queueMessage}
                  >
                    {busy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="mr-2 h-4 w-4" />
                    )}
                    Queue
                  </Button>
                </div>
              </div>
            </div>
          </section>

          <aside className="space-y-4 border-l border-white/10 bg-[#111] p-4">
            <Panel title="Desktop bridge">
              <div className="space-y-3">
                <CommandBox
                  copied={copied === "install"}
                  command={installCommand}
                  onCopy={() => copyText("install", installCommand)}
                />
                <Button
                  className="w-full rounded-2xl bg-sky-400 text-black hover:bg-sky-300"
                  onClick={revealSetupPayload}
                >
                  <Terminal className="mr-2 h-4 w-4" />
                  Reveal local setup payload
                </Button>
                {setupPayload && (
                  <CommandBox
                    copied={copied === "setup"}
                    command={`COMMAND_IQ_BRIDGE_SETUP='${setupPayload}' ${installCommand}`}
                    onCopy={() =>
                      copyText(
                        "setup",
                        `COMMAND_IQ_BRIDGE_SETUP='${setupPayload}' ${installCommand}`,
                      )
                    }
                  />
                )}
                <Button
                  className="w-full rounded-2xl bg-white/[0.08] text-white hover:bg-white/[0.12]"
                  onClick={createPairingCode}
                >
                  <QrCode className="mr-2 h-4 w-4" />
                  Copy pairing code
                </Button>
              </div>
            </Panel>

            <Panel title="Devices">
              <div className="grid gap-2">
                {devices.map((device) => (
                  <div
                    key={device.id}
                    className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"
                  >
                    <div className="font-semibold">{device.device_name}</div>
                    <div className="mt-1 text-xs text-white/45">
                      {device.status} · {device.platform || "desktop"}
                    </div>
                  </div>
                ))}
                {!devices.length && (
                  <p className="text-sm text-white/45">No desktop bridge has checked in yet.</p>
                )}
              </div>
            </Panel>

            <Panel title="Queue">
              <div className="grid gap-2">
                {commands.map((command) => (
                  <div
                    key={command.id}
                    className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"
                  >
                    <div className="flex items-center justify-between text-sm">
                      <span>{command.kind}</span>
                      <span className="text-white/45">{command.status}</span>
                    </div>
                    {command.error && (
                      <div className="mt-2 text-xs text-red-300">{command.error}</div>
                    )}
                  </div>
                ))}
                {!latestCommand && <p className="text-sm text-white/45">No queued commands.</p>}
              </div>
            </Panel>

            {notice && (
              <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100">
                {notice}
              </div>
            )}
          </aside>
        </section>
      )}
    </main>
  );
}

function SignedOut({
  busy,
  copied,
  email,
  notice,
  setEmail,
  signInAnonymously,
  signInWithEmail,
  copyInstall,
}: {
  busy: boolean;
  copied: string;
  email: string;
  notice: string;
  setEmail: (email: string) => void;
  signInAnonymously: () => void;
  signInWithEmail: () => void;
  copyInstall: () => void;
}) {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />
      <div className="mx-auto grid min-h-[calc(100vh-73px)] w-full max-w-7xl gap-8 px-5 py-10 sm:px-8 lg:grid-cols-[0.92fr_1.08fr] lg:items-center lg:py-16">
        <div className="relative z-10">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-sm font-medium text-cyan-200 shadow-[0_0_36px_rgba(34,211,238,0.14)]">
            <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.95)]" />
            Universal AI bridge for desktop agents
          </div>
          <h1 className="max-w-4xl text-5xl font-semibold leading-[0.94] tracking-tight text-white sm:text-7xl">
            Connect your phone to the AI systems running at home.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-white/[0.64]">
            Bridge Claude, Codex, and future desktop agents into one private web console. Send
            prompts, images, and stop commands from any browser while the real work stays on your
            computer.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button
              className="h-14 rounded-2xl bg-cyan-300 px-6 text-base font-semibold text-black shadow-[0_0_34px_rgba(34,211,238,0.32)] hover:bg-cyan-200"
              onClick={copyInstall}
            >
              {copied === "install" ? (
                <Check className="mr-2 h-5 w-5" />
              ) : (
                <Terminal className="mr-2 h-5 w-5" />
              )}
              {copied === "install" ? "Command copied" : "Copy npx installer"}
            </Button>
            <a
              className="inline-flex h-14 items-center justify-center rounded-2xl border border-white/12 bg-white/[0.06] px-6 text-base font-semibold text-white transition hover:bg-white/[0.1]"
              href="https://github.com/Sassouni1/hello-world"
              rel="noreferrer"
              target="_blank"
            >
              <Download className="mr-2 h-5 w-5" />
              Download bridge
            </a>
          </div>

          <div className="mt-5 max-w-2xl rounded-2xl border border-white/10 bg-black/60 p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 overflow-auto rounded-xl bg-[#050505] px-4 py-3 font-mono text-xs text-cyan-100/90">
                {installCommand}
              </div>
              <button
                className="rounded-xl bg-white/[0.08] px-4 py-3 text-sm font-semibold text-white hover:bg-white/[0.12]"
                onClick={copyInstall}
              >
                {copied === "install" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="mt-8 grid max-w-2xl grid-cols-3 gap-3">
            <LandingMetric label="Agents" value="Claude · Codex" />
            <LandingMetric label="Install" value="1 command" />
            <LandingMetric label="Access" value="Phone + web" />
          </div>
        </div>

        <div className="relative">
          <div className="absolute -inset-6 rounded-[2.5rem] bg-cyan-400/10 blur-3xl" />
          <BridgeConsolePreview />
        </div>
      </div>

      <div className="border-y border-white/10 bg-[#0b0b0b]">
        <div className="mx-auto grid max-w-7xl gap-4 px-5 py-5 sm:px-8 md:grid-cols-4">
          <FeaturePill icon={ShieldCheck} text="Private account isolation" />
          <FeaturePill icon={MessageSquareText} text="Messages and images" />
          <FeaturePill icon={Zap} text="Stop and queue commands" />
          <FeaturePill icon={Bot} text="Agent-ready connector" />
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-5 px-5 py-10 sm:px-8 lg:grid-cols-[0.8fr_1.2fr]">
        <Panel title="Launch your bridge">
          <div className="space-y-3">
            <input
              className="h-12 w-full rounded-2xl border border-white/10 bg-black px-4 text-white outline-none placeholder:text-white/[0.35]"
              placeholder="Email for magic link"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button
              className="h-12 w-full rounded-2xl bg-white text-black hover:bg-white/90"
              disabled={busy}
              onClick={signInWithEmail}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Open console
            </Button>
            <Button
              className="h-12 w-full rounded-2xl bg-white/[0.08] text-white hover:bg-white/[0.12]"
              disabled={busy}
              onClick={signInAnonymously}
            >
              Try without setup
            </Button>
            {notice && <p className="text-sm text-amber-100">{notice}</p>}
          </div>
        </Panel>

        <div className="grid gap-4 sm:grid-cols-3">
          <SalesStep
            icon={Terminal}
            label="Install"
            text="Run the short npx command on the computer that already has your desktop AI."
          />
          <SalesStep
            icon={QrCode}
            label="Pair"
            text="Sign in, generate a bridge payload, and connect the local machine to your account."
          />
          <SalesStep
            icon={Smartphone}
            label="Control"
            text="Message Claude, Codex, and supported agents from phone, tablet, or browser."
          />
        </div>
      </div>
    </section>
  );
}

function BridgeConsolePreview() {
  const rows = [
    { name: "Claude", status: "Ready", active: true },
    { name: "Codex", status: "Synced", active: false },
    { name: "Local browser", status: "Visible", active: false },
  ];

  return (
    <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#070707] shadow-2xl shadow-black/60">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-300 to-violet-400 text-black shadow-[0_0_28px_rgba(34,211,238,0.28)]">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <div className="text-lg font-semibold">
              Bridge<span className="text-white/45">·console</span>
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.28em] text-white/[0.38]">
              Universal · phone ⇄ desktop
            </div>
          </div>
        </div>
        <div className="hidden rounded-full border border-white/10 bg-white/[0.04] p-1 md:flex">
          <span className="rounded-full bg-cyan-300 px-4 py-2 text-sm font-semibold text-black">
            Claude
          </span>
          <span className="px-4 py-2 text-sm font-semibold text-white/60">Codex</span>
        </div>
      </div>

      <div className="grid min-h-[520px] md:grid-cols-[245px_1fr]">
        <div className="border-r border-white/10 bg-[#0c0c0c] p-4">
          <button className="mb-4 flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-300 text-black">
              <Plus className="h-4 w-4" />
            </span>
            New chat
          </button>
          <div className="rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white/45">
            Search chats
          </div>
          <div className="mt-5 space-y-2">
            {rows.map((row) => (
              <div
                key={row.name}
                className={`rounded-2xl border px-4 py-3 ${
                  row.active
                    ? "border-cyan-300/30 bg-cyan-300/10"
                    : "border-white/10 bg-white/[0.025]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{row.name}</span>
                  <span
                    className={`h-2 w-2 rounded-full ${
                      row.active ? "bg-cyan-300" : "bg-violet-300"
                    }`}
                  />
                </div>
                <div className="mt-1 text-xs uppercase tracking-[0.18em] text-white/35">
                  {row.status}
                </div>
              </div>
            ))}
          </div>
          <div className="absolute bottom-4 hidden items-center gap-2 text-xs text-white/45 md:flex">
            <span className="h-2 w-2 rounded-full bg-cyan-300" />
            local bridge online
          </div>
        </div>

        <div className="relative flex flex-col bg-[radial-gradient(circle_at_50%_0%,rgba(34,211,238,0.08),transparent_35%)]">
          <div className="border-b border-white/10 px-5 py-5">
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">
              Claude · ready
            </div>
            <div className="mt-2 text-2xl font-semibold">Run the agents already on your Mac.</div>
            <div className="mt-1 font-mono text-sm text-white/35">/users/home/desktop</div>
          </div>
          <div className="flex-1 px-5 py-6">
            <PreviewMessage
              side="left"
              label="assistant"
              text="Bridge is connected. Send work from phone, and I will route it to the right desktop agent."
            />
            <PreviewMessage
              side="right"
              label="you"
              text="Send this screenshot to Codex and ask what changed."
            />
            <div className="my-5 flex items-center gap-3 text-sm text-white/45">
              <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(34,211,238,0.8)]" />
              Working for 18s · reading files · applying patch
              <ArrowRight className="h-4 w-4" />
            </div>
          </div>
          <div className="p-5">
            <div className="rounded-[1.6rem] border border-white/10 bg-[#1d1d1d] p-3 shadow-[0_0_45px_rgba(34,211,238,0.11)]">
              <div className="px-3 py-2 text-white/35">
                Send a prompt to Claude, Codex, or your next agent...
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="rounded-full bg-cyan-300/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">
                  Claude
                </span>
                <button className="rounded-full bg-cyan-300 px-4 py-2 text-sm font-semibold text-black">
                  Send <ArrowRight className="ml-1 inline h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewMessage({
  side,
  label,
  text,
}: {
  side: "left" | "right";
  label: string;
  text: string;
}) {
  return (
    <div className={`mb-4 flex ${side === "right" ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-3xl px-4 py-3 ${
          side === "right" ? "bg-white/[0.11]" : "bg-transparent"
        }`}
      >
        <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-white/35">{label}</div>
        <div className="text-sm leading-6 text-white/80">{text}</div>
      </div>
    </div>
  );
}

function LandingMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{label}</div>
      <div className="mt-2 text-sm font-semibold text-white/85">{value}</div>
    </div>
  );
}

function FeaturePill({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.025] px-4 py-3 text-sm font-semibold text-white/70">
      <Icon className="h-4 w-4 text-cyan-200" />
      {text}
    </div>
  );
}

function SalesStep({ icon: Icon, label, text }: { icon: LucideIcon; label: string; text: string }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-[#151515] p-5">
      <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-2xl bg-white/[0.07] text-cyan-200">
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex items-center gap-2 font-semibold">
        <CircleCheck className="h-4 w-4 text-cyan-300" />
        {label}
      </div>
      <p className="mt-3 text-sm leading-6 text-white/[0.54]">{text}</p>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-violet-500 text-lg font-semibold text-black">
        C
      </div>
      <div>
        <div className="text-lg font-semibold leading-none">
          Command IQ <span className="text-violet-300">Console</span>
        </div>
        <div className="mt-1 text-xs uppercase tracking-[0.22em] text-white/[0.42]">
          AI connector
        </div>
      </div>
    </div>
  );
}

function CommandBox({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-black/35 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 overflow-auto rounded-2xl bg-black px-4 py-4 font-mono text-xs text-white/[0.86]">
          {command}
        </div>
        <Button
          className="h-12 rounded-2xl bg-white px-5 text-black hover:bg-white/90"
          onClick={onCopy}
        >
          {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: BridgeMessage }) {
  const mine = message.role === "user";
  const attachments = Array.isArray(message.attachments)
    ? (message.attachments as unknown as BridgeAttachment[])
    : [];
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-3xl rounded-[1.5rem] px-5 py-4 ${mine ? "bg-white/10" : "bg-transparent"}`}
      >
        <div className="mb-2 text-xs uppercase tracking-[0.18em] text-white/[0.35]">
          {message.role}
        </div>
        {message.body && (
          <p className="whitespace-pre-wrap leading-7 text-white/[0.88]">{message.body}</p>
        )}
        {!!attachments.length && <AttachmentGrid attachments={attachments} />}
      </div>
    </div>
  );
}

function AttachmentGrid({ attachments }: { attachments: BridgeAttachment[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    Promise.all(
      attachments.map(async (attachment) => {
        const { data } = await supabase.storage
          .from(attachment.bucket)
          .createSignedUrl(attachment.path, 60 * 30);
        return [attachment.path, data?.signedUrl || ""] as const;
      }),
    ).then((pairs) => {
      if (!alive) return;
      setUrls(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [attachments]);

  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      {attachments.map((attachment) => {
        const signedUrl = urls[attachment.path];
        return signedUrl && attachment.type.startsWith("image/") ? (
          <img
            key={attachment.path}
            alt={attachment.name}
            className="aspect-square rounded-xl border border-white/10 object-cover"
            src={signedUrl}
          />
        ) : (
          <div
            key={attachment.path}
            className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-xs text-white/[0.58]"
          >
            {attachment.name}
          </div>
        );
      })}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-[#151515] p-5">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </div>
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
      <div className="mt-2 text-sm leading-6 text-white/[0.52]">{value}</div>
    </div>
  );
}

function StatusPill({
  icon: Icon,
  label,
  active = false,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
}) {
  return (
    <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/70 sm:flex">
      <Icon className={`h-4 w-4 ${active ? "text-emerald-300" : "text-white/45"}`} />
      {label}
    </div>
  );
}

const BufferSafe = {
  btoa(value: string) {
    return window.btoa(unescape(encodeURIComponent(value)));
  },
};
