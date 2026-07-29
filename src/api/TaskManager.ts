import type { TaskInfo } from "./types.js";
import { TERMINAL_STATUSES } from "./types.js";
import { EnhancerError, taskErrorToException } from "../utils/errors.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

interface TaskRecord {
  info: TaskInfo;
  readonly result: Deferred<Blob>;
  readonly terminal: Deferred<TaskInfo>;
  settledResult: boolean;
  settledTerminal: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(info: TaskInfo): TaskInfo {
  return structuredClone(info);
}

export class TaskManager {
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #resultRetentionMs: number;
  readonly #onExpire: (taskId: string) => void;

  constructor(resultRetentionMs: number, onExpire: (taskId: string) => void) {
    this.#resultRetentionMs = resultRetentionMs;
    this.#onExpire = onExpire;
  }

  create(info: TaskInfo): void {
    if (this.#tasks.has(info.taskId)) {
      throw new EnhancerError("INTERNAL_ERROR", "Duplicate task identifier");
    }
    const result = deferred<Blob>();
    const terminal = deferred<TaskInfo>();
    void result.promise.catch(() => undefined);
    void terminal.promise.catch(() => undefined);
    this.#tasks.set(info.taskId, {
      info: snapshot(info),
      result,
      terminal,
      settledResult: false,
      settledTerminal: false
    });
  }

  has(taskId: string): boolean {
    return this.#tasks.has(taskId);
  }

  countActive(): number {
    let count = 0;
    for (const record of this.#tasks.values()) {
      if (!TERMINAL_STATUSES.has(record.info.status)) {
        count += 1;
      }
    }
    return count;
  }

  get(taskId: string): TaskInfo {
    const record = this.#require(taskId);
    return snapshot(record.info);
  }

  update(info: TaskInfo): TaskInfo {
    const record = this.#require(info.taskId);
    if (info.progress + Number.EPSILON < record.info.progress) {
      throw new EnhancerError("INTERNAL_ERROR", "Task progress cannot decrease", {
        details: { previous: record.info.progress, next: info.progress }
      });
    }
    record.info = snapshot(info);

    if (TERMINAL_STATUSES.has(info.status) && !record.settledTerminal) {
      record.settledTerminal = true;
      record.terminal.resolve(snapshot(info));
    }

    if (info.status === "failed" && !record.settledResult) {
      record.settledResult = true;
      record.result.reject(
        info.error === undefined
          ? new EnhancerError("INTERNAL_ERROR", "Task failed without an error")
          : taskErrorToException(info.error)
      );
    } else if (info.status === "cancelled" && !record.settledResult) {
      record.settledResult = true;
      record.result.reject(new EnhancerError("TASK_CANCELLED", "Task was cancelled"));
    }

    return snapshot(record.info);
  }

  setResult(taskId: string, result: Blob): void {
    const record = this.#require(taskId);
    if (record.info.status !== "completed") {
      throw new EnhancerError("TASK_NOT_COMPLETED", "Result arrived before task completion");
    }
    if (!record.settledResult) {
      record.settledResult = true;
      record.result.resolve(result);
    }
    if (this.#resultRetentionMs > 0 && record.expiryTimer === undefined) {
      record.expiryTimer = setTimeout(() => {
        this.#onExpire(taskId);
      }, this.#resultRetentionMs);
    }
  }

  async getResult(taskId: string): Promise<Blob> {
    return this.#require(taskId).result.promise;
  }

  async waitForTerminal(taskId: string): Promise<TaskInfo> {
    const record = this.#require(taskId);
    if (TERMINAL_STATUSES.has(record.info.status)) {
      return snapshot(record.info);
    }
    return record.terminal.promise;
  }

  remove(taskId: string, expired = false): void {
    const record = this.#tasks.get(taskId);
    if (record === undefined) {
      if (expired) {
        return;
      }
      throw new EnhancerError("TASK_NOT_FOUND", "Task does not exist", {
        recoverable: true,
        details: { taskId }
      });
    }
    if (record.expiryTimer !== undefined) {
      clearTimeout(record.expiryTimer);
    }
    if (!record.settledResult) {
      record.settledResult = true;
      record.result.reject(
        new EnhancerError(expired ? "TASK_EXPIRED" : "TASK_NOT_FOUND", expired ? "Task result expired" : "Task was disposed")
      );
    }
    if (!record.settledTerminal) {
      record.settledTerminal = true;
      record.terminal.reject(new EnhancerError("TASK_NOT_FOUND", "Task was disposed"));
    }
    this.#tasks.delete(taskId);
  }

  clear(): void {
    for (const taskId of [...this.#tasks.keys()]) {
      this.remove(taskId);
    }
  }

  #require(taskId: string): TaskRecord {
    const record = this.#tasks.get(taskId);
    if (record === undefined) {
      throw new EnhancerError("TASK_NOT_FOUND", "Task does not exist or its result expired", {
        recoverable: true,
        details: { taskId }
      });
    }
    return record;
  }
}
