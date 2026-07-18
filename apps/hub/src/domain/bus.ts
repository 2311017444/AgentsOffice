import { EventEmitter } from "node:events";

export interface BusEvent {
  type: string;
  payload?: unknown;
}

/** 进程内事件总线：领域层发布，SSE 层订阅推送到网页 */
export class OfficeBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(event: BusEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(handler: (event: BusEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }
}
