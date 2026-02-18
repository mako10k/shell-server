/**
 * Issue #13: Real-time streaming feature
 * Phase 1: StreamPublisher + Subscriber pattern implementation
 */

export interface StreamSubscriber {
  /** Subscriber ID */
  id: string;

  /** Called when a process starts */
  onProcessStart?(executionId: string, command: string): void | Promise<void>;

  /** Called when new output data arrives */
  onOutputData(executionId: string, data: string, isStderr: boolean): void | Promise<void>;

  /** Called when a process ends */
  onProcessEnd?(executionId: string, exitCode: number | null): void | Promise<void>;

  /** Called when an error occurs */
  onError?(executionId: string, error: Error): void | Promise<void>;
}

interface StreamPublisherOptions {
  /** Whether to enable real-time notifications */
  enableRealtimeStreaming?: boolean;

  /** Buffer size in bytes */
  bufferSize?: number;

  /** Notification interval in milliseconds */
  notificationInterval?: number;
}

/**
 * Class that manages PUB/SUB for process output
 */
export class StreamPublisher {
  private subscribers: Map<string, StreamSubscriber> = new Map();
  private executionSubscribers: Map<string, Set<string>> = new Map(); // execution -> subscriber IDs

  constructor(private options: StreamPublisherOptions = {}) {
    this.options = {
      enableRealtimeStreaming: false,
      bufferSize: 8192,
      notificationInterval: 100,
      ...options,
    };
  }

  /**
   * Register a subscriber
   */
  subscribe(subscriber: StreamSubscriber): void {
    this.subscribers.set(subscriber.id, subscriber);
  }

  /**
   * Remove a subscriber
   */
  unsubscribe(subscriberId: string): void {
    this.subscribers.delete(subscriberId);
    // Remove this subscriber from all executions
    for (const [executionId, subscriberIds] of this.executionSubscribers.entries()) {
      subscriberIds.delete(subscriberId);
      if (subscriberIds.size === 0) {
        this.executionSubscribers.delete(executionId);
      }
    }
  }

  /**
    * Add a subscriber to a specific execution
   */
  subscribeToExecution(executionId: string, subscriberId: string): void {
    if (!this.subscribers.has(subscriberId)) {
      throw new Error(`Subscriber ${subscriberId} not found`);
    }

    if (!this.executionSubscribers.has(executionId)) {
      this.executionSubscribers.set(executionId, new Set());
    }

    const subscriberSet = this.executionSubscribers.get(executionId);
    if (subscriberSet) {
      subscriberSet.add(subscriberId);
    }
  }

  /**
    * Common helper for sending notifications to subscribers
   */
  private async notifySubscribers<T extends unknown[]>(
    executionId: string,
    callback: (
      subscriber: StreamSubscriber,
      subscriberId: string,
      ...args: T
    ) => Promise<void> | void,
    ...args: T
  ): Promise<void> {
    const subscriberIds = this.executionSubscribers.get(executionId);
    if (!subscriberIds) return;

    const notifications = Array.from(subscriberIds).map(async (subscriberId) => {
      const subscriber = this.subscribers.get(subscriberId);
      if (subscriber) {
        try {
          await callback(subscriber, subscriberId, ...args);
        } catch (error) {
          console.error(`StreamPublisher: Error notifying subscriber ${subscriberId}:`, error);
        }
      }
    });

    await Promise.allSettled(notifications);
  }

  /**
    * Notify process start
   */
  async notifyProcessStart(executionId: string, command: string): Promise<void> {
    await this.notifySubscribers(
      executionId,
      (subscriber, _, executionId, command) => {
        if (subscriber.onProcessStart) {
          return subscriber.onProcessStart(executionId, command);
        }
      },
      executionId,
      command
    );
  }

  /**
    * Notify output data
   */
  async notifyOutputData(
    executionId: string,
    data: string,
    isStderr: boolean = false
  ): Promise<void> {
    await this.notifySubscribers(
      executionId,
      (subscriber, _, executionId, data, isStderr) =>
        subscriber.onOutputData(executionId, data, isStderr),
      executionId,
      data,
      isStderr
    );
  }

  /**
    * Notify process end
   */
  async notifyProcessEnd(executionId: string, exitCode: number | null): Promise<void> {
    await this.notifySubscribers(
      executionId,
      (subscriber, _, executionId, exitCode) => {
        if (subscriber.onProcessEnd) {
          return subscriber.onProcessEnd(executionId, exitCode);
        }
      },
      executionId,
      exitCode
    );

    // Clean up subscription data after execution completes
    this.executionSubscribers.delete(executionId);
  }

  /**
   * Notify errors
   */
  async notifyError(executionId: string, error: Error): Promise<void> {
    await this.notifySubscribers(
      executionId,
      (subscriber, _, executionId, error) => {
        if (subscriber.onError) {
          return subscriber.onError(executionId, error);
        }
      },
      executionId,
      error
    );
  }

  /**
   * Whether real-time streaming is enabled
   */
  isRealtimeStreamingEnabled(): boolean {
    return this.options.enableRealtimeStreaming === true;
  }

  /**
   * Check whether subscribers are registered for a specific execution
   */
  hasSubscribers(executionId: string): boolean {
    const subscriberIds = this.executionSubscribers.get(executionId);
    return Boolean(subscriberIds && subscriberIds.size > 0);
  }
}
