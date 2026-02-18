import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ExecutionInfo,
  ExecutionProcessInfo,
  ExecutionMode,
  ExecutionStatus,
  ProcessSignal,
  EnvironmentVariables,
  OutputTruncationReason,
} from '../types/index.js';
import {
  generateId,
  getCurrentTimestamp,
  getSafeEnvironment,
  sanitizeString,
  ensureDirectory,
} from '../utils/helpers.js';
import {
  ExecutionError,
  TimeoutError,
  ResourceNotFoundError,
  ResourceLimitError,
} from '../utils/errors.js';
import type { TerminalManager, TerminalOptions } from './terminal-manager.js';
import type { FileManager } from './file-manager.js';
import { StreamPublisher } from './stream-publisher.js';
import { FileStorageSubscriber } from './file-storage-subscriber.js';
import { StreamingPipelineReader } from './streaming-pipeline-reader.js';
import { RealtimeStreamSubscriber } from './realtime-stream-subscriber.js';

export interface ExecutionOptions {
  command: string;
  executionMode: ExecutionMode;
  workingDirectory?: string;
  environmentVariables?: EnvironmentVariables;
  inputData?: string;
  inputOutputId?: string;
  timeoutSeconds: number;
  foregroundTimeoutSeconds?: number;
  maxOutputSize: number;
  captureStderr: boolean;
  sessionId?: string;
  createTerminal?: boolean;
  terminalShell?: string;
  terminalDimensions?: { width: number; height: number };
  returnPartialOnTimeout?: boolean;
}

// Callback type for background process completion
interface BackgroundProcessCallback {
  onComplete?: (executionId: string, executionInfo: ExecutionInfo) => void | Promise<void>;
  onError?: (
    executionId: string,
    executionInfo: ExecutionInfo,
    error: unknown
  ) => void | Promise<void>;
  onTimeout?: (executionId: string, executionInfo: ExecutionInfo) => void | Promise<void>;
}

export class ProcessManager {
  private executions = new Map<string, ExecutionInfo>();
  private processes = new Map<number, ChildProcess>();
  private readonly maxConcurrentProcesses: number;
  private readonly outputDir: string;
  private terminalManager?: TerminalManager; // Reference to TerminalManager
  private fileManager: FileManager | undefined; // Reference to FileManager
  private defaultWorkingDirectory: string;
  private allowedWorkingDirectories: string[];
  private backgroundProcessCallbacks: BackgroundProcessCallback = {}; // Background process completion callbacks

  // Issue #13: PUB/SUB integration - phased rollout with feature flag
  private streamPublisher: StreamPublisher;
  private fileStorageSubscriber: FileStorageSubscriber | undefined;
  private realtimeStreamSubscriber: RealtimeStreamSubscriber | undefined;
  private enableStreaming: boolean = false; // Feature Flag

  constructor(
    maxConcurrentProcesses = 50,
    outputDir = '/tmp/mcp-shell-outputs',
    fileManager?: FileManager
  ) {
    this.maxConcurrentProcesses = maxConcurrentProcesses;
    this.outputDir = outputDir;
    this.fileManager = fileManager;
    this.defaultWorkingDirectory = process.env['SHELL_SERVER_DEFAULT_WORKDIR'] || process.cwd();
    this.allowedWorkingDirectories = process.env['SHELL_SERVER_ALLOWED_WORKDIRS']
      ? process.env['SHELL_SERVER_ALLOWED_WORKDIRS'].split(',').map((dir) => dir.trim())
      : [process.cwd()];

    // Initialize StreamPublisher
    this.streamPublisher = new StreamPublisher({
      enableRealtimeStreaming: false, // disabled by default
      bufferSize: 8192,
      notificationInterval: 100,
    });

    // Control streaming via environment variable (phased rollout, enabled by default)
    this.enableStreaming = process.env['SHELL_SERVER_ENABLE_STREAMING'] !== 'false';

    if (this.enableStreaming) {
      this.initializeStreamingComponents();
    }
    this.initializeOutputDirectory();
  }

  // Set TerminalManager reference
  setTerminalManager(terminalManager: TerminalManager): void {
    this.terminalManager = terminalManager;
  }

  // Set FileManager reference
  setFileManager(fileManager: FileManager): void {
    this.fileManager = fileManager;

    // Reinitialize streaming when FileManager is set
    if (this.enableStreaming) {
      this.initializeStreamingComponents();
    }
  }

  // Set callbacks for background process completion
  setBackgroundProcessCallbacks(callbacks: BackgroundProcessCallback): void {
    this.backgroundProcessCallbacks = callbacks;
  }

  // Issue #13: Initialize streaming components
  private initializeStreamingComponents(): void {
    if (!this.fileManager) {
      console.error('ProcessManager: FileManager is required for streaming components');
      return;
    }

    // Initialize FileStorageSubscriber (replacing part of existing FileManager handling)
    this.fileStorageSubscriber = new FileStorageSubscriber(this.fileManager, this.outputDir);
    this.streamPublisher.subscribe(this.fileStorageSubscriber);

    // Initialize RealtimeStreamSubscriber
    this.realtimeStreamSubscriber = new RealtimeStreamSubscriber({
      bufferSize: 8192,
      notificationInterval: 100,
      maxRetentionSeconds: 3600,
      maxBuffers: 1000,
    });
    this.streamPublisher.subscribe(this.realtimeStreamSubscriber);

    console.error('ProcessManager: Streaming components initialized');
  }

  // Issue #13: Enable/disable streaming
  enableStreamingFeature(enable: boolean = true): void {
    this.enableStreaming = enable;

    if (enable && this.fileManager) {
      this.initializeStreamingComponents();
    } else if (!enable) {
      // Cleanup when streaming is disabled
      if (this.realtimeStreamSubscriber) {
        this.streamPublisher.unsubscribe(this.realtimeStreamSubscriber.id);
        this.realtimeStreamSubscriber.destroy();
        this.realtimeStreamSubscriber = undefined;
      }

      if (this.fileStorageSubscriber) {
        this.streamPublisher.unsubscribe(this.fileStorageSubscriber.id);
        this.fileStorageSubscriber = undefined;
      }
    }
  }

  // Issue #13: Get RealtimeStreamSubscriber reference (for new MCP tools)
  getRealtimeStreamSubscriber(): RealtimeStreamSubscriber | undefined {
    return this.realtimeStreamSubscriber;
  }

