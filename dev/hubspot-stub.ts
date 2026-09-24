import http from "node:http";
import { verifyEventSignature } from "../src/lib/crypto.js";

/**
 * LOCAL STUB standing in for the HubSpot destination. It is NOT HubSpot. It receives the signed contract
 * envelopes (docs/04-event-contracts.md), verifies the signature, stores each event once by id
 * (idempotent effect), and can inject faults for retry and dead-letter tests. The real HubSpot mapping waits on DEC-08.
 */
export interface StubEvent {
  id: string;
  type: string;
  receivedAt: string;
  deliveries: number;
  envelope: Record<string, unknown>;
}

export interface HubSpotStub {
  url: string;
  events: Map<string, StubEvent>;
  rejectedSignatures: number;
  /** The next `count` requests fail with `status`. */
  failNext(count: number, status: number): void;
  close(): Promise<void>;
}

export async function startHubSpotStub(opts: { port: number; host?: string; secret: string }): Promise<HubSpotStub> {
  const events = new Map<string, StubEvent>();
  let failures: { count: number; status: number } = { count: 0, status: 500 };
  const state = { rejectedSignatures: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify([...events.values()]));
      }
      if (req.method === "POST" && url.pathname === "/_control/fail") {
        failures = { count: Number(url.searchParams.get("count") ?? 1), status: Number(url.searchParams.get("status") ?? 500) };
        return res.writeHead(204).end();
      }
      if (req.method !== "POST" || url.pathname !== "/events") return res.writeHead(404).end();
      if (failures.count > 0) {
        failures.count--;
        res.writeHead(failures.status, { "content-type": "text/plain" });
        return res.end("injected failure");
      }
      const sig = req.headers["tcgi-signature"];
      if (!verifyEventSignature(opts.secret, typeof sig === "string" ? sig : undefined, body)) {
        state.rejectedSignatures++;
        return res.writeHead(401).end("bad signature");
      }
      const env = JSON.parse(body) as Record<string, unknown>;
      const id = String(env.id);
      const prior = events.get(id);
      if (prior) prior.deliveries++;
      else events.set(id, { id, type: String(env.type), receivedAt: new Date().toISOString(), deliveries: 1, envelope: env });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: id, duplicate: !!prior }));
    });
  });
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://${host}:${port}/events`,
    events,
    get rejectedSignatures() {
      return state.rejectedSignatures;
    },
    failNext(count, status) {
      failures = { count, status };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
