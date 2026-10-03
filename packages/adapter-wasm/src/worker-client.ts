import type { RuntimeBoundary, RuntimeEvent, RuntimeWorker } from "./protocol.js";

/** One outstanding input, settled only by the next explicit shim boundary. */
export class RuntimeWorkerClient {
  private boundary: RuntimeBoundary | null = null;
  private pending: { resolve: (boundary: RuntimeBoundary | null) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private failure: Error | null = null;
  private started = false;
  private ended = false;

  constructor(private worker: RuntimeWorker, private onEvent: (event: RuntimeEvent) => void, private timeoutMs = 30_000) {
    worker.addEventListener("message", this.message);
    worker.addEventListener("error", this.error);
  }

  private message = ({ data }: { data: RuntimeEvent }) => {
    if (this.failure || this.ended) return;
    try {
      this.onEvent(data);
      if (data.type === "error") this.fail(new Error(data.message));
      else if (data.type === "input_required") {
        this.boundary = { requestId: data.requestId, prompt: data.prompt };
        this.settle(this.boundary);
      } else if (data.type === "ended") {
        this.ended = true;
        this.boundary = null;
        this.settle(null);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  private error = (event: { message?: string }) => this.fail(new Error(event.message ?? "Worker failed"));

  private settle(boundary: RuntimeBoundary | null) {
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(boundary); }
  }

  private fail(error: Error) {
    this.failure = error;
    this.boundary = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
  }

  private wait(): Promise<RuntimeBoundary | null> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("Runtime input already in flight"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Runtime boundary timeout; do not retry input")), this.timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  async start(name = "NHChat"): Promise<RuntimeBoundary | null> {
    if (this.failure) throw this.failure;
    if (this.started) throw new Error("Worker client already started");
    this.started = true;
    const result = this.wait();
    try { this.worker.postMessage({ type: "start", name }); } catch (error) { this.fail(new Error(String(error))); }
    return result;
  }

  async respond(requestId: string, value: string): Promise<RuntimeBoundary | null> {
    if (this.failure) throw this.failure;
    if (!this.boundary || this.boundary.requestId !== requestId) throw new Error("Stale runtime boundary");
    const result = this.wait();
    this.boundary = null;
    try { this.worker.postMessage({ type: "respond", requestId, value }); } catch (error) { this.fail(new Error(String(error))); }
    return result;
  }

  terminate(): void {
    this.fail(new Error("Worker terminated"));
    this.worker.removeEventListener("message", this.message);
    this.worker.removeEventListener("error", this.error);
    this.worker.terminate();
  }
}
