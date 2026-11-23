// The health endpoint. The bot is a socket-mode worker with no port of its own;
// when HTTP_PORT is set it opens one, for a Kubernetes livenessProbe: is the
// scheduler still ticking? Nothing else is served, and no state is exposed
// beyond when the last tick finished.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TickReport } from "./scheduler.ts";

/** Older than this and the scheduler is not ticking: 503, and the probe restarts us. */
export const TICK_FRESH_MS = 5 * 60_000;

export class Health {
  #now: () => Date;
  #server: Server;
  #lastTickAt: string | null = null;
  #listening = false;

  constructor(now: () => Date) {
    this.#now = now;
    this.#server = createServer((req, res) => this.#handle(req, res));
  }

  /** A finished scheduler tick. Every tick reports, whether it ran a slot or not. */
  record(report: TickReport): void {
    this.#lastTickAt = report.at.toISOString();
  }

  /** Binds the port and resolves the one actually bound (0 becomes ephemeral). */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#server.once("error", onError);
      this.#server.listen(port, () => {
        this.#server.off("error", onError);
        this.#listening = true;
        const address = this.#server.address();
        resolve(address !== null && typeof address === "object" ? address.port : port);
      });
    });
  }

  close(): Promise<void> {
    if (!this.#listening) return Promise.resolve();
    this.#listening = false;
    return new Promise((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET" || path !== "/healthz") {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }
    const ok = this.#ticking();
    send(res, ok ? 200 : 503, { ok, lastTickAt: this.#lastTickAt });
  }

  #ticking(): boolean {
    if (this.#lastTickAt === null) return false;
    return this.#now().getTime() - Date.parse(this.#lastTickAt) < TICK_FRESH_MS;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
