import type { EnhancerCapabilities, TaskError } from "../api/types.js";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./protocol.js";
import { EnhancerError, taskErrorToException } from "../utils/errors.js";

interface InitWaiter {
  readonly resolve: (value: EnhancerCapabilities) => void;
  readonly reject: (reason: unknown) => void;
}

export class WorkerBridge {
  readonly #worker: Worker;
  readonly #initWaiters = new Map<string, InitWaiter>();
  readonly #listeners = new Set<(message: WorkerToMainMessage) => void>();
  #disposed = false;

  constructor(workerUrl: URL) {
    this.#worker = new Worker(workerUrl, { type: "module", name: "image-enhancer-worker" });
    this.#worker.addEventListener("message", (event: MessageEvent<WorkerToMainMessage>) => {
      this.#handleMessage(event.data);
    });
    this.#worker.addEventListener("error", (event) => {
      const error = new EnhancerError("INTERNAL_ERROR", event.message || "Image worker crashed");
      for (const waiter of this.#initWaiters.values()) {
        waiter.reject(error);
      }
      this.#initWaiters.clear();
      const taskError: TaskError = error.toTaskError();
      this.#emit({ type: "ERROR", error: taskError });
    });
  }

  addListener(listener: (message: WorkerToMainMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  initialize(message: Extract<MainToWorkerMessage, { type: "INIT" }>): Promise<EnhancerCapabilities> {
    if (this.#disposed) {
      return Promise.reject(new EnhancerError("DISPOSED", "Worker bridge is disposed"));
    }
    return new Promise<EnhancerCapabilities>((resolve, reject) => {
      this.#initWaiters.set(message.requestId, { resolve, reject });
      this.#worker.postMessage(message);
    });
  }

  post(message: MainToWorkerMessage): void {
    if (this.#disposed) {
      throw new EnhancerError("DISPOSED", "Worker bridge is disposed");
    }
    this.#worker.postMessage(message);
  }

  terminate(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#worker.terminate();
    const error = new EnhancerError("DISPOSED", "Worker bridge was terminated");
    for (const waiter of this.#initWaiters.values()) {
      waiter.reject(error);
    }
    this.#initWaiters.clear();
    this.#listeners.clear();
  }

  #handleMessage(message: WorkerToMainMessage): void {
    if (message.type === "READY") {
      const waiter = this.#initWaiters.get(message.requestId);
      if (waiter !== undefined) {
        this.#initWaiters.delete(message.requestId);
        waiter.resolve(message.capabilities);
      }
    } else if (message.type === "INIT_ERROR") {
      const waiter = this.#initWaiters.get(message.requestId);
      if (waiter !== undefined) {
        this.#initWaiters.delete(message.requestId);
        waiter.reject(taskErrorToException(message.error));
      }
    }
    this.#emit(message);
  }

  #emit(message: WorkerToMainMessage): void {
    for (const listener of this.#listeners) {
      listener(message);
    }
  }
}