  /**
  * Issue #13: Get execution ID from output_id
   */
  private findExecutionIdByOutputId(outputId: string): string | undefined {
    return this.fileManager?.getExecutionIdByOutputId(outputId);
  }

  private async initializeOutputDirectory(): Promise<void> {
    await ensureDirectory(this.outputDir);
  }

  async executeCommand(options: ExecutionOptions): Promise<ExecutionInfo> {
    // Check concurrent execution limit
    const runningProcesses = Array.from(this.executions.values()).filter(
      (exec) => exec.status === 'running'
    ).length;

    if (runningProcesses >= this.maxConcurrentProcesses) {
      throw new ResourceLimitError('concurrent processes', this.maxConcurrentProcesses);
    }

    // Prepare input data when input_output_id is specified
    let resolvedInputData: string | undefined = options.inputData;
    let inputStream: StreamingPipelineReader | undefined = undefined;

    if (options.inputOutputId) {
      if (!this.fileManager) {
        throw new ExecutionError('FileManager is not available for input_output_id processing', {
          inputOutputId: options.inputOutputId,
        });
      }

      // Identify execution ID from output_id
      const sourceExecutionId = this.findExecutionIdByOutputId(options.inputOutputId);

      if (sourceExecutionId && this.realtimeStreamSubscriber) {
        // For active processes: use StreamingPipelineReader
        const streamState = this.realtimeStreamSubscriber.getStreamState(sourceExecutionId);
        if (streamState && streamState.isActive) {
          console.error(
            `ProcessManager: Using streaming pipeline for active process ${sourceExecutionId}`
          );
          inputStream = new StreamingPipelineReader(
            this.fileManager,
            this.realtimeStreamSubscriber,
            options.inputOutputId,
            sourceExecutionId
          );
        }
      }

      // If not active (or on failure), fall back to traditional file read
      if (!inputStream) {
        try {
          console.error(`ProcessManager: Using traditional file read for ${options.inputOutputId}`);
          const result = await this.fileManager.readFile(
            options.inputOutputId,
            0,
            100 * 1024 * 1024, // read up to 100MB
            'utf-8'
          );
          resolvedInputData = result.content;
        } catch (error) {
          throw new ExecutionError(
            `Failed to read input from output_id: ${options.inputOutputId}`,
            {
              inputOutputId: options.inputOutputId,
              originalError: String(error),
            }
          );
        }
      }
    }

    const executionId = generateId();
    const startTime = getCurrentTimestamp();

    // Initialize execution info
    const resolvedWorkingDirectory = this.resolveWorkingDirectory(options.workingDirectory);
    const executionInfo: ExecutionInfo = {
      execution_id: executionId,
      command: options.command,
      status: 'running',
      working_directory: resolvedWorkingDirectory,
      default_working_directory: this.defaultWorkingDirectory,
      working_directory_changed: resolvedWorkingDirectory !== this.defaultWorkingDirectory,
      created_at: startTime,
      started_at: startTime,
    };

    if (options.environmentVariables) {
      executionInfo.environment_variables = options.environmentVariables;
    }

    this.executions.set(executionId, executionInfo);

    // If new terminal creation is requested
    if (options.createTerminal && this.terminalManager) {
      try {
        const terminalOptions: TerminalOptions = {
          sessionName: `exec-${executionId}`,
          shellType: (options.terminalShell as TerminalOptions['shellType']) || 'bash',
          dimensions: options.terminalDimensions || { width: 80, height: 24 },
          autoSaveHistory: true,
        };
        if (options.workingDirectory) {
          terminalOptions.workingDirectory = options.workingDirectory;
        }
        if (options.environmentVariables) {
          terminalOptions.environmentVariables = options.environmentVariables;
        }

        const terminalInfo = await this.terminalManager.createTerminal(terminalOptions);
        executionInfo.terminal_id = terminalInfo.terminal_id;

        // Send command to terminal
        this.terminalManager.sendInput(terminalInfo.terminal_id, options.command, true);

        // Update execution info
        executionInfo.status = 'completed';
        executionInfo.completed_at = getCurrentTimestamp();
        this.executions.set(executionId, executionInfo);

        return executionInfo;
      } catch (error) {
        executionInfo.status = 'failed';
        executionInfo.completed_at = getCurrentTimestamp();
        this.executions.set(executionId, executionInfo);
        throw new ExecutionError(`Failed to create terminal: ${error}`, {
          originalError: String(error),
        });
      }
    }

    try {
      // Prepare execution options
      const { inputOutputId: _inputOutputId, ...baseOptions } = options;
      const updatedOptions: ExecutionOptions = {
        ...baseOptions,
        ...(resolvedInputData !== undefined && { inputData: resolvedInputData }),
      };

      // Special handling when StreamingPipelineReader exists
      if (inputStream) {
        return await this.executeCommandWithInputStream(executionId, updatedOptions, inputStream);
      }

      switch (options.executionMode) {
        case 'foreground':
          return await this.executeForegroundCommand(executionId, updatedOptions);
        case 'adaptive':
          return await this.executeAdaptiveCommand(executionId, updatedOptions);
        case 'background':
          return await this.executeBackgroundCommand(executionId, updatedOptions);
        case 'detached':
          return await this.executeDetachedCommand(executionId, updatedOptions);
        default:
          throw new ExecutionError('Unsupported execution mode', { mode: options.executionMode });
      }
    } catch (error) {
      // Update execution info on error
      const updatedInfo = this.executions.get(executionId);
      if (updatedInfo) {
        updatedInfo.status = 'failed';
        updatedInfo.completed_at = getCurrentTimestamp();
        this.executions.set(executionId, updatedInfo);
      }
      throw error;
    }
  }

