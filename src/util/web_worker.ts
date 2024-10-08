import WorkerClass from './worker_class';

import type {Class} from '../types/class';
import type {WorkerSource} from '../source/worker_source';

type MessageListener = (
    arg1: {
        data: any;
    },
) => unknown;

// The main thread interface. Provided by Worker in a browser environment,
// and MessageBus below in a node environment.
export interface WorkerInterface {
    addEventListener: (type: 'message', listener: MessageListener) => void;
    removeEventListener: (type: 'message', listener: MessageListener) => void;
    postMessage: (message?: any) => void;
    terminate: () => void;
}

export interface WorkerGlobalScopeInterface {
    importScripts: (...urls: Array<string>) => void;
    registerWorkerSource?: (arg1: string, arg2: Class<WorkerSource>) => void;
    registerRTLTextPlugin?: (_?: any) => void;
}

export function createWorker(): Worker {
    // eslint-disable-next-line new-cap
    return WorkerClass.workerClass != null ? new WorkerClass.workerClass() : new self.Worker(WorkerClass.workerUrl, WorkerClass.workerParams);
}
