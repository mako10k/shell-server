/*
 * Issue #13: Streaming Pipeline Reader
 * Read output from running processes in real time and stream into the next process's STDIN
 */

import { Readable } from 'stream';
import { FileManager } from './file-manager.js';
import { RealtimeStreamSubscriber } from './realtime-stream-subscriber.js';

interface StreamingPipelineOptions {
  /** Read timeout (ms) */
  readTimeout?: number;

  /** Buffer size (bytes) */
  bufferSize?: number;

  /** Polling interval (ms) */
  pollingInterval?: number;
}

/**
 * Streaming reader used when input_output_id refers to a running process
 * 1. First read existing file contents
 * 2. After reaching EOF, obtain real-time data from the RealtimeStream
 */
export class StreamingPipelineReader extends Readable {
  private fileManager: FileManager;
  private realtimeSubscriber: RealtimeStreamSubscriber;
  private outputId: string;
  private executionId: string;
  private options: Required<StreamingPipelineOptions>;

  // State management
  private filePosition: number = 0;
  private isFileComplete: boolean = false;
  private lastSequenceNumber: number = -1;
  private readTimer: NodeJS.Timeout | null = null;
  private isDestroyed: boolean = false;

  constructor(
    fileManager: FileManager,
    realtimeSubscriber: RealtimeStreamSubscriber,
    outputId: string,
    executionId: string,
    options: StreamingPipelineOptions = {}
  ) {
    super({ objectMode: false });

    this.fileManager = fileManager;
    this.realtimeSubscriber = realtimeSubscriber;
    this.outputId = outputId;
    this.executionId = executionId;
    this.options = {
      readTimeout: 30000, // 30 seconds
      bufferSize: 8192,
      pollingInterval: 100, // 100ms
      ...options,
    };
  }

  /**
   * Readable stream implementation
   */
  override _read(_size: number): void {
    if (this.isDestroyed) {
      this.push(null);
      return;
    }

    // Skip if a read timer is already running
    if (this.readTimer) {
      return;
    }

    this.startReading();
  }

  /**
   * Start the read processing
   */
  private startReading(): void {
    this.readTimer = setInterval(async () => {
      try {
        await this.performRead();
      } catch (error) {
        console.error(`StreamingPipelineReader: Read error for ${this.outputId}: ${error}`);
        this.destroy(error as Error);
      }
    }, this.options.pollingInterval);

    // Set timeout
    setTimeout(() => {
      if (!this.isDestroyed && this.readTimer) {
        console.error(`StreamingPipelineReader: Read timeout for ${this.outputId}`);
        this.destroy(new Error('Read timeout'));
      }
    }, this.options.readTimeout);
  }

  /**
   * Perform the actual read operation
   */
  private async performRead(): Promise<void> {
    if (!this.isFileComplete) {
      // Phase 1: Read existing data from file
      await this.readFromFile();
    } else {
      // Phase 2: Read data from RealtimeStream
      await this.readFromStream();
    }
  }

  /**
   * Phase 1: Read existing data from file
   */
  private async readFromFile(): Promise<void> {
    try {
      const result = await this.fileManager.readFile(
        this.outputId,
        this.filePosition,
        this.options.bufferSize,
        'utf-8'
      );

      if (result.content && result.content.length > 0) {
        // If data is present, update the read position
        this.filePosition += Buffer.byteLength(result.content, 'utf-8');
        this.push(result.content);
        console.error(
          `StreamingPipelineReader: Read ${result.content.length} chars from file position ${this.filePosition - result.content.length}`
        );
      } else {
        // Reached EOF - check whether the process has ended
        const streamState = this.realtimeSubscriber.getStreamState(this.executionId);
        if (streamState && !streamState.isActive) {
          // If the process has finished, reading is complete
          console.error(
            `StreamingPipelineReader: Process ${this.executionId} completed, file reading finished`
          );
          this.push(null); // EOF
          this.cleanup();
        } else {
          // If the process is still running, switch to stream mode
          console.error(
            `StreamingPipelineReader: File EOF reached, switching to stream mode for ${this.outputId}`
          );
          this.isFileComplete = true;

          // Identify the last sequence number saved to the file
          if (streamState) {
            // Estimate the last saved sequence number from the latest buffers
            const latestBuffers = this.realtimeSubscriber.getLatestBuffers(this.executionId, 10);
            if (latestBuffers.length > 0) {
              // Estimate how far data has been persisted by comparing against file size
              this.lastSequenceNumber = this.estimateLastFileSequence(latestBuffers);
            }
          }
        }
      }
    } catch (error) {
      console.error(`StreamingPipelineReader: File read error: ${error}`);
      throw error;
    }
  }

  /**
   * Phase 2: Read data from RealtimeStream
   */
  private async readFromStream(): Promise<void> {
    const streamState = this.realtimeSubscriber.getStreamState(this.executionId);
    if (!streamState) {
      console.error(`StreamingPipelineReader: Stream state not found for ${this.executionId}`);
      this.push(null);
      this.cleanup();
      return;
    }

    // Fetch buffers after the last read sequence number
    const newBuffers = this.realtimeSubscriber.getBuffersFromSequence(
      this.executionId,
      this.lastSequenceNumber + 1,
      50 // Max 50 buffers at a time
    );

    if (newBuffers.length > 0) {
      for (const buffer of newBuffers) {
        this.push(buffer.data);
        this.lastSequenceNumber = buffer.sequenceNumber;
        console.error(
          `StreamingPipelineReader: Streamed buffer seq=${buffer.sequenceNumber}, ${buffer.data.length} chars`
        );
      }
    }

    // If the process has ended and there are no new buffers, finish
    if (!streamState.isActive && newBuffers.length === 0) {
      console.error(`StreamingPipelineReader: Stream completed for ${this.executionId}`);
      this.push(null); // EOF
      this.cleanup();
    }
  }

  /**
   * Estimate the last sequence number that has been saved to the file
   */
  private estimateLastFileSequence(
    latestBuffers: Array<{ data: string; sequenceNumber: number }>
  ): number {
    // Simple estimate: infer from file size and buffer sizes
    // A more accurate implementation would integrate with FileStorageSubscriber
    let estimatedBytes = 0;
    for (let i = latestBuffers.length - 1; i >= 0; i--) {
      const buffer = latestBuffers[i];
      if (buffer) {
        estimatedBytes += buffer.data.length;
        if (estimatedBytes >= this.filePosition) {
          return Math.max(0, buffer.sequenceNumber - 1);
        }
      }
    }
    return -1;
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.readTimer) {
      clearInterval(this.readTimer);
      this.readTimer = null;
    }
    this.isDestroyed = true;
  }

  /**
   * Stream destroy implementation
   */
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.cleanup();
    console.error(
      `StreamingPipelineReader: Destroyed ${this.outputId}${error ? ` with error: ${error.message}` : ''}`
    );
    callback(error);
  }
}