  /**
  * Issue #13: Execute command using StreamingPipelineReader
   */
  private async executeCommandWithInputStream(
    executionId: string,
    options: ExecutionOptions,
    inputStream: StreamingPipelineReader
  ): Promise<ExecutionInfo> {
    console.error(`ProcessManager: Executing command with input stream for ${executionId}`);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let outputTruncated = false;

      // Prepare environment variables
      const env = getSafeEnvironment(
        process.env as Record<string, string>,
        options.environmentVariables
      );

      // Start process
      const child = spawn('sh', ['-c', options.command], {
        cwd: this.resolveWorkingDirectory(options.workingDirectory),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Connect StreamingPipelineReader to STDIN
      if (child.stdin) {
        inputStream.pipe(child.stdin);
      }

      inputStream.on('error', (error) => {
        console.error(`StreamingPipelineReader error for ${executionId}: ${error.message}`);
        child.kill('SIGTERM');
      });

      // Notify StreamPublisher
      if (this.streamPublisher) {
        this.streamPublisher.notifyProcessStart(executionId, options.command);
      }

      // Handle STDOUT
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          const chunk = data.toString();
          if (stdout.length + chunk.length <= options.maxOutputSize) {
            stdout += chunk;
          } else {
            outputTruncated = true;
          }

          // Notify StreamPublisher
          if (this.streamPublisher) {
            this.streamPublisher.notifyOutputData(executionId, chunk, false);
          }
        });
      }

      // Handle STDERR
      if (options.captureStderr && child.stderr) {
        child.stderr.on('data', (data) => {
          const chunk = data.toString();
          if (stderr.length + chunk.length <= options.maxOutputSize) {
            stderr += chunk;
          } else {
            outputTruncated = true;
          }

          // Notify StreamPublisher
          if (this.streamPublisher) {
            this.streamPublisher.notifyOutputData(executionId, chunk, true);
          }
        });
      }

      // Handle process completion
      child.on('close', async (code) => {
        const executionInfo = this.executions.get(executionId);
        if (!executionInfo) {
          reject(new ExecutionError('Execution info not found', { executionId }));
          return;
        }

        // Calculate execution time
        const executionTime = Date.now() - startTime;

        // Update execution info
        executionInfo.status = code === 0 ? 'completed' : 'failed';
        executionInfo.completed_at = getCurrentTimestamp();
        if (code !== null) {
          executionInfo.exit_code = code;
        }
        executionInfo.execution_time_ms = executionTime;

        // Save output
        if (this.fileManager) {
          try {
            const combinedOutput = stdout + (options.captureStderr ? stderr : '');
            if (combinedOutput) {
              const outputId = await this.fileManager.createOutputFile(combinedOutput, executionId);
              executionInfo.output_id = outputId;
              executionInfo.output_truncated = outputTruncated;
            }
          } catch (error) {
            console.error(`Failed to save output for ${executionId}: ${error}`);
          }
        }

        this.executions.set(executionId, executionInfo);

        // Notify StreamPublisher
        if (this.streamPublisher) {
          this.streamPublisher.notifyProcessEnd(executionId, code);
        }

        console.error(`Command completed: ${options.command} (exit code: ${code})`);
        resolve(executionInfo);
      });

      child.on('error', (error) => {
        console.error(`Process error for ${executionId}: ${error.message}`);

        // Notify StreamPublisher
        if (this.streamPublisher) {
          this.streamPublisher.notifyError(executionId, error);
        }

        reject(
          new ExecutionError(`Process error: ${error.message}`, { originalError: String(error) })
        );
      });

      // Timeout handling
      const timeout = setTimeout(() => {
        console.error(`Process timeout for ${executionId}`);
        child.kill('SIGTERM');

        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }, options.timeoutSeconds * 1000);

      child.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  private async executeForegroundCommand(
    executionId: string,
    options: ExecutionOptions
  ): Promise<ExecutionInfo> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let outputTruncated = false;

      // Prepare environment variables
      const env = getSafeEnvironment(
        process.env as Record<string, string>,
        options.environmentVariables
      );

