import { ErrorCategory, ErrorInfo } from '../types/index.js';

export class ShellServerError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: string;
  public readonly requestId?: string;

  constructor(
    code: string,
    message: string,
    category: ErrorCategory,
    details?: Record<string, unknown>,
    requestId?: string
  ) {
    super(message);
    this.name = 'ShellServerError';
    this.code = code;
    this.category = category;
    this.details = details || {};
    this.timestamp = new Date().toISOString();
    this.requestId = requestId || '';
  }

  toErrorInfo(): ErrorInfo {
    const errorInfo: ErrorInfo = {
      code: this.code,
      message: this.message,
      category: this.category,
      timestamp: this.timestamp,
    };

    if (this.details && Object.keys(this.details).length > 0) {
      errorInfo.details = this.details;
    }

    if (this.requestId) {
      errorInfo.request_id = this.requestId;
    }

    return errorInfo;
  }

  static fromError(error: unknown, requestId?: string): ShellServerError {
    if (error instanceof ShellServerError) {
      return error;
    }

    if (error instanceof Error) {
      return new ShellServerError(
        'SYSTEM_001',
        error.message,
        'SYSTEM',
        { stack: error.stack },
        requestId
      );
    }

    return new ShellServerError(
      'SYSTEM_001',
      'Unknown error occurred',
      'SYSTEM',
      { originalError: String(error) },
      requestId
    );
  }
}

// Predefined errors
export class ResourceNotFoundError extends ShellServerError {
  constructor(resourceType: string, id: string, requestId?: string) {
    super(
      'RESOURCE_001',
      `${resourceType} with ID ${id} not found`,
      'RESOURCE',
      { resourceType, id },
      requestId
    );
  }
}

export class ExecutionError extends ShellServerError {
  constructor(message: string, details?: Record<string, unknown>, requestId?: string) {
    super('EXECUTION_001', message, 'EXECUTION', details, requestId);
  }
}

export class TimeoutError extends ShellServerError {
  constructor(timeoutSeconds: number, requestId?: string) {
    super(
      'EXECUTION_002',
      `Operation timed out after ${timeoutSeconds} seconds`,
      'EXECUTION',
      { timeoutSeconds },
      requestId
    );
  }
}

export class SecurityError extends ShellServerError {
  constructor(message: string, details?: Record<string, unknown>, requestId?: string) {
    super('SECURITY_001', message, 'SECURITY', details, requestId);
  }
}

export class ResourceLimitError extends ShellServerError {
  constructor(resource: string, limit: number, requestId?: string) {
    super(
      'RESOURCE_005',
      `${resource} limit of ${limit} reached`,
      'RESOURCE',
      { resource, limit },
      requestId
    );
  }
}

export const MCPShellError = ShellServerError;

