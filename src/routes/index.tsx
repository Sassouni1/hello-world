import { createFileRoute } from "@tanstack/react-router";
import type { Session, User } from "@supabase/supabase-js";
import {
  ArrowRight,
  Bot,
  Check,
  CircleCheck,
  Copy,
  ImagePlus,
  Loader2,
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
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
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
type LocalBridgeInfo = {
  name?: string;
  version?: string;
  localUrl?: string;
  phoneUrl?: string;
  cloud?: {
    enabled?: boolean;
    hasConfig?: boolean;
    lastPollAt?: string | null;
    lastError?: string;
    deviceId?: string;
    accountId?: string;
  };
};

const installCommand = "npm create vlix@latest";
const localBridgeUrl = "http://127.0.0.1:3001";
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";
const initialPairingCode =
  typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("pair") || "";
const initialDesktopSetup =
  typeof window !== "undefined" &&
  (() => {
    const params = new URLSearchParams(window.location.search);
    const desktop = (params.get("desktop") || "").toLowerCase();
    const connected = (params.get("connected") || "").toLowerCase();
    return (
      ["1", "true", "desktop"].includes(desktop) || ["1", "true", "desktop"].includes(connected)
    );
  })();
const canProbeLocalBridge =
  typeof window !== "undefined" &&
  (["localhost", "127.0.0.1"].includes(window.location.hostname) ||
    window.location.protocol === "https:");

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function Index() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [pairingCode, setPairingCode] = useState(initialPairingCode);
  const [desktopSetupRequested, setDesktopSetupRequested] = useState(initialDesktopSetup);
  const [pairingBusy, setPairingBusy] = useState(false);
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
  const [localBridge, setLocalBridge] = useState<LocalBridgeInfo | null>(null);
  const [localBridgeError, setLocalBridgeError] = useState("");
  const [syncingComputer, setSyncingComputer] = useState(false);
  const [pairingUrl, setPairingUrl] = useState("");
  const [pairingQr, setPairingQr] = useState("");
  const [viteFrameUrl, setViteFrameUrl] = useState("");
  const [viteFrameAt, setViteFrameAt] = useState("");
  const [viteDomHtml, setViteDomHtml] = useState("");
  const [viteDomAt, setViteDomAt] = useState("");
  const [viteText, setViteText] = useState("");
  const [viteBusy, setViteBusy] = useState(false);
  const autoStartedFromBridgeRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const viteFrameRef = useRef<HTMLImageElement | null>(null);

  const activeAccount = accounts.find((account) => account.id === activeAccountId) || null;
  const selectedSession = sessions.find((item) => item.id === selectedSessionId) || null;
  const latestCommand = commands[0] || null;
  const activeDevice = devices.find((device) => device.status === "online") || devices[0] || null;
  const localBridgeConnected =
    (Boolean(localBridge?.cloud?.enabled || localBridge?.cloud?.hasConfig) &&
      (!activeAccount || localBridge?.cloud?.accountId === activeAccount.id)) ||
    Boolean(activeDevice);
  const shouldOfferLocalSync = desktopSetupRequested || Boolean(localBridge);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("connected")) {
      setDesktopSetupRequested(true);
      setNotice("Local bridge setup finished. Waiting for this computer to check in...");
      url.searchParams.delete("connected");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user || null);
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setUser(nextSession?.user || null);
      setAuthReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const refreshLocalBridge = async () => {
    try {
      const response = await fetch(`${localBridgeUrl}/api/bridge/info`, {
        cache: "no-store",
        mode: "cors",
      });
      if (!response.ok) throw new Error(`Local bridge returned ${response.status}`);
      const info = (await response.json()) as LocalBridgeInfo;
      setLocalBridge(info);
      setLocalBridgeError("");
      return info;
    } catch (error) {
      setLocalBridge(null);
      setLocalBridgeError(error instanceof Error ? error.message : "Local bridge not detected.");
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const info = canProbeLocalBridge ? await refreshLocalBridge() : null;
      if (cancelled) return;
      if (!authReady) return;
      if (!info && !desktopSetupRequested) return;
      if (!user && !pairingCode && !autoStartedFromBridgeRef.current) {
        autoStartedFromBridgeRef.current = true;
        void signInAnonymously("Creating a private console for this desktop...");
      }
    };
    void tick();
    const timer = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // This poll intentionally watches the installed local bridge regardless of account state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, desktopSetupRequested, pairingCode, user]);

  useEffect(() => {
    if (!user) {
      setAccounts([]);
      setActiveAccountId("");
      setSessions([]);
      setMessages([]);
      setCommands([]);
      return;
    }
    void loadAccounts();
    // loadAccounts is intentionally tied to the authenticated user changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!authReady || !pairingCode || user || pairingBusy) return;
    setPairingBusy(true);
    supabase.auth.signInAnonymously().then(({ error }) => {
      if (error) setNotice(error.message);
      setPairingBusy(false);
    });
  }, [authReady, pairingBusy, pairingCode, user]);

  useEffect(() => {
    if (!pairingCode || !user || pairingBusy) return;
    let cancelled = false;
    setPairingBusy(true);
    (async () => {
      try {
        const { data, error } = await supabase.rpc("consume_bridge_pairing_code", {
          pairing_code: pairingCode,
        });
        if (cancelled) return;
        if (error) {
          setNotice(error.message);
          return;
        }
        const accountId = typeof data === "string" ? data : "";
        setNotice("Phone paired. This browser can now message the desktop bridge from anywhere.");
        setPairingCode("");
        const url = new URL(window.location.href);
        url.searchParams.delete("pair");
        url.searchParams.delete("phone");
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        await loadAccounts();
        if (accountId) setActiveAccountId(accountId);
      } finally {
        if (!cancelled) setPairingBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // loadAccounts is intentionally called after pairing consumption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairingBusy, pairingCode, user]);

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
      userId: user?.id,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    };
  }, [activeAccount, session, user?.id]);
  const cloudConnectCommand = setupPayload
    ? `VLIX_BRIDGE_SETUP='${setupPayload}' ${installCommand}`
    : "";

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

  const signInAnonymously = async (pendingNotice = "") => {
    if (pendingNotice) setNotice(pendingNotice);
    setBusy(true);
    const { error } = await supabase.auth.signInAnonymously();
    setBusy(false);
    if (error) setNotice(error.message);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setNotice("");
  };

  const loadAccounts = async () => {
    const { data, error } = await supabase
      .from("bridge_accounts")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) {
      setNotice(error.message);
      return;
    }
    if (!data.length && !pairingCode) {
      const created = await createAccount();
      if (created) return;
    }
    setAccounts(data);
    setActiveAccountId((current) => current || data[0]?.id || "");
  };

  const createAccount = async () => {
    if (!user) return null;
    const { data, error } = await supabase
      .rpc("create_bridge_account", { display_name: "Personal console" });
    if (error) {
      setNotice(error.message);
      return null;
    }
    const account = data as Account | null;
    if (!account) return null;
    setAccounts((current) => [...current, account]);
    setActiveAccountId(account.id);
    return account;
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
    if (localBridge && localBridgeConnected) {
      try {
        const response = await fetch(`${localBridgeUrl}/api/pairing/start`, {
          method: "POST",
          mode: "cors",
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Local bridge returned ${response.status}`);
        setPairingUrl(body.url || "");
        setPairingQr(body.qr || "");
        if (body.url) await copyText("pairing", body.url);
        setNotice("Phone pairing link copied. It opens the hosted Vlix site from any network.");
        return;
      } catch (error) {
        setNotice(
          `Could not ask the local bridge for a QR. ${
            error instanceof Error ? error.message : ""
          }`.trim(),
        );
      }
    }
    const code = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const { error } = await supabase.from("bridge_pairing_codes").insert({
      account_id: activeAccount.id,
      code_hash: await sha256Hex(code),
      expires_at: expiresAt,
    });
    if (error) {
      setNotice(error.message);
      return;
    }
    const url = new URL(window.location.origin);
    url.searchParams.set("pair", code);
    url.searchParams.set("phone", "1");
    setPairingUrl(url.toString());
    setPairingQr("");
    await copyText("pairing", url.toString());
    setNotice("Phone pairing link copied. It expires in 15 minutes.");
  };

  const revealSetupPayload = () => {
    if (!bridgeSetup) return;
    const payload = BufferSafe.btoa(JSON.stringify(bridgeSetup));
    setSetupPayload(payload);
  };

  const connectLocalBridge = async () => {
    if (!bridgeSetup) {
      setNotice("Start the web console first, then sync this computer.");
      return;
    }
    const payload = BufferSafe.btoa(JSON.stringify(bridgeSetup));
    setSetupPayload(payload);
    const openHandoff = () => {
      const returnUrl = new URL(window.location.origin);
      returnUrl.searchParams.set("connected", "1");
      const handoff = new URL(`${localBridgeUrl}/cloud-connect`);
      handoff.hash = new URLSearchParams({
        setup: payload,
        return: returnUrl.toString(),
      }).toString();
      setNotice("Opening the local bridge handoff...");
      window.location.href = handoff.toString();
    };
    if (!localBridge) {
      openHandoff();
      return;
    }
    setSyncingComputer(true);
    try {
      const response = await fetch(`${localBridgeUrl}/api/cloud/connect`, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setup: payload }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || `Local bridge returned ${response.status}`);
      }
      setNotice("This computer is synced. Phone pairing can now use the hosted Vlix URL.");
      await refreshLocalBridge();
      if (activeAccount) await refreshBridgeData(activeAccount.id);
    } catch {
      openHandoff();
    } finally {
      setSyncingComputer(false);
    }
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

  const viteFramePath = user && activeAccount ? `${user.id}/${activeAccount.id}/vite-browser/latest.jpg` : "";
  const viteDomPath = user && activeAccount ? `${user.id}/${activeAccount.id}/vite-browser/latest-dom.json` : "";

  const loadViteDom = async () => {
    if (!viteDomPath) return false;
    const { data, error } = await supabase.storage
      .from("bridge-attachments")
      .createSignedUrl(viteDomPath, 90);
    if (error || !data?.signedUrl) return false;
    const response = await fetch(`${data.signedUrl}${data.signedUrl.includes("?") ? "&" : "?"}t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) return false;
    const mirror = (await response.json()) as { html?: string; capturedAt?: string };
    if (!mirror.html) return false;
    setViteDomHtml(mirror.html);
    setViteDomAt(
      new Date(mirror.capturedAt || Date.now()).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
    return true;
  };

  const loadViteFrame = async () => {
    if (!viteFramePath) return false;
    const { data, error } = await supabase.storage
      .from("bridge-attachments")
      .createSignedUrl(viteFramePath, 90);
    if (error || !data?.signedUrl) return false;
    setViteFrameUrl(`${data.signedUrl}${data.signedUrl.includes("?") ? "&" : "?"}t=${Date.now()}`);
    setViteFrameAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }));
    return true;
  };

  useEffect(() => {
    setViteFrameUrl("");
    setViteFrameAt("");
    setViteDomHtml("");
    setViteDomAt("");
    if (!viteFramePath && !viteDomPath) return;
    const refresh = async () => {
      const hasDom = await loadViteDom();
      if (!hasDom) await loadViteFrame();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
    // Vite mirror loaders are intentionally recreated with the active private storage paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viteFramePath, viteDomPath]);

  const queueBrowserCommand = async (payload: Record<string, unknown>) => {
    if (!user || !activeAccount) {
      setNotice("Start the web console first.");
      return;
    }
    setViteBusy(true);
    try {
      const { error } = await supabase.from("bridge_commands").insert({
        account_id: activeAccount.id,
        session_id: null,
        requested_by: user.id,
        kind: "browser",
        status: "queued",
        body: JSON.stringify(payload),
        attachments: [],
      });
      if (error) throw error;
      setNotice("Vite browser command queued to your desktop.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Vite browser command failed.");
    } finally {
      setViteBusy(false);
    }
  };

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.source !== "vlix-vite-dom") return;
      const action =
        data.type === "scroll" || data.type === "type" || data.type === "press" ? data.type : "click";
      void queueBrowserCommand({
        action,
        nodeId: data.nodeId || "",
        xRatio: data.xRatio,
        yRatio: data.yRatio,
        deltaX: data.deltaX,
        deltaY: data.deltaY,
        text: data.text,
        key: data.key,
      });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // The handler needs the latest account/user values from queueBrowserCommand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, activeAccount?.id]);

  const viteFramePoint = (event: MouseEvent<HTMLImageElement>) => {
    const image = viteFrameRef.current;
    if (!image) return { xRatio: 0.5, yRatio: 0.5 };
    const rect = image.getBoundingClientRect();
    const naturalRatio = 1280 / 820;
    const displayedRatio = rect.width / rect.height;
    let imageWidth = rect.width;
    let imageHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (displayedRatio > naturalRatio) {
      imageWidth = rect.height * naturalRatio;
      offsetX = (rect.width - imageWidth) / 2;
    } else {
      imageHeight = rect.width / naturalRatio;
      offsetY = (rect.height - imageHeight) / 2;
    }
    const x = Math.max(0, Math.min(imageWidth, event.clientX - rect.left - offsetX));
    const y = Math.max(0, Math.min(imageHeight, event.clientY - rect.top - offsetY));
    return {
      xRatio: imageWidth ? x / imageWidth : 0.5,
      yRatio: imageHeight ? y / imageHeight : 0.5,
    };
  };

  const typeIntoVite = async () => {
    if (!viteText.trim()) return;
    await queueBrowserCommand({ action: "type", text: viteText });
    setViteText("");
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
            <StatusPill
              icon={shouldOfferLocalSync ? MonitorUp : ShieldCheck}
              label={shouldOfferLocalSync ? "Desktop setup" : "Ready"}
              active={shouldOfferLocalSync}
            />
          )}
        </div>
      </header>

      {!user ? (
        <SignedOut
          busy={busy || pairingBusy}
          copied={copied}
          localBridge={localBridge}
          localBridgeError={localBridgeError}
          notice={notice}
          shouldOfferLocalSync={shouldOfferLocalSync}
          copyInstall={() => copyText("install", installCommand)}
          startConsole={() => void signInAnonymously("Creating a private console...")}
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
              <h1 className="text-2xl font-semibold">{selectedSession?.title || "Vlix"}</h1>
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
                <p className="text-sm leading-6 text-white/50">
                  Sync the local bridge running on this computer. After it checks in, your phone can
                  use this hosted website from any network.
                </p>
                {shouldOfferLocalSync ? (
                  <Button
                    className="w-full rounded-2xl bg-sky-400 text-black hover:bg-sky-300"
                    disabled={syncingComputer || localBridgeConnected}
                    onClick={connectLocalBridge}
                  >
                    {syncingComputer ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : localBridgeConnected ? (
                      <CircleCheck className="mr-2 h-4 w-4" />
                    ) : (
                      <MonitorUp className="mr-2 h-4 w-4" />
                    )}
                    {localBridgeConnected ? "This computer is synced" : "Sync this computer"}
                  </Button>
                ) : (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm text-white/48">
                    Run the npm installer on this computer. It will reopen this site in desktop
                    setup mode.
                  </div>
                )}
                <Button
                  className="w-full rounded-2xl bg-white/[0.08] text-white hover:bg-white/[0.12]"
                  onClick={revealSetupPayload}
                >
                  <Terminal className="mr-2 h-4 w-4" />
                  Copy terminal fallback
                </Button>
                {setupPayload && (
                  <CommandBox
                    copied={copied === "setup"}
                    command={cloudConnectCommand}
                    onCopy={() => copyText("setup", cloudConnectCommand)}
                  />
                )}
                <Button
                  className="w-full rounded-2xl bg-white/[0.08] text-white hover:bg-white/[0.12]"
                  onClick={() => copyText("install", installCommand)}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Copy base installer
                </Button>
                <p className="text-xs leading-5 text-white/38">
                  If the browser blocks localhost setup, paste the fallback command into Terminal.
                  The QR code uses the hosted Vlix URL after this computer is synced.
                </p>
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

            <Panel title="Vite browser">
              <div className="space-y-3">
                <p className="text-sm leading-6 text-white/50">
                  See the desktop-managed Vite window from this website. Tap the frame to click,
                  scroll it, or type into the app from your phone.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    className="rounded-2xl bg-sky-400 text-black hover:bg-sky-300"
                    disabled={viteBusy || !activeAccount}
                    onClick={() => queueBrowserCommand({ action: "start" })}
                  >
                    {viteBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Show
                  </Button>
                  <Button
                    className="rounded-2xl bg-white/[0.08] text-white hover:bg-white/[0.12]"
                    disabled={viteBusy || !activeAccount}
                    onClick={() => queueBrowserCommand({ action: "reload" })}
                  >
                    Reload
                  </Button>
                  <Button
                    className="rounded-2xl bg-white/[0.08] text-white hover:bg-white/[0.12]"
                    disabled={viteBusy || !activeAccount}
                    onClick={() => queueBrowserCommand({ action: "stop" })}
                  >
                    Stop
                  </Button>
                </div>
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
                  {viteDomHtml ? (
                    <iframe
                      title="Live Vite DOM mirror from desktop"
                      className="aspect-[1280/820] w-full bg-white"
                      sandbox="allow-scripts allow-forms"
                      srcDoc={viteDomHtml}
                    />
                  ) : viteFrameUrl ? (
                    <img
                      ref={viteFrameRef}
                      alt="Live Vite browser from desktop"
                      className="aspect-[1280/820] w-full select-none object-contain"
                      draggable={false}
                      src={viteFrameUrl}
                      onClick={(event) =>
                        queueBrowserCommand({ action: "click", ...viteFramePoint(event) })
                      }
                      onWheel={(event) => {
                        event.preventDefault();
                        void queueBrowserCommand({
                          action: "scroll",
                          deltaX: event.deltaX,
                          deltaY: event.deltaY,
                        });
                      }}
                    />
                  ) : (
                    <div className="flex aspect-[1280/820] items-center justify-center px-4 text-center text-sm text-white/42">
                      Click Show after your desktop bridge is synced. The phone will load the latest
                      Vite frame here.
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs text-white/38">
                  <span>
                    {viteDomAt
                      ? `DOM mirror ${viteDomAt}`
                      : viteFrameAt
                        ? `Frame fallback ${viteFrameAt}`
                        : "Waiting for desktop view"}
                  </span>
                  <span>{viteDomHtml ? "clickable DOM relay" : "image fallback"}</span>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
                  <input
                    className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm text-white outline-none placeholder:text-white/35"
                    placeholder="Type into Vite..."
                    value={viteText}
                    onChange={(event) => setViteText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void typeIntoVite();
                      }
                    }}
                  />
                  <Button
                    className="rounded-2xl bg-white/[0.08] text-white hover:bg-white/[0.12]"
                    disabled={viteBusy || !viteText.trim()}
                    onClick={() => void typeIntoVite()}
                  >
                    Type
                  </Button>
                  <Button
                    className="rounded-2xl bg-white/[0.08] text-white hover:bg-white/[0.12]"
                    disabled={viteBusy}
                    onClick={() => queueBrowserCommand({ action: "press", key: "Enter" })}
                  >
                    Enter
                  </Button>
                </div>
              </div>
            </Panel>

            <Panel title="Phone access">
              {localBridgeConnected ? (
                <div className="space-y-3">
                  <Button
                    className="w-full rounded-2xl bg-white text-black hover:bg-white/90"
                    onClick={createPairingCode}
                  >
                    <QrCode className="mr-2 h-4 w-4" />
                    Pair phone
                  </Button>
                  {pairingQr && (
                    <img
                      alt="Vlix phone pairing QR"
                      className="mx-auto w-44 rounded-2xl border border-white/10 bg-white p-2"
                      src={pairingQr}
                    />
                  )}
                  {pairingUrl && (
                    <div className="break-all rounded-2xl border border-white/10 bg-black/35 p-3 text-xs text-white/55">
                      {pairingUrl}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm leading-6 text-white/45">
                  Sync this computer first. Then phone pairing will create a hosted Vlix link, not a
                  local Wi-Fi URL.
                </p>
              )}
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
  localBridge,
  localBridgeError,
  notice,
  shouldOfferLocalSync,
  copyInstall,
  startConsole,
}: {
  busy: boolean;
  copied: string;
  localBridge: LocalBridgeInfo | null;
  localBridgeError: string;
  notice: string;
  shouldOfferLocalSync: boolean;
  copyInstall: () => void;
  startConsole: () => void;
}) {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />
      <div className="mx-auto grid min-h-[calc(100svh-73px)] w-full max-w-7xl gap-8 px-4 py-8 sm:px-8 sm:py-10 lg:grid-cols-[0.92fr_1.08fr] lg:items-center lg:py-16">
        <div className="relative z-10">
          <div className="mb-5 inline-flex max-w-full items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-xs font-medium text-cyan-200 shadow-[0_0_36px_rgba(34,211,238,0.14)] sm:mb-7 sm:text-sm">
            <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.95)]" />
            Universal AI bridge for desktop agents
          </div>
          <h1 className="max-w-4xl text-[2.65rem] font-semibold leading-[0.96] tracking-tight text-white sm:text-6xl lg:text-7xl">
            Command your local AI agents from anywhere.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-white/[0.64] sm:mt-6 sm:text-lg sm:leading-8">
            Bridge Claude, Codex, and future desktop agents into one private web console. Send
            prompts, images, and stop commands from any browser through Supabase while the real work
            stays on your computer.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:mt-8 sm:flex-row">
            <Button
              className="h-[52px] rounded-2xl bg-white px-5 text-sm font-semibold text-black hover:bg-white/90 sm:h-14 sm:px-6 sm:text-base"
              disabled={busy}
              onClick={startConsole}
            >
              {busy ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <MonitorUp className="mr-2 h-5 w-5" />
              )}
              {shouldOfferLocalSync ? "Open console and sync" : "Start web console"}
            </Button>
            <Button
              className="h-[52px] rounded-2xl bg-cyan-300 px-5 text-sm font-semibold text-black shadow-[0_0_34px_rgba(34,211,238,0.32)] hover:bg-cyan-200 sm:h-14 sm:px-6 sm:text-base"
              onClick={copyInstall}
            >
              {copied === "install" ? (
                <Check className="mr-2 h-5 w-5" />
              ) : (
                <Terminal className="mr-2 h-5 w-5" />
              )}
              {copied === "install" ? "Command copied" : "Copy npm create vlix@latest"}
            </Button>
            <a
              className="inline-flex h-[52px] items-center justify-center rounded-2xl border border-white/12 bg-white/[0.06] px-5 text-sm font-semibold text-white transition hover:bg-white/[0.1] sm:h-14 sm:px-6 sm:text-base"
              href="https://www.npmjs.com/package/create-vlix"
              rel="noreferrer"
              target="_blank"
            >
              View npm package
              <ArrowRight className="ml-2 h-5 w-5" />
            </a>
          </div>

          <div className="mt-4 flex max-w-2xl flex-col gap-2 text-sm sm:flex-row sm:items-center">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 ${
                shouldOfferLocalSync
                  ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
                  : "border-white/10 bg-white/[0.04] text-white/45"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  shouldOfferLocalSync ? "bg-emerald-300" : "bg-white/25"
                }`}
              />
              {shouldOfferLocalSync ? "Desktop setup ready" : "Waiting for local bridge"}
            </span>
            {notice && <span className="text-white/50">{notice}</span>}
            {!shouldOfferLocalSync && localBridgeError && (
              <span className="text-white/35">Run the installer, then this will switch on.</span>
            )}
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
            <p className="mt-3 px-1 text-xs leading-5 text-white/45">
              Installs and runs the desktop bridge through npm. When it opens this website, Vlix can
              create a private console and sync this computer without an email login.
            </p>
          </div>

          <div className="mt-7 grid max-w-2xl grid-cols-1 gap-3 sm:mt-8 sm:grid-cols-3">
            <LandingMetric label="Agents" value="Claude · Codex" />
            <LandingMetric label="Install" value="1 command" />
            <LandingMetric label="Access" value="Phone + web" />
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[560px] lg:max-w-none">
          <div className="absolute -inset-4 rounded-[2rem] bg-cyan-400/10 blur-3xl sm:-inset-6 sm:rounded-[2.5rem]" />
          <BridgeConsolePreview />
        </div>
      </div>

      <div className="border-y border-white/10 bg-[#0b0b0b]">
        <div className="mx-auto grid max-w-7xl gap-3 px-4 py-4 sm:grid-cols-2 sm:px-8 sm:py-5 lg:grid-cols-4">
          <FeaturePill icon={ShieldCheck} text="Private account isolation" />
          <FeaturePill icon={MessageSquareText} text="Messages and images" />
          <FeaturePill icon={Zap} text="Stop and queue commands" />
          <FeaturePill icon={Bot} text="Agent-ready connector" />
        </div>
      </div>

      <RemoteAccessShowcase />

      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-8">
        <div className="grid gap-4 sm:grid-cols-3">
          <SalesStep
            icon={Terminal}
            label="Install"
            text="Run the short npm command on the computer that already has your desktop AI."
          />
          <SalesStep
            icon={QrCode}
            label="Connect"
            text="Click Sync this computer. Vlix creates a private anonymous console and binds that machine to it."
          />
          <SalesStep
            icon={Smartphone}
            label="Control"
            text="Message Claude, Codex, and supported agents from phone, tablet, or browser without LAN access."
          />
        </div>
      </div>
    </section>
  );
}

function RemoteAccessShowcase() {
  const flow = [
    { icon: Smartphone, label: "Phone", value: "vlix1.lovable.app" },
    { icon: ShieldCheck, label: "Cloud relay", value: "Supabase private account" },
    { icon: MonitorUp, label: "Remote queue", value: "Desktop bridge online" },
    { icon: Bot, label: "Local agent", value: "Claude, Codex, more" },
  ];

  return (
    <section className="border-b border-white/10 bg-[#101010]">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-8 sm:py-12 lg:grid-cols-[0.86fr_1.14fr] lg:items-center lg:py-14">
        <div>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
            <span className="h-2 w-2 rounded-full bg-cyan-300" />
            Remote mode
          </div>
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-5xl">
            Your phone talks to the website. The website relays to the desktop.
          </h2>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-white/[0.58] sm:mt-5 sm:text-base sm:leading-8">
            The phone never needs to find your laptop on Wi-Fi. Messages, images, stop commands,
            and status updates move through the private Supabase relay, then the desktop bridge runs
            the real local agent.
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 sm:gap-3.5">
            {flow.map(({ icon: Icon, label, value }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-3.5 py-3 sm:px-4"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-cyan-300/12 text-cyan-200 sm:h-10 sm:w-10">
                  <Icon className="h-[18px] w-[18px] sm:h-5 sm:w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-white/35 sm:text-xs">
                    {label}
                  </div>
                  <div className="mt-1 truncate text-sm font-semibold text-white/82">{value}</div>
                </div>
              </div>
            ))}
          </div>

          <WakeComputerAnimation />
        </div>

        <div className="grid gap-5 lg:grid-cols-[340px_1fr] xl:grid-cols-[380px_1fr] lg:items-center">
          <figure className="mx-auto w-full max-w-[280px] sm:max-w-[330px] lg:max-w-[360px] xl:max-w-[390px]">
            <img
              alt="Vlix mobile console running on a phone through the cloud relay"
              className="h-auto w-full select-none object-contain drop-shadow-[0_34px_70px_rgba(34,211,238,0.13)] sm:drop-shadow-[0_44px_80px_rgba(34,211,238,0.13)]"
              draggable={false}
              src="/vlix-remote-phone.png"
            />
          </figure>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <RemoteRelayRow
              icon={Smartphone}
              label="1. Send from anywhere"
              text="The phone uses the hosted Vlix website on cellular, office Wi-Fi, or home Wi-Fi."
            />
            <RemoteRelayRow
              icon={ShieldCheck}
              label="2. Relay through Supabase"
              text="RLS keeps each user account isolated while queued commands wait for their desktop."
            />
            <RemoteRelayRow
              icon={MonitorUp}
              label="3. Run locally"
              text="As long as the desktop bridge is running, it claims queued work and runs the real local agent."
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function WakeComputerAnimation() {
  return (
    <div className="wake-demo mt-6 overflow-hidden rounded-[1.6rem] border border-white/10 bg-black/35 p-4 shadow-[0_24px_70px_rgba(0,0,0,0.28)]">
      <style>{`
        .wake-demo .wake-message {
          opacity: 0;
          transform: translateY(7px);
          overflow: hidden;
        }
        .wake-demo .wake-message.one { animation: wakeMsgOne 14s linear infinite; }
        .wake-demo .wake-message.two { animation: wakeMsgTwo 14s linear infinite; }
        .wake-demo .wake-message.three { animation: wakeMsgThree 14s linear infinite; }
        .wake-demo .wake-message.four { animation: wakeMsgFour 14s linear infinite; }
        .wake-demo .wake-message.five { animation: wakeMsgFive 14s linear infinite; }
        .wake-demo .wake-message.six { animation: wakeMsgSix 14s linear infinite; }
        .wake-demo .wake-screen {
          opacity: 0;
          transform: translateY(6px) scale(0.98);
        }
        .wake-demo .wake-screen.sleep { animation: wakeSleepPanel 14s linear infinite; }
        .wake-demo .wake-screen.boot { animation: wakeBootPanel 14s linear infinite; }
        .wake-demo .wake-screen.ready { animation: wakeReadyPanel 14s linear infinite; }
        .wake-demo .wake-screen.code { animation: wakeCodePanel 14s linear infinite; }
        .wake-demo .wake-pulse {
          animation: wakePulse 1.45s ease-in-out infinite;
        }
        .wake-demo .wake-code-line {
          animation: wakeCodeLine 1.8s ease-in-out infinite;
          transform-origin: left;
        }
        .wake-demo .wake-code-line:nth-child(2) { animation-delay: 0.2s; }
        .wake-demo .wake-code-line:nth-child(3) { animation-delay: 0.45s; }
        .wake-demo .wake-code-line:nth-child(4) { animation-delay: 0.7s; }
        .wake-demo .wake-agent-row {
          animation: wakeAgent 1.8s ease-in-out infinite;
        }
        .wake-demo .wake-agent-row:nth-child(2) { animation-delay: 0.24s; }
        .wake-demo .wake-agent-row:nth-child(3) { animation-delay: 0.48s; }
        @keyframes wakeMsgOne {
          0%, 94% { opacity: 1; transform: translateY(0); }
          98%, 100% { opacity: 0; transform: translateY(-5px); }
        }
        @keyframes wakeMsgTwo {
          0%, 12% { opacity: 0; transform: translateY(7px); }
          16%, 94% { opacity: 1; transform: translateY(0); }
          98%, 100% { opacity: 0; transform: translateY(-5px); }
        }
        @keyframes wakeMsgThree {
          0%, 26% { opacity: 0; transform: translateY(7px); }
          30%, 94% { opacity: 1; transform: translateY(0); }
          98%, 100% { opacity: 0; transform: translateY(-5px); }
        }
        @keyframes wakeMsgFour {
          0%, 43% { opacity: 0; transform: translateY(7px); }
          47%, 94% { opacity: 1; transform: translateY(0); }
          98%, 100% { opacity: 0; transform: translateY(-5px); }
        }
        @keyframes wakeMsgFive {
          0%, 58% { opacity: 0; transform: translateY(7px); }
          62%, 94% { opacity: 1; transform: translateY(0); }
          98%, 100% { opacity: 0; transform: translateY(-5px); }
        }
        @keyframes wakeMsgSix {
          0%, 72% { opacity: 0; transform: translateY(7px); }
          76%, 94% { opacity: 1; transform: translateY(0); }
          98%, 100% { opacity: 0; transform: translateY(-5px); }
        }
        @keyframes wakeSleepPanel {
          0%, 14% { opacity: 1; transform: translateY(0) scale(1); }
          18%, 100% { opacity: 0; transform: translateY(-5px) scale(0.99); }
        }
        @keyframes wakeBootPanel {
          0%, 17% { opacity: 0; transform: translateY(6px) scale(0.98); }
          21%, 29% { opacity: 1; transform: translateY(0) scale(1); }
          33%, 100% { opacity: 0; transform: translateY(-5px) scale(0.99); }
        }
        @keyframes wakeReadyPanel {
          0%, 30% { opacity: 0; transform: translateY(6px) scale(0.98); }
          34%, 44% { opacity: 1; transform: translateY(0) scale(1); }
          48%, 100% { opacity: 0; transform: translateY(-5px) scale(0.99); }
        }
        @keyframes wakeCodePanel {
          0%, 46% { opacity: 0; transform: translateY(6px) scale(0.98); }
          50%, 94% { opacity: 1; transform: translateY(0) scale(1); }
          98%, 100% { opacity: 0; transform: translateY(-5px) scale(0.99); }
        }
        @keyframes wakePulse {
          0%, 100% { box-shadow: 0 0 0 rgba(34,211,238,0); opacity: 0.72; }
          50% { box-shadow: 0 0 22px rgba(34,211,238,0.72); opacity: 1; }
        }
        @keyframes wakeCodeLine {
          0%, 100% { transform: scaleX(0.42); opacity: 0.48; }
          50% { transform: scaleX(1); opacity: 1; }
        }
        @keyframes wakeAgent {
          0%, 100% { border-color: rgba(255,255,255,0.1); background: rgba(255,255,255,0.035); }
          50% { border-color: rgba(34,211,238,0.45); background: rgba(34,211,238,0.12); }
        }
      `}</style>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-200">
            Remote work demo
          </div>
          <div className="mt-1 text-sm font-semibold text-white/86">
            Reach the desktop, then send real work into your local agent.
          </div>
        </div>
        <div className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-semibold text-cyan-100">
          looping
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr] lg:items-stretch">
        <div className="rounded-3xl border border-white/10 bg-[#101010] p-3">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-300/12 text-cyan-100">
                <Smartphone className="h-4 w-4" />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-white/36">Phone</div>
                <div className="text-sm font-semibold text-white">Vlix mobile</div>
              </div>
            </div>
            <span className="rounded-full bg-cyan-300/10 px-2.5 py-1 text-[11px] font-semibold text-cyan-100">
              remote
            </span>
          </div>

          <div className="space-y-2.5">
            <div className="wake-message one ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-white/[0.12] px-3 py-2 text-sm font-semibold text-white">
              Hey, is my computer online?
            </div>
            <div className="wake-message two max-w-[88%] rounded-2xl rounded-bl-md bg-cyan-300/10 px-3 py-2 text-sm text-cyan-50">
              Checking your desktop bridge...
            </div>
            <div className="wake-message three max-w-[92%] rounded-2xl rounded-bl-md bg-white/[0.055] px-3 py-2 text-sm text-white/84">
              Hey, I&apos;m here and ready to work.
            </div>
            <div className="wake-message four ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-white/[0.12] px-3 py-2 text-sm font-semibold text-white">
              Create a visually stunning website.
            </div>
            <div className="wake-message five ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-white/[0.12] px-3 py-2 text-sm font-semibold text-white">
              Then let&apos;s work on my codebase.
            </div>
            <div className="wake-message six max-w-[94%] rounded-2xl rounded-bl-md border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-sm text-cyan-50">
              <div className="font-semibold text-white">Okay, getting started.</div>
              <div className="mt-2 rounded-2xl border border-white/10 bg-black/28 p-2.5">
                <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(34,211,238,0.9)]" />
                    <span className="text-[11px] font-semibold text-white sm:text-xs">
                      Deploying agents
                    </span>
                  </div>
                  <span className="shrink-0 text-[10px] font-semibold text-cyan-100/70 sm:text-[11px]">
                    3 active ›
                  </span>
                </div>
                <div className="mt-2 space-y-1.5">
                  {[
                    ["Explorer", "mapping repo"],
                    ["Designer", "designing UI"],
                    ["Worker", "editing code"],
                  ].map(([name, task]) => (
                    <div
                      key={name}
                      className="wake-agent-row flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-2.5 py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white">{name}</div>
                        <div className="text-[11px] leading-snug text-white/52">{task}</div>
                      </div>
                      <Bot className="h-3.5 w-3.5 shrink-0 text-cyan-100/70" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-[#080808] p-3">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="wake-pulse flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-300/12 text-cyan-100">
                <MonitorUp className="h-4 w-4" />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-white/36">
                  Desktop
                </div>
                <div className="text-sm font-semibold text-white">Desktop screen</div>
              </div>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-white/60">
              Mac / PC
            </span>
          </div>

          <div className="mx-auto max-w-[360px]">
            <div className="relative min-h-[230px] overflow-hidden rounded-[1.35rem] border border-white/12 bg-black p-3 shadow-[0_0_35px_rgba(34,211,238,0.12)]">
              <div className="absolute left-1/2 top-2 h-1 w-16 -translate-x-1/2 rounded-full bg-white/10" />
              <div className="wake-screen sleep absolute inset-4 grid place-items-center rounded-xl bg-[#050505] text-center">
                <div>
                  <div className="mx-auto mb-3 h-2 w-12 rounded-full bg-white/10" />
                  <div className="text-sm font-semibold text-white/78">Desktop idle</div>
                  <div className="mt-1 text-xs text-white/36">waiting for cloud relay</div>
                </div>
              </div>

              <div className="wake-screen boot absolute inset-4 grid place-items-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-center">
                <div>
                  <div className="wake-pulse mx-auto mb-3 h-8 w-8 rounded-full border-2 border-cyan-200/60 border-t-cyan-200" />
                  <div className="text-sm font-semibold text-cyan-50">Connecting desktop...</div>
                  <div className="mt-1 text-xs text-cyan-100/55">desktop bridge reconnecting</div>
                </div>
              </div>

              <div className="wake-screen ready absolute inset-4 grid place-items-center rounded-xl border border-cyan-300/25 bg-[radial-gradient(circle_at_50%_45%,rgba(34,211,238,0.28),rgba(6,16,18,0.96)_58%)] text-center">
                <div>
                  <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-2xl bg-cyan-300 text-black">
                    <Check className="h-5 w-5" />
                  </div>
                  <div className="text-sm font-semibold text-white">
                    Hello, I&apos;m awake and ready to work.
                  </div>
                  <div className="mt-1 text-xs text-cyan-100/58">agent connected</div>
                </div>
              </div>

              <div className="wake-screen code absolute inset-4 rounded-xl border border-white/10 bg-[#071011] p-3">
                <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-cyan-100">
                  <Terminal className="h-3.5 w-3.5" />
                  Working in codebase
                </div>
                <div className="space-y-2">
                  <div className="wake-code-line h-2 w-full rounded-full bg-cyan-300/60" />
                  <div className="wake-code-line h-2 w-[72%] rounded-full bg-violet-300/50" />
                  <div className="wake-code-line h-2 w-[88%] rounded-full bg-white/28" />
                  <div className="wake-code-line h-2 w-[58%] rounded-full bg-cyan-300/42" />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="h-12 rounded-xl bg-cyan-300/16" />
                  <div className="h-12 rounded-xl bg-white/10" />
                  <div className="h-12 rounded-xl bg-violet-300/16" />
                </div>
              </div>
            </div>
            <div className="mx-auto h-8 w-20 border-x border-white/10" />
            <div className="mx-auto h-3 w-36 rounded-full bg-white/10" />
          </div>
        </div>
      </div>
    </div>
  );
}

function BridgeConsolePreview() {
  const rows = [
    { name: "Claude", status: "Ready", active: true },
    { name: "Codex", status: "Synced", active: false },
    { name: "Local browser", status: "Visible", active: false },
  ];

  return (
    <div className="relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#070707] shadow-2xl shadow-black/60 sm:rounded-[2rem]">
      <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-3.5 sm:px-4 sm:py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-300 to-violet-400 text-black shadow-[0_0_28px_rgba(34,211,238,0.28)] sm:h-12 sm:w-12">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <div className="text-base font-semibold sm:text-lg">
              Vlix<span className="text-white/45">·console</span>
            </div>
            <div className="mt-1 text-[9px] uppercase tracking-[0.22em] text-white/[0.38] sm:text-[10px] sm:tracking-[0.28em]">
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

      <div className="grid min-h-[430px] md:min-h-[520px] md:grid-cols-[245px_1fr]">
        <div className="hidden border-r border-white/10 bg-[#0c0c0c] p-4 md:block">
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

        <div className="relative flex min-w-0 flex-col bg-[radial-gradient(circle_at_50%_0%,rgba(34,211,238,0.08),transparent_35%)]">
          <div className="border-b border-white/10 px-4 py-4 sm:px-5 sm:py-5">
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">
              Claude · ready
            </div>
            <div className="mt-2 text-xl font-semibold sm:text-2xl">
              Run the agents already on your Mac.
            </div>
            <div className="mt-1 truncate font-mono text-xs text-white/35 sm:text-sm">
              /users/home/desktop
            </div>
          </div>
          <div className="flex-1 px-4 py-5 sm:px-5 sm:py-6">
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
            <div className="my-5 flex flex-wrap items-center gap-2 text-sm text-white/45 sm:gap-3">
              <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(34,211,238,0.8)]" />
              Working for 18s · reading files · applying patch
              <ArrowRight className="h-4 w-4" />
            </div>
          </div>
          <div className="p-4 sm:p-5">
            <div className="rounded-[1.35rem] border border-white/10 bg-[#1d1d1d] p-3 shadow-[0_0_45px_rgba(34,211,238,0.11)] sm:rounded-[1.6rem]">
              <div className="px-2 py-2 text-sm text-white/35 sm:px-3 sm:text-base">
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

function RemoteRelayRow({
  icon: Icon,
  label,
  text,
}: {
  icon: LucideIcon;
  label: string;
  text: string;
}) {
  return (
    <div className="rounded-[1.35rem] border border-white/10 bg-black/35 p-4">
      <div className="flex items-center gap-3 font-semibold text-white">
        <Icon className="h-4 w-4 text-cyan-200" />
        {label}
      </div>
      <p className="mt-2 text-sm leading-6 text-white/[0.52]">{text}</p>
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
        V
      </div>
      <div>
        <div className="text-lg font-semibold leading-none">Vlix</div>
        <div className="mt-1 text-xs uppercase tracking-[0.22em] text-white/[0.42]">
          Local agents
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
