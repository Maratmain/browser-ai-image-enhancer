import { EnhancerError, taskErrorToException } from "../utils/errors.js";
export class WorkerBridge {
    #worker;
    #initWaiters = new Map();
    #listeners = new Set();
    #disposed = false;
    constructor(workerUrl) {
        this.#worker = new Worker(workerUrl, { type: "module", name: "image-enhancer-worker" });
        this.#worker.addEventListener("message", (event) => {
            this.#handleMessage(event.data);
        });
        this.#worker.addEventListener("error", (event) => {
            const error = new EnhancerError("INTERNAL_ERROR", event.message || "Image worker crashed");
            for (const waiter of this.#initWaiters.values()) {
                waiter.reject(error);
            }
            this.#initWaiters.clear();
            const taskError = error.toTaskError();
            this.#emit({ type: "ERROR", error: taskError });
        });
    }
    addListener(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    initialize(message) {
        if (this.#disposed) {
            return Promise.reject(new EnhancerError("DISPOSED", "Worker bridge is disposed"));
        }
        return new Promise((resolve, reject) => {
            this.#initWaiters.set(message.requestId, { resolve, reject });
            this.#worker.postMessage(message);
        });
    }
    post(message) {
        if (this.#disposed) {
            throw new EnhancerError("DISPOSED", "Worker bridge is disposed");
        }
        this.#worker.postMessage(message);
    }
    terminate() {
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
    #handleMessage(message) {
        if (message.type === "READY") {
            const waiter = this.#initWaiters.get(message.requestId);
            if (waiter !== undefined) {
                this.#initWaiters.delete(message.requestId);
                waiter.resolve(message.capabilities);
            }
        }
        else if (message.type === "INIT_ERROR") {
            const waiter = this.#initWaiters.get(message.requestId);
            if (waiter !== undefined) {
                this.#initWaiters.delete(message.requestId);
                waiter.reject(taskErrorToException(message.error));
            }
        }
        this.#emit(message);
    }
    #emit(message) {
        for (const listener of this.#listeners) {
            listener(message);
        }
    }
}
