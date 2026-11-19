import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configDir } from "./paths.ts";

/** The local T3 server's origin, from its runtime file. */
export function t3Origin(): string {
  if (process.env.PUCK_T3_URL) return process.env.PUCK_T3_URL;
  try {
    const runtime = JSON.parse(readFileSync(join(homedir(), ".t3/userdata/server-runtime.json"), "utf8")) as unknown;
    return z.object({ origin: z.string() }).parse(runtime).origin;
  } catch {
    return "http://127.0.0.1:3773";
  }
}

export const tokenPath = () => join(configDir(), "t3-token");

function readToken(): string {
  try {
    return readFileSync(tokenPath(), "utf8").trim();
  } catch {
    throw new Error(
      `No T3 token at ${tokenPath()}. Create one with: t3 auth session issue --scope orchestration:read --scope diagnostics:read --ttl 365d --label puck --token-only`,
    );
  }
}

const UsageSummary = z.object({
  buckets: z.array(z.object({ day: z.string(), provider: z.string(), model: z.string(), costUsd: z.number() })),
});

const RpcExit = z.object({
  _tag: z.literal("Exit"),
  exit: z.object({ _tag: z.string(), value: z.unknown().optional(), cause: z.unknown().optional() }),
});

/** Effect RPC over T3's WebSocket: one request, resolved by its Exit message. */
async function rpc(tag: string, payload: unknown): Promise<unknown> {
  const origin = t3Origin();
  const ticketRes = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readToken()}`, "x-t3-orchestration-protocol": "2" },
  });
  if (!ticketRes.ok) throw new Error(`T3 refused the token (${ticketRes.status}).`);
  const { ticket } = z.object({ ticket: z.string() }).parse(await ticketRes.json());

  const ws = new WebSocket(
    `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`,
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`T3 did not answer ${tag} within 30 s.`));
    }, 30_000);
    ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Could not reach T3 at ${origin}.`));
    };
    ws.onmessage = (event) => {
      const parsed = RpcExit.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) return; // pings and other frames
      const message = parsed.data;
      clearTimeout(timer);
      ws.close();
      if (message.exit._tag === "Success") resolve(message.exit.value);
      else reject(new Error(`T3 ${tag} failed: ${JSON.stringify(message.exit.cause)}`));
    };
  });
}

/** Today's agent spend in USD, in the local time zone, as T3's usage page computes it. */
export async function spendToday(): Promise<{ day: string; usd: number }> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = new Date().toLocaleDateString("en-CA", { timeZone });
  const summary = UsageSummary.parse(
    await rpc("server.getUsageSummary", { sinceDay: day, untilDay: day, timeZone, provisional: true }),
  );
  const usd = summary.buckets.reduce((sum, b) => sum + b.costUsd, 0);
  return { day, usd: Math.round(usd * 100) / 100 };
}