      // Start process
      const childProcess = spawn('/bin/bash', ['-c', options.command], {
        cwd: this.resolveWorkingDirectory(options.workingDirectory),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (childProcess.pid) {
        this.processes.set(childProcess.pid, childProcess);
      }

      // Set timeout
      const timeout = setTimeout(async () => {
        childProcess.kill('SIGTERM');
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill('SIGKILL');
          }
        }, 5000);

        const executionTime = Date.now() - startTime;
        const executionInfo = this.executions.get(executionId);
        if (executionInfo) {
          executionInfo.status = 'timeout';
          executionInfo.stdout = sanitizeString(stdout);
          executionInfo.stderr = sanitizeString(stderr);
          executionInfo.completed_at = getCurrentTimestamp();
          executionInfo.execution_time_ms = executionTime;
          if (childProcess.pid !== undefined) {
            executionInfo.process_id = childProcess.pid;
          }

          // Save output to FileManager (regardless of size)
          let outputFileId: string | undefined;
          try {
            outputFileId = await this.saveOutputToFile(executionId, stdout, stderr);
            executionInfo.output_id = outputFileId;
          } catch (error) {
            // Record file-save failures as critical errors and include them in execution info
            console.error(
              `[CRITICAL] Failed to save output file for execution ${executionId}:`,
              error
            );
            executionInfo.message = `Output file save failed: ${error instanceof Error ? error.message : String(error)}`;
          }

          // Set detailed output status
          this.setOutputStatus(executionInfo, outputTruncated, 'timeout', outputFileId);

          this.executions.set(executionId, executionInfo);

          // Return partial result when return_partial_on_timeout is true
          if (options.returnPartialOnTimeout) {
            resolve(executionInfo);
            return;
          }
        }

        reject(new TimeoutError(options.timeoutSeconds));
      }, options.timeoutSeconds * 1000);

      // Send stdin
      if (options.inputData) {
        childProcess.stdin?.write(options.inputData);
        childProcess.stdin?.end();
      } else {
        childProcess.stdin?.end();
      }

      // Handle stdout
      childProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        if (stdout.length + output.length <= options.maxOutputSize) {
          stdout += output;
        } else {
          stdout += output.substring(0, options.maxOutputSize - stdout.length);
          outputTruncated = true;
        }
      });

      // Handle stderr
      if (options.captureStderr) {
        childProcess.stderr?.on('data', (data: Buffer) => {
          const output = data.toString();
          if (stderr.length + output.length <= options.maxOutputSize) {
            stderr += output;
          } else {
            stderr += output.substring(0, options.maxOutputSize - stderr.length);
            outputTruncated = true;
          }
        });
      }

      // Handle process close
      childProcess.on('close', async (code) => {
        clearTimeout(timeout);
        if (childProcess.pid) {
          this.processes.delete(childProcess.pid);
        }

        const executionTime = Date.now() - startTime;
        const executionInfo = this.executions.get(executionId);

        if (executionInfo) {
          executionInfo.status = 'completed';
          executionInfo.exit_code = code || 0;
          executionInfo.stdout = sanitizeString(stdout);
          executionInfo.stderr = sanitizeString(stderr);
          executionInfo.execution_time_ms = executionTime;
          if (childProcess.pid !== undefined) {
            executionInfo.process_id = childProcess.pid;
          }
          executionInfo.completed_at = getCurrentTimestamp();

          // Save output to FileManager (regardless of size)
          let outputFileId: string | undefined;
          try {
            outputFileId = await this.saveOutputToFile(executionId, stdout, stderr);
            executionInfo.output_id = outputFileId;
          } catch (error) {
            // Record file-save failures as critical errors and include them in execution info
            console.error(
              `[CRITICAL] Failed to save output file for execution ${executionId}:`,
              error
            );
            executionInfo.message = `Output file save failed: ${error instanceof Error ? error.message : String(error)}`;
          }

          // Set detailed output status
          if (outputTruncated) {
            this.setOutputStatus(executionInfo, true, 'size_limit', outputFileId);
          } else {
            // Normal completion: actuallyTruncated=false, use a valid reason to show completion guidance
            this.setOutputStatus(executionInfo, false, 'size_limit', outputFileId);
          }

          this.executions.set(executionId, executionInfo);
          resolve(executionInfo);
        }
      });

      // Error handling
      childProcess.on('error', (error) => {
        clearTimeout(timeout);
        if (childProcess.pid) {
          this.processes.delete(childProcess.pid);
        }

        const executionInfo = this.executions.get(executionId);
        if (executionInfo) {
          executionInfo.status = 'failed';
          executionInfo.completed_at = getCurrentTimestamp();
          executionInfo.execution_time_ms = Date.now() - startTime;
          this.executions.set(executionId, executionInfo);
        }

        reject(
          new ExecutionError(`Process execution failed: ${error.message}`, {
            originalError: error.message,
          })
        );
      });
    });
  }

  private async executeAdaptiveCommand(
    executionId: string,
    options: ExecutionOptions
  ): Promise<ExecutionInfo> {
    // Adaptive mode: start one process and transition to background when:
    // 1. Foreground timeout is reached
    // 2. Output size limit is reached
    const returnPartialOnTimeout = options.returnPartialOnTimeout ?? true;
    const foregroundTimeout = options.foregroundTimeoutSeconds ?? 10;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let outputTruncated = false;
      let backgroundTransitionReason: 'timeout' | 'output_size_limit' | null = null;

      // Prepare environment variables
      const env = getSafeEnvironment(
        process.env as Record<string, string>,
        options.environmentVariables
      );

      // Start process (supports background transition)
      const childProcess = spawn('/bin/bash', ['-c', options.command], {
        cwd: this.resolveWorkingDirectory(options.workingDirectory),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (childProcess.pid) {
        this.processes.set(childProcess.pid, childProcess);
      }

      // Set foreground timeout
      const foregroundTimeoutHandle = setTimeout(() => {
        if (!backgroundTransitionReason) {
          backgroundTransitionReason = 'timeout';
          transitionToBackground();
        }
      }, foregroundTimeout * 1000);

      // Set final timeout
      const finalTimeoutHandle = setTimeout(async () => {
        childProcess.kill('SIGTERM');
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill('SIGKILL');
          }
        }, 5000);

        const executionInfo = this.executions.get(executionId);
        if (executionInfo) {
          executionInfo.status = 'timeout';
          executionInfo.stdout = sanitizeString(stdout);
          executionInfo.stderr = sanitizeString(stderr);
          executionInfo.output_truncated = outputTruncated;
          executionInfo.completed_at = getCurrentTimestamp();
          executionInfo.execution_time_ms = Date.now() - startTime;

          // Save output to FileManager
          try {
            const outputFileId = await this.saveOutputToFile(executionId, stdout, stderr);
            executionInfo.output_id = outputFileId;
          } catch (error) {
            // Record file-save failures as critical errors and include them in execution info
            console.error(
              `[CRITICAL] Failed to save output file for execution ${executionId}:`,
              error
            );
            executionInfo.message = `Output file save failed: ${error instanceof Error ? error.message : String(error)}`;
          }

          this.executions.set(executionId, executionInfo);

          if (returnPartialOnTimeout) {
            resolve(executionInfo);
            return;
          }
        }

        reject(new TimeoutError(options.timeoutSeconds));
      }, options.timeoutSeconds * 1000);

      // Function to transition to background mode
      const transitionToBackground = async () => {
        clearTimeout(foregroundTimeoutHandle);

        const executionInfo = this.executions.get(executionId);
        if (executionInfo) {
          executionInfo.status = 'running';
          executionInfo.stdout = sanitizeString(stdout);
          executionInfo.stderr = sanitizeString(stderr);

          // Record transition reason
          if (backgroundTransitionReason === 'timeout') {
            executionInfo.transition_reason = 'foreground_timeout';
          } else if (backgroundTransitionReason === 'output_size_limit') {
            executionInfo.transition_reason = 'output_size_limit';
          }

          if (childProcess.pid !== undefined) {
            executionInfo.process_id = childProcess.pid;
          }

          // Save output to FileManager
          let outputFileId: string | undefined;
          try {
            outputFileId = await this.saveOutputToFile(executionId, stdout, stderr);
            executionInfo.output_id = outputFileId;
          } catch (error) {
            // Record file-save failures as critical errors and include them in execution info
            console.error(
              `[CRITICAL] Failed to save output file for execution ${executionId}:`,
              error
            );
            executionInfo.message = `Output file save failed: ${error instanceof Error ? error.message : String(error)}`;
          }

          // Set detailed output status (background transition)
          this.setOutputStatus(
            executionInfo,
            outputTruncated,
            'background_transition',
            outputFileId
          );

          this.executions.set(executionId, executionInfo);

          // Configure continued background handling (adaptive mode only)
          this.handleAdaptiveBackgroundTransition(executionId, childProcess, {
            ...options,
            timeoutSeconds: Math.max(
              1,
              options.timeoutSeconds - Math.floor((Date.now() - startTime) / 1000)
            ),
          });

          resolve(executionInfo);
        }
      };

      // Send stdin
      if (options.inputData) {
        childProcess.stdin?.write(options.inputData);
        childProcess.stdin?.end();
      } else {
        childProcess.stdin?.end();
      }

      // Handle stdout
      childProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        if (stdout.length + output.length <= options.maxOutputSize) {
          stdout += output;
        } else {
          stdout += output.substring(0, options.maxOutputSize - stdout.length);
          outputTruncated = true;

          // Transition to background when output size limit is reached
          if (!backgroundTransitionReason) {
            backgroundTransitionReason = 'output_size_limit';
            transitionToBackground();
          }
        }
      });

      // Handle stderr
      if (options.captureStderr) {
        childProcess.stderr?.on('data', (data: Buffer) => {
          const output = data.toString();
          if (stderr.length + output.length <= options.maxOutputSize) {
            stderr += output;
          } else {
            stderr += output.substring(0, options.maxOutputSize - stderr.length);
            outputTruncated = true;

            // Transition to background when output size limit is reached
            if (!backgroundTransitionReason) {
              backgroundTransitionReason = 'output_size_limit';
              transitionToBackground();
            }
          }
        });
      }

      // Handle process close
      childProcess.on('close', async (code) => {
        clearTimeout(foregroundTimeoutHandle);
        clearTimeout(finalTimeoutHandle);
        if (childProcess.pid) {
          this.processes.delete(childProcess.pid);
        }

        // Handle only when no background transition occurred
        if (!backgroundTransitionReason) {
          const executionTime = Date.now() - startTime;
          const executionInfo = this.executions.get(executionId);

          if (executionInfo) {
            executionInfo.status = 'completed';
            executionInfo.exit_code = code || 0;
            executionInfo.stdout = sanitizeString(stdout);
            executionInfo.stderr = sanitizeString(stderr);
            executionInfo.output_truncated = outputTruncated;
            executionInfo.execution_time_ms = executionTime;
            if (childProcess.pid !== undefined) {
              executionInfo.process_id = childProcess.pid;
            }
            executionInfo.completed_at = getCurrentTimestamp();

            // Save output to FileManager
            try {
              const outputFileId = await this.saveOutputToFile(executionId, stdout, stderr);
              executionInfo.output_id = outputFileId;
            } catch (error) {
              // Record file-save failures as critical errors and include them in execution info
              console.error(
                `[CRITICAL] Failed to save output file for execution ${executionId}:`,
                error
              );
              executionInfo.message = `Output file save failed: ${error instanceof Error ? error.message : String(error)}`;
            }

            this.executions.set(executionId, executionInfo);
            resolve(executionInfo);
          }
        }
      });

      // Error handling
      childProcess.on('error', (error) => {
        clearTimeout(foregroundTimeoutHandle);
        clearTimeout(finalTimeoutHandle);
        if (childProcess.pid) {
          this.processes.delete(childProcess.pid);
        }

        if (!backgroundTransitionReason) {
          const executionInfo = this.executions.get(executionId);
          if (executionInfo) {
            executionInfo.status = 'failed';
            executionInfo.completed_at = getCurrentTimestamp();
            executionInfo.execution_time_ms = Date.now() - startTime;
            this.executions.set(executionId, executionInfo);
          }

          reject(
            new ExecutionError(`Process execution failed: ${error.message}`, {
              originalError: error.message,
            })
          );
        }
      });
    });
  }

  private async executeBackgroundCommand(
    executionId: string,
    options: ExecutionOptions
  ): Promise<ExecutionInfo> {
    const env = getSafeEnvironment(
      process.env as Record<string, string>,
      options.environmentVariables
    );

    const childProcess = spawn('/bin/bash', ['-c', options.command], {
      cwd: this.resolveWorkingDirectory(options.workingDirectory),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: options.executionMode === 'background',
    });

    if (childProcess.pid) {
      this.processes.set(childProcess.pid, childProcess);
    }

    const executionInfo = this.executions.get(executionId);
    if (executionInfo && childProcess.pid !== undefined) {
      executionInfo.process_id = childProcess.pid;
      this.executions.set(executionId, executionInfo);
    }

    // For background processes, handle output asynchronously
    if (options.executionMode === 'background') {
      this.handleBackgroundProcess(executionId, childProcess, options);
    }

    const resultExecutionInfo = this.executions.get(executionId);
    if (!resultExecutionInfo) {
      throw new Error(`Execution info not found for ID: ${executionId}`);
    }
    return resultExecutionInfo;
  }

  private handleBackgroundProcess(
    executionId: string,
    childProcess: ChildProcess,
    options: ExecutionOptions
  ): void {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    // Set timeout (for background processes)
    const timeout = setTimeout(async () => {
      childProcess.kill('SIGTERM');
      setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill('SIGKILL');
        }
      }, 5000);

      const executionInfo = this.executions.get(executionId);
      if (executionInfo) {
        executionInfo.status = 'timeout';
        executionInfo.stdout = stdout;
        executionInfo.stderr = stderr;
        executionInfo.output_truncated = true;
        executionInfo.completed_at = getCurrentTimestamp();
        executionInfo.execution_time_ms = Date.now() - startTime;

        // Save output to FileManager
        try {
          const outputFileId = await this.saveOutputToFile(executionId, stdout, stderr);
          executionInfo.output_id = outputFileId;
        } catch (error) {
          // Record file-save failures as critical errors and include them in execution info
          console.error(
            `[CRITICAL] Failed to save output file for execution ${executionId}:`,
            error
          );
          executionInfo.message = `Output file save failed: ${error instanceof Error ? error.message : String(error)}`;
        }

        this.executions.set(executionId, executionInfo);

        // Invoke timeout callback for background process
        if (this.backgroundProcessCallbacks.onTimeout) {
          setImmediate(async () => {
            try {
              const callback = this.backgroundProcessCallbacks.onTimeout;
              if (callback) {
                const result = callback(executionId, executionInfo);
                if (result instanceof Promise) {
                  await result;
                }
              }
            } catch (callbackError) {
              // Record callback errors in internal logs only
              // console.error('Background process timeout callback error:', callbackError);
            }
          });
        }
      }
    }, options.timeoutSeconds * 1000);

    // Collect output
    childProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    if (options.captureStderr) {
      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
    }

    // Handle process close
    childProcess.on('close', async (code) => {
      clearTimeout(timeout);
      if (childProcess.pid) {
        this.processes.delete(childProcess.pid);
      }

      const executionInfo = this.executions.get(executionId);
      if (executionInfo) {
        executionInfo.status = 'completed';
        executionInfo.exit_code = code || 0;
        executionInfo.execution_time_ms = Date.now() - startTime;
        executionInfo.completed_at = getCurrentTimestamp();

        // Save output to file
        try {
          const outputFileId = await this.saveOutputToFile(executionId, stdout, stderr);
          executionInfo.output_id = outputFileId;
        } catch (error) {
          // Record file-save failures as critical errors and include them in execution info
          console.error(
            `[CRITICAL] Failed to save output file for execution ${executionId}:`,
            error
          );
          executionInfo.message = `Output file save failed: ${error instanceof Error ? error.message : String(error)}`;
        }

        this.executions.set(executionId, executionInfo);

        // Invoke completion callback for background process
        if (this.backgroundProcessCallbacks.onComplete) {
          setImmediate(async () => {
            try {
              const callback = this.backgroundProcessCallbacks.onComplete;
              if (callback) {
                const result = callback(executionId, executionInfo);
                if (result instanceof Promise) {
                  await result;
                }
              }
            } catch (callbackError) {
              // Record callback errors in internal logs only
              // console.error('Background process completion callback error:', callbackError);
            }
          });
        }
      }
    });

    childProcess.on('error', (error) => {
      clearTimeout(timeout);
      if (childProcess.pid) {
        this.processes.delete(childProcess.pid);
      }
      const executionInfo = this.executions.get(executionId);
      if (executionInfo) {
        executionInfo.status = 'failed';
        executionInfo.execution_time_ms = Date.now() - startTime;
        executionInfo.completed_at = getCurrentTimestamp();
        this.executions.set(executionId, executionInfo);

        // Invoke error callback for background process
        if (this.backgroundProcessCallbacks.onError) {
          setImmediate(async () => {
            try {
              const callback = this.backgroundProcessCallbacks.onError;
              if (callback) {
                const result = callback(executionId, executionInfo, error);
                if (result instanceof Promise) {
                  await result;
                }
              }
            } catch (callbackError) {
              // Record callback errors in internal logs only
              // console.error('Background process error callback error:', callbackError);
            }
          });
        }
      }
    });
  }

  // Handle processes transitioned to background in adaptive mode
  private handleAdaptiveBackgroundTransition(
    executionId: string,
    childProcess: ChildProcess,
    options: ExecutionOptions
  ): void {
    // Set timeout (final timeout)
    const timeout = setTimeout(async () => {
      childProcess.kill('SIGTERM');
      setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill('SIGKILL');
        }
      }, 5000);

      const executionInfo = this.executions.get(executionId);
      if (executionInfo) {
        executionInfo.status = 'timeout';
        executionInfo.completed_at = getCurrentTimestamp();

        // Keep existing output (already captured in adaptive mode)
        this.executions.set(executionId, executionInfo);
      }
    }, options.timeoutSeconds * 1000);

    // Handle process close
    childProcess.on('close', async (code) => {
      clearTimeout(timeout);
      if (childProcess.pid) {
        this.processes.delete(childProcess.pid);
      }

      const executionInfo = this.executions.get(executionId);
      if (executionInfo) {
        executionInfo.status = 'completed';
        executionInfo.exit_code = code || 0;
        executionInfo.completed_at = getCurrentTimestamp();

        // Calculate total execution time (foreground + background)
        if (executionInfo.started_at) {
          const startTime = new Date(executionInfo.started_at).getTime();
          executionInfo.execution_time_ms = Date.now() - startTime;
        }

        this.executions.set(executionId, executionInfo);

        // Invoke completion callback for adaptive-mode background process
        if (this.backgroundProcessCallbacks.onComplete) {
          setImmediate(async () => {
            try {
              const callback = this.backgroundProcessCallbacks.onComplete;
              if (callback) {
                const result = callback(executionId, executionInfo);
                if (result instanceof Promise) {
                  await result;
                }
              }
            } catch (callbackError) {
              // Record callback errors in internal logs only
              // console.error('Adaptive background process completion callback error:', callbackError);
            }
          });
        }
      }
    });

    childProcess.on('error', (error) => {
      clearTimeout(timeout);
      if (childProcess.pid) {
        this.processes.delete(childProcess.pid);
      }
      const executionInfo = this.executions.get(executionId);
      if (executionInfo) {
        executionInfo.status = 'failed';
        executionInfo.completed_at = getCurrentTimestamp();

        if (executionInfo.started_at) {
          const startTime = new Date(executionInfo.started_at).getTime();
          executionInfo.execution_time_ms = Date.now() - startTime;
        }

        this.executions.set(executionId, executionInfo);

        // Invoke error callback for adaptive-mode background process
        if (this.backgroundProcessCallbacks.onError) {
          setImmediate(async () => {
            try {
              const callback = this.backgroundProcessCallbacks.onError;
              if (callback) {
                const result = callback(executionId, executionInfo, error);
                if (result instanceof Promise) {
                  await result;
                }
              }
            } catch (callbackError) {
              // Record callback errors in internal logs only
              // console.error('Adaptive background process error callback error:', callbackError);
            }
          });
        }
      }
    });
  }

  private async executeDetachedCommand(
    executionId: string,
    options: ExecutionOptions
  ): Promise<ExecutionInfo> {
    // Detached mode: run fully in background and detach from parent process
    const env = getSafeEnvironment(
      process.env as Record<string, string>,
      options.environmentVariables
    );

    const childProcess = spawn('/bin/bash', ['-c', options.command], {
      cwd: this.resolveWorkingDirectory(options.workingDirectory),
      env,
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin
      detached: true, // fully detached
    });

    // Record detached process PID but exclude it from process management
    const executionInfo = this.executions.get(executionId);
    if (executionInfo && childProcess.pid !== undefined) {
      executionInfo.process_id = childProcess.pid;
      executionInfo.status = 'running';
      this.executions.set(executionId, executionInfo);
    }

    // Detached processes continue after parent exits,
    // so output collection is limited
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    if (childProcess.stdout) {
      childProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    // Monitor process exit (not always capturable when detached)
    childProcess.on('close', async (code) => {
      const executionInfo = this.executions.get(executionId);
      if (executionInfo) {
        executionInfo.status = 'completed';
        executionInfo.exit_code = code || 0;
        executionInfo.execution_time_ms = Date.now() - startTime;
        executionInfo.completed_at = getCurrentTimestamp();

        try {
          const outputFileId = await this.saveOutputToFile(executionId, stdout, stderr);
          executionInfo.output_id = outputFileId;
        } catch (error) {
          // Record file-save failures as critical errors and include them in execution info
          console.error(
            `[CRITICAL] Failed to save output file for execution ${executionId}:`,
            error
          );
          executionInfo.message = `Output file save failed: ${error instanceof Error ? error.message : String(error)}`;
        }

        this.executions.set(executionId, executionInfo);

        // Invoke completion callback for detached process
        if (this.backgroundProcessCallbacks.onComplete) {
          setImmediate(async () => {
            try {
              const callback = this.backgroundProcessCallbacks.onComplete;
              if (callback) {
                const result = callback(executionId, executionInfo);
                if (result instanceof Promise) {
                  await result;
                }
              }
            } catch (callbackError) {
              // Record callback errors in internal logs only
              // console.error('Detached process completion callback error:', callbackError);
            }
          });
        }
      }
    });

    childProcess.on('error', (error) => {
      const executionInfo = this.executions.get(executionId);
      if (executionInfo) {
        executionInfo.status = 'failed';
        executionInfo.execution_time_ms = Date.now() - startTime;
        executionInfo.completed_at = getCurrentTimestamp();
        this.executions.set(executionId, executionInfo);

        // Invoke error callback for detached process
        if (this.backgroundProcessCallbacks.onError) {
          setImmediate(async () => {
            try {
              const callback = this.backgroundProcessCallbacks.onError;
              if (callback) {
                const result = callback(executionId, executionInfo, error);
                if (result instanceof Promise) {
                  await result;
                }
              }
            } catch (callbackError) {
              // Record callback errors in internal logs only
              // console.error('Detached process error callback error:', callbackError);
            }
          });
        }
      }
    });

    // Detach process
    childProcess.unref();

    const resultExecutionInfo = this.executions.get(executionId);
    if (!resultExecutionInfo) {
      throw new Error(`Execution info not found for ID: ${executionId}`);
    }
    return resultExecutionInfo;
  }

  private async saveOutputToFile(
    executionId: string,
    stdout: string,
    stderr: string
  ): Promise<string> {
    if (!this.fileManager) {
      // If FileManager is unavailable, save file using legacy method
      const outputFileId = generateId();
      const filePath = path.join(this.outputDir, `${outputFileId}.json`);

      const outputData = {
        execution_id: executionId,
        stdout,
        stderr,
        created_at: getCurrentTimestamp(),
      };

      await fs.writeFile(filePath, JSON.stringify(outputData, null, 2), 'utf-8');
      return outputFileId;
    }

    // Create output file using FileManager
    const combinedOutput = stdout + (stderr ? '\n--- STDERR ---\n' + stderr : '');
    return await this.fileManager.createOutputFile(combinedOutput, executionId);
  }

  /**
  * Helper to set detailed output status information
   * Issue #14: Enhanced guidance messages for adaptive mode transitions
  * Improvement: determine status by reason instead of outputTruncated
   */
  private setOutputStatus(
    executionInfo: ExecutionInfo,
    actuallyTruncated: boolean, // whether output was actually truncated
    reason: OutputTruncationReason,
    outputId?: string
  ): void {
    // Set output status based on reason
    const needsGuidance = !!outputId; // always provide guidance when output_id exists

    // Set outputTruncated for backward compatibility
    executionInfo.output_truncated =
      actuallyTruncated || reason === 'timeout' || reason === 'background_transition';

    // Issue #14: Handle background transitions and timeouts specially
    if (reason === 'background_transition') {
      executionInfo.truncation_reason = reason;
      executionInfo.output_status = {
        complete: false, // incomplete while running in background
        reason: reason,
        available_via_output_id: !!outputId,
        recommended_action: outputId ? 'use_read_execution_output' : undefined,
      };

      executionInfo.message =
        'Command moved to background execution. Use process_list to monitor progress.';
      executionInfo.next_steps = [
        'Use process_list to check status',
        'Use read_execution_output when completed',
        'Use output_id for real-time pipeline processing',
      ];
      if (needsGuidance) {
        executionInfo.guidance = {
          pipeline_usage: `Background process active. Use "input_output_id": "${outputId}" for real-time processing`,
          suggested_commands: [
            'tail -f equivalent using input_output_id for live monitoring',
            'grep for real-time log filtering',
            'awk for live data extraction and formatting',
          ],
          background_processing: {
            status_check: 'Use process_get_execution for detailed status',
            monitoring: 'Output_id supports real-time streaming while process runs',
          },
        };
      }
      return;
    }

    if (reason === 'timeout') {
      executionInfo.truncation_reason = reason;
      executionInfo.output_status = {
        complete: false, // timeout means incomplete
        reason: reason,
        available_via_output_id: !!outputId,
        recommended_action: outputId ? 'use_read_execution_output' : undefined,
      };

      executionInfo.message = `Command timed out. ${outputId ? 'Use read_execution_output with output_id for complete results.' : 'Partial output available.'}`;
      if (needsGuidance) {
        executionInfo.next_steps = [
          'Use read_execution_output to get complete output',
          'Use output_id for pipeline processing with grep/sed/awk commands',
        ];
        executionInfo.guidance = {
          pipeline_usage: `Use "input_output_id": "${outputId}" parameter for further processing`,
          suggested_commands: [
            'grep pattern search using input_output_id',
            'sed text transformations using input_output_id',
            'awk data processing using input_output_id',
          ],
        };
      }
      return;
    }

    // When output was actually truncated
    if (actuallyTruncated) {
      executionInfo.truncation_reason = reason;
      executionInfo.output_status = {
        complete: false,
        reason: reason,
        available_via_output_id: !!outputId,
        recommended_action: outputId ? 'use_read_execution_output' : undefined,
      };

      // Set message and actions based on situation
      switch (reason) {
        case 'size_limit':
          executionInfo.message = `Output exceeded size limit. ${outputId ? 'Complete output available via output_id.' : 'Output was truncated.'}`;
          if (needsGuidance) {
            executionInfo.next_steps = [
              'Use read_execution_output to get complete output',
              'Use output_id for streaming pipeline processing',
            ];
            executionInfo.guidance = {
              pipeline_usage: `Large output detected. Use "input_output_id": "${outputId}" for efficient processing`,
              suggested_commands: [
                'head/tail for output sampling using input_output_id',
                'grep for pattern matching without loading full output',
                'wc for counting lines/words/bytes efficiently',
              ],
            };
          }
          break;
        default:
          executionInfo.message = `Output truncated due to ${reason}. ${outputId ? 'Complete output may be available via output_id.' : ''}`;
          if (needsGuidance) {
            executionInfo.next_steps = [
              'Use read_execution_output to get complete output',
              'Use output_id for pipeline processing',
            ];
            executionInfo.guidance = {
              pipeline_usage: `Use "input_output_id": "${outputId}" parameter for further processing`,
              suggested_commands: [
                'grep for pattern searching',
                'sed for text transformations',
                'awk for data processing',
              ],
            };
          }
      }
    } else {
      // Completed case (no truncation)
      executionInfo.output_status = {
        complete: true,
        available_via_output_id: !!outputId,
      };

      // Issue #14: Add guidance even for complete outputs to promote pipeline usage
      if (needsGuidance) {
        executionInfo.guidance = {
          pipeline_usage: `Output saved. Use "input_output_id": "${outputId}" for further processing`,
          suggested_commands: [
            'grep for pattern searching',
            'sed for text transformations',
            'awk for data processing and formatting',
          ],
        };
      }
    }
  }

  getExecution(executionId: string): ExecutionInfo | undefined {
    return this.executions.get(executionId);
  }

  listExecutions(filter?: {
    status?: ExecutionStatus;
    commandPattern?: string;
    sessionId?: string;
    limit?: number;
    offset?: number;
  }): { executions: ExecutionInfo[]; total: number } {
    let executions = Array.from(this.executions.values());

    // Filtering
    if (filter) {
      if (filter.status) {
        executions = executions.filter((exec) => exec.status === filter.status);
      }
      if (filter.commandPattern) {
        const pattern = new RegExp(filter.commandPattern, 'i');
        executions = executions.filter((exec) => pattern.test(exec.command));
      }
      if (filter.sessionId) {
        // Session management will be implemented later
      }
    }

    const total = executions.length;

    // Pagination
    if (filter?.offset || filter?.limit) {
      const offset = filter.offset || 0;
      const limit = filter.limit || 50;
      executions = executions.slice(offset, offset + limit);
    }

    return { executions, total };
  }

  async killProcess(
    processId: number,
    signal: ProcessSignal = 'TERM',
    force = false
  ): Promise<{
    success: boolean;
    signal_sent: ProcessSignal;
    exit_code?: number;
    message: string;
  }> {
    const childProcess = this.processes.get(processId);

    if (!childProcess) {
      throw new ResourceNotFoundError('process', processId.toString());
    }

    try {
      // Terminate process
      const signalName = signal === 'KILL' ? 'SIGKILL' : `SIG${signal}`;
      const killed = childProcess.kill(signalName as NodeJS.Signals);

      if (!killed && force && signal !== 'KILL') {
        // Force kill
        childProcess.kill('SIGKILL');
      }

      // Wait until process exits
      await new Promise<void>((resolve) => {
        childProcess.on('close', () => resolve());
        setTimeout(() => resolve(), 5000); // timeout after 5 seconds
      });

      this.processes.delete(processId);

      return {
        success: true,
        signal_sent: signal,
        exit_code: childProcess.exitCode || undefined,
        message: 'Process terminated successfully',
      } as {
        success: boolean;
        signal_sent: ProcessSignal;
        exit_code?: number;
        message: string;
      };
    } catch (error) {
      return {
        success: false,
        signal_sent: signal,
        message: `Failed to kill process: ${error}`,
      };
    }
  }

  listProcesses(): ExecutionProcessInfo[] {
    const processes: ExecutionProcessInfo[] = [];

    for (const [pid] of this.processes) {
      // Find corresponding execution info
      const execution = Array.from(this.executions.values()).find(
        (exec) => exec.process_id === pid
      );

      if (execution) {
        const processInfo: ExecutionProcessInfo = {
          process_id: pid,
          execution_id: execution.execution_id,
          command: execution.command,
          status: execution.status,
          created_at: execution.created_at,
        };

        if (execution.working_directory) {
          processInfo.working_directory = execution.working_directory;
        }
        if (execution.environment_variables) {
          processInfo.environment_variables = execution.environment_variables;
        }
        if (execution.started_at) {
          processInfo.started_at = execution.started_at;
        }
        if (execution.completed_at) {
          processInfo.completed_at = execution.completed_at;
        }

        processes.push(processInfo);
      }
    }

    return processes;
  }

  cleanup(): void {
    // Terminate all running processes
    for (const [, childProcess] of this.processes) {
      try {
        childProcess.kill('SIGTERM');
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill('SIGKILL');
          }
        }, 5000);
      } catch (error) {
        // Record error in internal log (avoid stdout)
        // console.error(`Failed to cleanup process ${pid}:`, error);
      }
    }

    this.processes.clear();
    this.executions.clear();
  }

  // Working directory management
  setDefaultWorkingDirectory(workingDirectory: string): {
    success: boolean;
    previous_working_directory: string;
    new_working_directory: string;
    working_directory_changed: boolean;
  } {
    const previousWorkdir = this.defaultWorkingDirectory;

    // Validate directory
    if (!this.isAllowedWorkingDirectory(workingDirectory)) {
      throw new Error(`Working directory not allowed: ${workingDirectory}`);
    }

    this.defaultWorkingDirectory = workingDirectory;

    return {
      success: true,
      previous_working_directory: previousWorkdir,
      new_working_directory: workingDirectory,
      working_directory_changed: previousWorkdir !== workingDirectory,
    };
  }

  getDefaultWorkingDirectory(): string {
    return this.defaultWorkingDirectory;
  }

  getAllowedWorkingDirectories(): string[] {
    return [...this.allowedWorkingDirectories];
  }

  private isAllowedWorkingDirectory(workingDirectory: string): boolean {
    // Compare using normalized paths
    const normalizedPath = path.resolve(workingDirectory);
    return this.allowedWorkingDirectories.some((allowedDir) => {
      const normalizedAllowed = path.resolve(allowedDir);
      return (
        normalizedPath === normalizedAllowed ||
        normalizedPath.startsWith(normalizedAllowed + path.sep)
      );
    });
  }

  private resolveWorkingDirectory(workingDirectory?: string): string {
    const resolved = workingDirectory || this.defaultWorkingDirectory;

    if (!this.isAllowedWorkingDirectory(resolved)) {
      throw new Error(`Working directory not allowed: ${resolved}`);
    }

    return resolved;
  }
}
