import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    supabase
      .from("counter")
      .select("value")
      .eq("id", 1)
      .single()
      .then(({ data }) => setCount(data?.value ?? 0));
  }, []);

  const increment = async () => {
    if (count === null) return;
    const next = count + 1;
    setCount(next);
    await supabase.from("counter").update({ value: next }).eq("id", 1);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background">
      <h1 className="text-4xl font-bold">Shared Counter</h1>
      <p className="text-6xl font-mono">{count ?? "…"}</p>
      <Button onClick={increment} size="lg">Increment</Button>
    </main>
  );
}
