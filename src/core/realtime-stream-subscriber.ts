/**
 * Issue #13: Real-time streaming feature
 * Subscriber for real-time output delivery
 */

import { StreamSubscriber } from './stream-publisher.js';
import { generateId, getCurrentTimestamp } from '../utils/helpers.js';

interface RealtimeStreamOptions {
  /** Buffer size (bytes) */
  bufferSize?: number;

  /** Notification interval (ms) */
  notificationInterval?: number;

  /** Max retention time (seconds) */
  maxRetentionSeconds?: number;

  /** Max buffers */
  maxBuffers?: number;
}

interface StreamBuffer {
  timestamp: string;
  data: string;
  isStderr: boolean;
  sequenceNumber: number;
}

export interface StreamState {
  executionId: string;
  command: string;
  startTime: string;
  buffers: StreamBuffer[];
  isActive: boolean;
  lastUpdateTime: string;
  totalBytesReceived: number;
  sequenceCounter: number;
}

/**
 * Subscriber for real-time streaming
 * Buffer process output in memory to enable real-time delivery
 */
export class RealtimeStreamSubscriber implements StreamSubscriber {
  public readonly id: string;
  private streams: Map<string, StreamState> = new Map();
  private options: Required<RealtimeStreamOptions>;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options: RealtimeStreamOptions = {}) {
    this.id = `realtime-stream-${generateId()}`;
    this.options = {
      bufferSize: 8192,
      notificationInterval: 100,
      maxRetentionSeconds: 3600, // 1 hour
      maxBuffers: 1000,
      ...options,
    };

    // Start periodic cleanup
    this.startCleanupTimer();
  }

  async onProcessStart(executionId: string, command: string): Promise<void> {
    const streamState: StreamState = {
      executionId,
      command,
      startTime: getCurrentTimestamp(),
      buffers: [],
      isActive: true,
      lastUpdateTime: getCurrentTimestamp(),
      totalBytesReceived: 0,
      sequenceCounter: 0,
    };

    this.streams.set(executionId, streamState);
    console.error(`RealtimeStreamSubscriber: Started streaming for ${executionId}`);
  }

  async onOutputData(executionId: string, data: string, isStderr: boolean = false): Promise<void> {
    const streamState = this.streams.get(executionId);
    if (!streamState) {
      console.error(`RealtimeStreamSubscriber: No stream state found for ${executionId}`);
      return;
    }

    // Create buffer
    const buffer: StreamBuffer = {
      timestamp: getCurrentTimestamp(),
      data,
      isStderr,
      sequenceNumber: streamState.sequenceCounter++,
    };

    // Append buffer (size limit check)
    streamState.buffers.push(buffer);
    streamState.totalBytesReceived += data.length;
    streamState.lastUpdateTime = getCurrentTimestamp();

    // Check buffer count limit
    if (streamState.buffers.length > this.options.maxBuffers) {
      // Remove old buffers
      const removed = streamState.buffers.splice(
        0,
        streamState.buffers.length - this.options.maxBuffers
      );
      console.error(
        `RealtimeStreamSubscriber: Removed ${removed.length} old buffers for ${executionId}`
      );
    }
  }

  async onProcessEnd(executionId: string, exitCode: number | null): Promise<void> {
    const streamState = this.streams.get(executionId);
    if (streamState) {
      streamState.isActive = false;
      streamState.lastUpdateTime = getCurrentTimestamp();
      console.error(`RealtimeStreamSubscriber: Process ${executionId} ended with code ${exitCode}`);
    }
  }

  async onError(executionId: string, error: Error): Promise<void> {
    const streamState = this.streams.get(executionId);
    if (streamState) {
      streamState.isActive = false;
      streamState.lastUpdateTime = getCurrentTimestamp();

      // Append error info to buffer
      const errorBuffer: StreamBuffer = {
        timestamp: getCurrentTimestamp(),
        data: `\n[ERROR] ${error.message}\n`,
        isStderr: true,
        sequenceNumber: streamState.sequenceCounter++,
      };

      streamState.buffers.push(errorBuffer);
      console.error(`RealtimeStreamSubscriber: Error in process ${executionId}: ${error.message}`);
    }
  }

  /**
   * Get stream state for the specified execution
   */
  getStreamState(executionId: string): StreamState | undefined {
    return this.streams.get(executionId);
  }

  /**
   * Get latest buffers for the specified execution
   */
  getLatestBuffers(executionId: string, count: number = 10): StreamBuffer[] {
    const streamState = this.streams.get(executionId);
    if (!streamState) {
      return [];
    }

    return streamState.buffers.slice(-count);
  }

  /**
   * Get buffers from the specified sequence for the execution
   */
  getBuffersFromSequence(
    executionId: string,
    fromSequence: number,
    maxCount: number = 100
  ): StreamBuffer[] {
    const streamState = this.streams.get(executionId);
    if (!streamState) {
      return [];
    }

    const buffers = streamState.buffers.filter((buffer) => buffer.sequenceNumber >= fromSequence);
    return buffers.slice(0, maxCount);
  }

  /**
   * Get list of active streams
   */
  getActiveStreams(): string[] {
    return Array.from(this.streams.entries())
      .filter(([_, state]) => state.isActive)
      .map(([executionId]) => executionId);
  }

  /**
   * Get all streams list
   */
  getAllStreams(): string[] {
    return Array.from(this.streams.keys());
  }

  /**
   * Remove specified stream
   */
  removeStream(executionId: string): boolean {
    return this.streams.delete(executionId);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalStreams: number;
    activeStreams: number;
    totalBuffers: number;
    totalBytesReceived: number;
  } {
    let totalBuffers = 0;
    let totalBytesReceived = 0;
    let activeStreams = 0;

    for (const state of this.streams.values()) {
      totalBuffers += state.buffers.length;
      totalBytesReceived += state.totalBytesReceived;
      if (state.isActive) {
        activeStreams++;
      }
    }

    return {
      totalStreams: this.streams.size,
      activeStreams,
      totalBuffers,
      totalBytesReceived,
    };
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanup();
      },
      5 * 60 * 1000
    );
  }

  /**
   * Clean up old streams
   */
  private cleanup(): void {
    const now = Date.now();
    const maxRetentionMs = this.options.maxRetentionSeconds * 1000;
    const toRemove: string[] = [];

    for (const [executionId, state] of this.streams.entries()) {
      const lastUpdateTime = new Date(state.lastUpdateTime).getTime();

      // Mark for removal if inactive and retention exceeded
      if (!state.isActive && now - lastUpdateTime > maxRetentionMs) {
        toRemove.push(executionId);
      }
    }

    for (const executionId of toRemove) {
      this.streams.delete(executionId);
      console.error(`RealtimeStreamSubscriber: Cleaned up old stream ${executionId}`);
    }

    if (toRemove.length > 0) {
      console.error(
        `RealtimeStreamSubscriber: Cleanup completed, removed ${toRemove.length} streams`
      );
    }
  }

  /**
   * リソースをクリーンアップして終了
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.streams.clear();
    console.error(`RealtimeStreamSubscriber: Subscriber ${this.id} destroyed`);
  }
}
