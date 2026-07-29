import type {
  EnhanceTaskOptions,
  EnhancerCapabilities,
  ResolvedEnhancerOptions,
  ResolvedTaskOptions,
  TaskError,
  TaskInfo
} from "../api/types.js";

export type MainToWorkerMessage =
  | {
      readonly type: "INIT";
      readonly requestId: string;
      readonly options: ResolvedEnhancerOptions;
    }
  | {
      readonly type: "CREATE_TASK";
      readonly taskId: string;
      readonly source: Blob;
      readonly fileName?: string;
      readonly mimeType?: string;
      readonly options: ResolvedTaskOptions;
      readonly createdAt: number;
    }
  | {
      readonly type: "ABORT_TASK";
      readonly taskId: string;
    }
  | {
      readonly type: "DISPOSE_TASK";
      readonly taskId: string;
    }
  | {
      readonly type: "DISPOSE";
    };

export type WorkerToMainMessage =
  | {
      readonly type: "READY";
      readonly requestId: string;
      readonly capabilities: EnhancerCapabilities;
    }
  | {
      readonly type: "INIT_ERROR";
      readonly requestId: string;
      readonly error: TaskError;
    }
  | {
      readonly type: "STATUS";
      readonly taskId: string;
      readonly task: TaskInfo;
    }
  | {
      readonly type: "RESULT";
      readonly taskId: string;
      readonly result: Blob;
    }
  | {
      readonly type: "ERROR";
      readonly taskId?: string;
      readonly error: TaskError;
    }
  | {
      readonly type: "DISPOSED";
    };

export type PublicTaskOptions = EnhanceTaskOptions;
