/**
 * Issue #13: FileManager Subscriber implementation
 * Extend existing FileManager with a StreamSubscriber pattern
 */

import { StreamSubscriber } from './stream-publisher.js';
import { FileManager } from './file-manager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { generateId, getCurrentTimestamp } from '../utils/helpers.js';

/**
 * Subscriber wrapper for FileManager
 * Subscriber that saves process output to files
 */
export class FileStorageSubscriber implements StreamSubscriber {
  public readonly id: string;
  private fileStreams: Map<string, fs.FileHandle> = new Map();
  private filePaths: Map<string, { stdout: string; stderr: string }> = new Map();

  constructor(
    private fileManager: FileManager,
    private baseDir: string = '/tmp/mcp-shell-outputs'
  ) {
    this.id = `file-storage-${generateId()}`;
  }

  async onProcessStart(executionId: string, _command: string): Promise<void> {
    // Prepare output file paths
    const timestamp = getCurrentTimestamp().replace(/[:.]/g, '-');
    const stdoutPath = path.join(this.baseDir, `${executionId}-stdout-${timestamp}.txt`);
    const stderrPath = path.join(this.baseDir, `${executionId}-stderr-${timestamp}.txt`);

    this.filePaths.set(executionId, {
      stdout: stdoutPath,
      stderr: stderrPath,
    });

    // Open file handles for writing
    try {
      const stdoutHandle = await fs.open(stdoutPath, 'w');
      const stderrHandle = await fs.open(stderrPath, 'w');

      this.fileStreams.set(`${executionId}-stdout`, stdoutHandle);
      this.fileStreams.set(`${executionId}-stderr`, stderrHandle);

      // Register with FileManager (initially zero size)
      await this.fileManager.registerFile(stdoutPath, 'stdout', executionId);
      await this.fileManager.registerFile(stderrPath, 'stderr', executionId);
    } catch (error) {
      console.error(
        `FileStorageSubscriber: Failed to create output files for ${executionId}:`,
        error
      );
      throw error;
    }
  }

  async onOutputData(executionId: string, data: string, isStderr: boolean = false): Promise<void> {
    const streamKey = `${executionId}-${isStderr ? 'stderr' : 'stdout'}`;
    const fileHandle = this.fileStreams.get(streamKey);

    if (fileHandle) {
      try {
        await fileHandle.write(data);
          // Flush immediately so other processes can read
        await fileHandle.sync();
      } catch (error) {
        console.error(`FileStorageSubscriber: Failed to write data for ${executionId}:`, error);
      }
    }
  }

  async onProcessEnd(executionId: string, _exitCode: number | null): Promise<void> {
    // Close file handles
    const stdoutHandle = this.fileStreams.get(`${executionId}-stdout`);
    const stderrHandle = this.fileStreams.get(`${executionId}-stderr`);

    try {
      if (stdoutHandle) {
        await stdoutHandle.close();
        this.fileStreams.delete(`${executionId}-stdout`);
      }

      if (stderrHandle) {
        await stderrHandle.close();
        this.fileStreams.delete(`${executionId}-stderr`);
      }

      // Update FileManager info (final file sizes, etc.)
      const filePaths = this.filePaths.get(executionId);
      if (filePaths) {
        await this.updateFileManagerInfo(executionId, filePaths);
        this.filePaths.delete(executionId);
      }
    } catch (error) {
      console.error(`FileStorageSubscriber: Error closing files for ${executionId}:`, error);
    }
  }

  async onError(executionId: string, error: Error): Promise<void> {
    // Ensure files are properly closed on error
    await this.onProcessEnd(executionId, -1);

    // Write error log to the stderr file
    const filePaths = this.filePaths.get(executionId);
    if (filePaths) {
      try {
        const errorMessage = `\n[ERROR] Process failed: ${error.message}\n`;
        await fs.appendFile(filePaths.stderr, errorMessage);
      } catch (writeError) {
        console.error(`FileStorageSubscriber: Failed to write error to stderr file:`, writeError);
      }
    }
  }

  /**
   * Update FileManager info with final file sizes
   */
  private async updateFileManagerInfo(
    executionId: string,
    filePaths: { stdout: string; stderr: string }
  ): Promise<void> {
    try {
      // Obtain file sizes and update FileManager
      // This part depends on FileManager internals;
      // may need to add an updateFileSize method to FileManager.

      // Currently only logs via console.error
      const stdoutStat = await fs.stat(filePaths.stdout);
      const stderrStat = await fs.stat(filePaths.stderr);

      console.error(`FileStorageSubscriber: Files updated for ${executionId}:`);
      console.error(`  stdout: ${filePaths.stdout} (${stdoutStat.size} bytes)`);
      console.error(`  stderr: ${filePaths.stderr} (${stderrStat.size} bytes)`);
    } catch (error) {
      console.error(`FileStorageSubscriber: Failed to update file info for ${executionId}:`, error);
    }
  }

  /**
   * Get output file paths for the specified execution
   */
  getFilePaths(executionId: string): { stdout: string; stderr: string } | undefined {
    return this.filePaths.get(executionId);
  }

  /**
   * Get active file stream count (for debugging)
   */
  getActiveStreamsCount(): number {
    return this.fileStreams.size;
  }
}
