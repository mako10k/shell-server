import { z } from 'zod';

// Execution modes
export const ExecutionModeSchema = z.enum(['foreground', 'background', 'detached', 'adaptive']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

// Execution status
const ExecutionStatusSchema = z.enum(['completed', 'running', 'failed', 'timeout']);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

// Shell types
export const ShellTypeSchema = z.enum(['bash', 'zsh', 'fish', 'cmd', 'powershell']);
export type ShellType = z.infer<typeof ShellTypeSchema>;

// Terminal status
const TerminalStatusSchema = z.enum(['active', 'idle', 'closed']);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

// Signals
export const ProcessSignalSchema = z.enum(['TERM', 'KILL', 'INT', 'HUP', 'USR1', 'USR2']);
export type ProcessSignal = z.infer<typeof ProcessSignalSchema>;

// Output types
export const OutputTypeSchema = z.enum(['stdout', 'stderr', 'combined', 'log', 'all']);
export type OutputType = z.infer<typeof OutputTypeSchema>;

// Error categories
const ErrorCategorySchema = z.enum([
  'AUTH',
  'PARAM',
  'RESOURCE',
  'EXECUTION',
  'SYSTEM',
  'SECURITY',
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

// Basic schemas
export const EnvironmentVariablesSchema = z
  .record(z.string(), z.string())
  .describe('Environment variables');
export type EnvironmentVariables = z.infer<typeof EnvironmentVariablesSchema>;

export const DimensionsSchema = z
  .object({
    width: z.number().int().min(1).max(500).describe('Width in characters'),
    height: z.number().int().min(1).max(200).describe('Height in lines'),
  })
  .describe('Terminal dimensions');
export type Dimensions = z.infer<typeof DimensionsSchema>;

// Output truncation reasons
export type OutputTruncationReason =
  | 'size_limit'
  | 'timeout'
  | 'user_interrupt'
  | 'error'
  | 'background_transition';

// Output status information
export interface OutputStatus {
  complete: boolean;
  reason?: OutputTruncationReason;
  available_via_output_id: boolean;
  recommended_action?: string | undefined;
}

// Issue #14: Guidance information type definitions
export interface GuidanceInfo {
  pipeline_usage: string;
  suggested_commands: string[];
  background_processing?: {
    status_check: string;
    monitoring: string;
  };
}

// Execution information
export interface ExecutionInfo {
  execution_id: string;
  command: string;
  status: ExecutionStatus;
  exit_code?: number;
  process_id?: number;
  working_directory?: string;
  default_working_directory?: string;
  working_directory_changed?: boolean;
  environment_variables?: EnvironmentVariables;
  execution_time_ms?: number;
  memory_usage_mb?: number;
  cpu_usage_percent?: number;
  stdout?: string;
  stderr?: string;
  output_truncated?: boolean; // kept for backward compatibility
  output_status?: OutputStatus; // new detailed output status
  output_id?: string;
  terminal_id?: string;
  transition_reason?: 'foreground_timeout' | 'output_size_limit'; // reason for transition to background in adaptive mode
  truncation_reason?: OutputTruncationReason; // specific reason for output truncation
  next_steps?: string[]; // recommended actions for LLM
  message?: string; // status explanation message
  guidance?: GuidanceInfo; // Issue #14: Pipeline processing guidance
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

// System process info (for foreground processes)
export interface SystemProcessInfo {
  pid: number;
  name: string;
  path?: string;
  sessionId?: number;
  isSessionLeader: boolean;
  parentPid?: number;
}

// Program guard settings
export const ProgramGuardSchema = z.object({
  sendTo: z.string(), // "bash", "/bin/bash", "pid:12345", "sessionleader:", "*"
});
export type ProgramGuard = z.infer<typeof ProgramGuardSchema>;

// Foreground process info
export interface ForegroundProcessInfo {
  process?: SystemProcessInfo;
  available: boolean;
  error?: string;
}

// Terminal info
export interface TerminalInfo {
  terminal_id: string;
  session_name?: string;
  shell_type: ShellType;
  dimensions: Dimensions;
  process_id: number;
  status: TerminalStatus;
  working_directory: string;
  created_at: string;
  last_activity: string;
  foreground_process?: ForegroundProcessInfo;
}

// Output file info
export interface FileInfo {
  output_id: string;
  output_type: OutputType;
  name: string;
  size: number;
  execution_id?: string;
  created_at: string;
  path: string;
  subscribed?: boolean;
}

// Monitor info
export interface MonitorInfo {
  monitor_id: string;
  process_id: number;
  status: 'active' | 'stopped';
  started_at: string;
  last_update: string;
  metrics: {
    cpu_usage_percent?: number;
    memory_usage_mb?: number;
    io_read_bytes?: number;
    io_write_bytes?: number;
    network_rx_bytes?: number;
    network_tx_bytes?: number;
  };
}

// System statistics
export interface SystemStats {
  active_processes: number;
  active_terminals: number;
  total_files: number;
  system_load: {
    load1: number;
    load5: number;
    load15: number;
  };
  memory_usage: {
    total_mb: number;
    used_mb: number;
    free_mb: number;
    available_mb: number;
  };
  uptime_seconds: number;
  collected_at: string;
}

// Error info
export interface ErrorInfo {
  code: string;
  message: string;
  category: ErrorCategory;
  details?: Record<string, unknown>;
  timestamp: string;
  request_id?: string;
}

// Security restrictions
export interface SecurityRestrictions {
  restriction_id: string;
  security_mode: SecurityMode;

  // only effective in custom mode
  allowed_commands?: string[];
  blocked_commands?: string[];
  allowed_directories?: string[];

  // common settings
  max_execution_time?: number;
  max_memory_mb?: number;
  enable_network?: boolean;

  active: boolean;
  configured_at: string;
}

// Security modes
export const SecurityModeSchema = z.enum([
  'permissive',
  'moderate',
  'restrictive',
  'custom',
  'enhanced',
  'enhanced-fast',
]);
export type SecurityMode = z.infer<typeof SecurityModeSchema>;

// Execution process info (for Process Manager)
export interface ExecutionProcessInfo {
  process_id: number;
  execution_id: string;
  command: string;
  status: ExecutionStatus;
  created_at: string;
  working_directory?: string;
  environment_variables?: EnvironmentVariables;
  started_at?: string;
  completed_at?: string;
}

// Elicitation Result interface
export interface ElicitationResult {
  status: 'timeout' | 'canceled' | 'confirmed' | 'declined';
  user_response?: Record<string, unknown> | undefined;
  timeout_duration_ms?: number;
  question_asked: string;
  timestamp: string;
  comment?: string;  // include if user provided a comment
}

// Safety Evaluation Result Classes
//
// Design principles:
// 1. Classes represent final responses only (exclude user_confirm, add_more_history)
// 2. Type safety via base class + subclasses
// 3. Use factory pattern for creation
// 4. Encapsulate conversion logic in response-generation methods

// Base class - minimal common fields
export abstract class SafetyEvaluationResult {
  protected reasoning: string;
  protected llm_evaluation_used?: boolean | undefined;
  protected elicitation_result?: ElicitationResult | undefined;
  
  constructor(reasoning: string, llmEvaluationUsed?: boolean, elicitationResult?: ElicitationResult) {
    this.reasoning = reasoning;
    this.llm_evaluation_used = llmEvaluationUsed;
    this.elicitation_result = elicitationResult;
  }
  
  // Response generation method (abstract)
  abstract generateToolResponse(): unknown;
  abstract getEvaluationResult(): string;
}

// Base class for completed confirmation processes
export abstract class SafetyEvaluationCompletedResult extends SafetyEvaluationResult {
  protected confirmation_message?: string | undefined;
  protected user_response?: Record<string, unknown> | undefined;
  
  constructor(
    reasoning: string, 
    llmEvaluationUsed?: boolean,
    elicitationResult?: ElicitationResult,
    confirmationMessage?: string,
    userResponse?: Record<string, unknown>
  ) {
    super(reasoning, llmEvaluationUsed, elicitationResult);
    this.confirmation_message = confirmationMessage;
    this.user_response = userResponse;
  }

  protected buildCommonResponse(): Record<string, unknown> {
    return {
      reasoning: this.reasoning,
      llm_evaluation_used: this.llm_evaluation_used,
      confirmation_message: this.confirmation_message,
      user_response: this.user_response,
      elicitation_result: this.elicitation_result
    };
  }
}

// Allow result class - when execution is permitted
export class SafetyEvaluationAllowResult extends SafetyEvaluationCompletedResult {
  private suggested_alternatives?: string[] | undefined;
  private context_analysis?: unknown;
  private next_action?: string | undefined;
  
  constructor(
    reasoning: string,
    llmEvaluationUsed?: boolean,
    elicitationResult?: ElicitationResult,
    suggestedAlternatives?: string[],
    contextAnalysis?: unknown,
    nextAction?: string,
    confirmationMessage?: string,
    userResponse?: Record<string, unknown>
  ) {
    super(reasoning, llmEvaluationUsed, elicitationResult, confirmationMessage, userResponse);
    this.suggested_alternatives = suggestedAlternatives;
    this.context_analysis = contextAnalysis;
    this.next_action = nextAction;
  }
  
  getEvaluationResult(): string { return 'allow'; }
  
  generateToolResponse() {
    return {
      evaluation_result: 'allow',
      ...this.buildCommonResponse(),
      suggested_alternatives: this.suggested_alternatives,
      context_analysis: this.context_analysis,
      next_action: this.next_action,
    };
  }
}

// Deny result class - when execution is denied
export class SafetyEvaluationDenyResult extends SafetyEvaluationCompletedResult {
  private suggested_alternatives?: string[] | undefined;
  private next_action?: string | undefined;
  
  constructor(
    reasoning: string,
    llmEvaluationUsed?: boolean,
    elicitationResult?: ElicitationResult,
    suggestedAlternatives?: string[],
    nextAction?: string,
    confirmationMessage?: string,
    userResponse?: Record<string, unknown>
  ) {
    super(reasoning, llmEvaluationUsed, elicitationResult, confirmationMessage, userResponse);
    this.suggested_alternatives = suggestedAlternatives;
    this.next_action = nextAction;
  }
  
  getEvaluationResult(): string { return 'deny'; }
  
  generateToolResponse() {
    return {
      evaluation_result: 'deny',
      ...this.buildCommonResponse(),
      suggested_alternatives: this.suggested_alternatives,
      next_action: this.next_action,
    };
  }
}

// AiAssistantConfirm result class - AI assistant confirmation required
export class SafetyEvaluationAiAssistantConfirmResult extends SafetyEvaluationCompletedResult {
  private suggested_alternatives?: string[] | undefined;
  private context_analysis?: unknown;
  private next_action: {
    instruction: string;
    method: string;
    expected_outcome: string;
    executable_commands?: string[];
  };
  
  constructor(
    reasoning: string,
    nextAction: {
      instruction: string;
      method: string;
      expected_outcome: string;
      executable_commands?: string[];
    },
    llmEvaluationUsed?: boolean,
    elicitationResult?: ElicitationResult,
    suggestedAlternatives?: string[],
    contextAnalysis?: unknown,
    confirmationMessage?: string,
    userResponse?: Record<string, unknown>
  ) {
    super(reasoning, llmEvaluationUsed, elicitationResult, confirmationMessage, userResponse);
    this.next_action = nextAction;
    this.suggested_alternatives = suggestedAlternatives;
    this.context_analysis = contextAnalysis;
  }
  
  getEvaluationResult(): string { return 'ai_assistant_confirm'; }
  
  generateToolResponse() {
    return {
      evaluation_result: 'ai_assistant_confirm',
      ...this.buildCommonResponse(),
      suggested_alternatives: this.suggested_alternatives,
      context_analysis: this.context_analysis,
      next_action: this.next_action,
    };
  }
}

// Factory class
export class SafetyEvaluationResultFactory {
  static createAllow(
    reasoning: string,
    options: {
      llmEvaluationUsed?: boolean;
      elicitationResult?: ElicitationResult | undefined;
      suggestedAlternatives?: string[] | undefined;
      contextAnalysis?: unknown;
      nextAction?: string | undefined;
      confirmationMessage?: string | undefined;
      userResponse?: Record<string, unknown> | undefined;
    } = {}
  ): SafetyEvaluationAllowResult {
    return new SafetyEvaluationAllowResult(
      reasoning,
      options.llmEvaluationUsed,
      options.elicitationResult,
      options.suggestedAlternatives,
      options.contextAnalysis,
      options.nextAction,
      options.confirmationMessage,
      options.userResponse
    );
  }
  
  static createDeny(
    reasoning: string,
    options: {
      llmEvaluationUsed?: boolean;
      elicitationResult?: ElicitationResult | undefined;
      suggestedAlternatives?: string[] | undefined;
      nextAction?: string | undefined;
      confirmationMessage?: string | undefined;
      userResponse?: Record<string, unknown> | undefined;
    } = {}
  ): SafetyEvaluationDenyResult {
    return new SafetyEvaluationDenyResult(
      reasoning,
      options.llmEvaluationUsed,
      options.elicitationResult,
      options.suggestedAlternatives,
      options.nextAction,
      options.confirmationMessage,
      options.userResponse
    );
  }
  
  static createAiAssistantConfirm(
    reasoning: string,
    nextAction: {
      instruction: string;
      method: string;
      expected_outcome: string;
      executable_commands?: string[];
    },
    options: {
      llmEvaluationUsed?: boolean;
      elicitationResult?: ElicitationResult | undefined;
      suggestedAlternatives?: string[] | undefined;
      contextAnalysis?: unknown;
      confirmationMessage?: string | undefined;
      userResponse?: Record<string, unknown> | undefined;
    } = {}
  ): SafetyEvaluationAiAssistantConfirmResult {
    return new SafetyEvaluationAiAssistantConfirmResult(
      reasoning,
      nextAction,
      options.llmEvaluationUsed,
      options.elicitationResult,
      options.suggestedAlternatives,
      options.contextAnalysis,
      options.confirmationMessage,
      options.userResponse
    );
  }
}
