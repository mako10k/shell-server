import { MonitorInfo, SystemStats } from '../types/index.js';
import { generateId, getCurrentTimestamp, getSystemInfo } from '../utils/helpers.js';
import { ResourceNotFoundError } from '../utils/errors.js';

interface ProcessMetrics {
  cpu_usage_percent?: number;
  memory_usage_mb?: number;
  io_read_bytes?: number;
  io_write_bytes?: number;
  network_rx_bytes?: number;
  network_tx_bytes?: number;
}

export class MonitoringManager {
  private monitors = new Map<string, MonitorInfo>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private processMetrics = new Map<number, ProcessMetrics[]>();
  private systemMonitoringInterval: NodeJS.Timeout | null = null;
  private readonly maxMetricsHistory = 1000;

  constructor() {
    // Start periodic collection of system statistics
    this.startSystemMonitoring();
  }

  /**
   * Helper to execute an exec command for retrieving process information
   */
  private async getExecAsync() {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    return promisify(exec);
  }

  startProcessMonitor(
    processId: number,
    intervalMs = 1000,
    includeMetrics?: string[]
  ): MonitorInfo {
    const monitorId = generateId();
    const now = getCurrentTimestamp();

    const monitorInfo: MonitorInfo = {
      monitor_id: monitorId,
      process_id: processId,
      status: 'active',
      started_at: now,
      last_update: now,
      metrics: {},
    };

    this.monitors.set(monitorId, monitorInfo);

    // Start metrics collection
    const interval = setInterval(() => {
      this.collectProcessMetrics(monitorId, processId, includeMetrics);
    }, intervalMs);

    this.intervals.set(monitorId, interval);

    return { ...monitorInfo };
  }

  private async collectProcessMetrics(
    monitorId: string,
    processId: number,
    includeMetrics?: string[]
  ): Promise<void> {
    const monitor = this.monitors.get(monitorId);
    if (!monitor) return;

    try {
      const metrics: ProcessMetrics = {};

      // Measure CPU usage
      if (!includeMetrics || includeMetrics.includes('cpu')) {
        metrics.cpu_usage_percent = await this.getCpuUsage(processId);
      }

      // Measure memory usage
      if (!includeMetrics || includeMetrics.includes('memory')) {
        metrics.memory_usage_mb = await this.getMemoryUsage(processId);
      }

      // Measure I/O statistics
      if (!includeMetrics || includeMetrics.includes('io')) {
        const ioStats = await this.getIoStats(processId);
        metrics.io_read_bytes = ioStats.read_bytes;
        metrics.io_write_bytes = ioStats.write_bytes;
      }

      // Measure network statistics
      if (!includeMetrics || includeMetrics.includes('network')) {
        const networkStats = await this.getNetworkStats(processId);
        metrics.network_rx_bytes = networkStats.rx_bytes;
        metrics.network_tx_bytes = networkStats.tx_bytes;
      }

      // Store metrics
      this.storeProcessMetrics(processId, metrics);

      // Update monitor information
      monitor.metrics = metrics;
      monitor.last_update = getCurrentTimestamp();
      this.monitors.set(monitorId, monitor);
    } catch (error) {
      // Record error to internal log (avoid stdout)
      // console.error(`Failed to collect metrics for process ${processId}:`, error);

      // Stop monitoring on error
      this.stopProcessMonitor(monitorId);
    }
  }

  private async getCpuUsage(processId: number): Promise<number> {
    try {
      // Platform-specific CPU usage retrieval
      if (process.platform === 'linux') {
        return await this.getLinuxCpuUsage(processId);
      } else if (process.platform === 'darwin') {
        return await this.getMacOsCpuUsage(processId);
      } else {
        return 0; // Simplified implementation for Windows, etc.
      }
    } catch {
      return 0;
    }
  }

  private async getLinuxCpuUsage(processId: number): Promise<number> {
    try {
      const execAsync = await this.getExecAsync();

      const { stdout } = await execAsync(`ps -p ${processId} -o %cpu --no-headers`);
      return parseFloat(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  private async getMacOsCpuUsage(processId: number): Promise<number> {
    try {
      const execAsync = await this.getExecAsync();

      const { stdout } = await execAsync(`ps -p ${processId} -o %cpu`);
      const lines = stdout.trim().split('\n');
      if (lines.length > 1 && lines[1]) {
        return parseFloat(lines[1].trim()) || 0;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private async getMemoryUsage(processId: number): Promise<number> {
    try {
      if (process.platform === 'linux') {
        return await this.getLinuxMemoryUsage(processId);
      } else if (process.platform === 'darwin') {
        return await this.getMacOsMemoryUsage(processId);
      } else {
        return 0;
      }
    } catch {
      return 0;
    }
  }

  private async getLinuxMemoryUsage(processId: number): Promise<number> {
    try {
      const execAsync = await this.getExecAsync();

      const { stdout } = await execAsync(`ps -p ${processId} -o rss --no-headers`);
      const rssKb = parseInt(stdout.trim()) || 0;
      return rssKb / 1024; // convert to MB
    } catch {
      return 0;
    }
  }

  private async getMacOsMemoryUsage(processId: number): Promise<number> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const { stdout } = await execAsync(`ps -p ${processId} -o rss`);
      const lines = stdout.trim().split('\n');
      if (lines.length > 1 && lines[1]) {
        const rssKb = parseInt(lines[1].trim()) || 0;
        return rssKb / 1024; // convert to MB
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private async getIoStats(
    processId: number
  ): Promise<{ read_bytes: number; write_bytes: number }> {
    try {
      if (process.platform === 'linux') {
        const fs = await import('fs/promises');
        const ioData = await fs.readFile(`/proc/${processId}/io`, 'utf-8');

        let readBytes = 0;
        let writeBytes = 0;

        for (const line of ioData.split('\n')) {
          if (line.startsWith('read_bytes:')) {
            readBytes = parseInt(line.split(':')[1]?.trim() || '0');
          } else if (line.startsWith('write_bytes:')) {
            writeBytes = parseInt(line.split(':')[1]?.trim() || '0');
          }
        }

        return { read_bytes: readBytes, write_bytes: writeBytes };
      }
    } catch {
      // Return default values on error
    }

    return { read_bytes: 0, write_bytes: 0 };
  }

  private async getNetworkStats(
    _processId: number
  ): Promise<{ rx_bytes: number; tx_bytes: number }> {
    // Network stats collection is complex; using a simplified implementation here
    return { rx_bytes: 0, tx_bytes: 0 };
  }

  private storeProcessMetrics(processId: number, metrics: ProcessMetrics): void {
    if (!this.processMetrics.has(processId)) {
      this.processMetrics.set(processId, []);
    }

    const metricsHistory = this.processMetrics.get(processId);
    if (metricsHistory) {
      metricsHistory.push(metrics);

      // Limit history size
      if (metricsHistory.length > this.maxMetricsHistory) {
        metricsHistory.shift();
      }
    }
  }

  stopProcessMonitor(monitorId: string): boolean {
    const monitor = this.monitors.get(monitorId);
    if (!monitor) {
      throw new ResourceNotFoundError('monitor', monitorId);
    }

    // Stop the interval
    const interval = this.intervals.get(monitorId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(monitorId);
    }

    // Update monitoring status
    monitor.status = 'stopped';
    monitor.last_update = getCurrentTimestamp();
    this.monitors.set(monitorId, monitor);

    return true;
  }

  getMonitor(monitorId: string): MonitorInfo {
    const monitor = this.monitors.get(monitorId);
    if (!monitor) {
      throw new ResourceNotFoundError('monitor', monitorId);
    }
    return { ...monitor };
  }

  listMonitors(): MonitorInfo[] {
    return Array.from(this.monitors.values()).map((monitor) => ({ ...monitor }));
  }

  getSystemStats(_timeRangeMinutes = 60): SystemStats {
    const systemInfo = getSystemInfo();
    // const processInfo = getProcessInfo(); // currently unused

    const stats: SystemStats = {
      active_processes: this.getActiveProcessCount(),
      active_terminals: 0, // needs to be obtained from TerminalManager
      total_files: 0, // needs to be obtained from FileManager
      system_load: {
        load1: systemInfo.loadavg[0] || 0,
        load5: systemInfo.loadavg[1] || 0,
        load15: systemInfo.loadavg[2] || 0,
      },
      memory_usage: {
        total_mb: Math.round(systemInfo.totalmem / 1024 / 1024),
        used_mb: Math.round((systemInfo.totalmem - systemInfo.freemem) / 1024 / 1024),
        free_mb: Math.round(systemInfo.freemem / 1024 / 1024),
        available_mb: Math.round(systemInfo.freemem / 1024 / 1024), // simplified implementation
      },
      uptime_seconds: Math.round(systemInfo.uptime),
      collected_at: getCurrentTimestamp(),
    };

    return stats;
  }

  private getActiveProcessCount(): number {
    return Array.from(this.monitors.values()).filter((monitor) => monitor.status === 'active')
      .length;
  }

  private startSystemMonitoring(): void {
    // Collect system statistics every 5 minutes
    this.systemMonitoringInterval = setInterval(
      () => {
        try {
          // In future, write system stats to a log file
          const stats = this.getSystemStats();
          this.logSystemStats(stats);
        } catch (error) {
          // Record error to internal log (avoid stdout)
          // console.error('Failed to collect system stats:', error);
        }
      },
      5 * 60 * 1000
    );

    // Prevent interfering with shutdown
    this.systemMonitoringInterval.unref?.();
  }

  private logSystemStats(_stats: SystemStats): void {
    // In future, output to a log file (avoid stdout)
    // console.log(`[${stats.collected_at}] System Stats:`, {
    //   processes: stats.active_processes,
    //   load: stats.system_load.load1,
    //   memory_used_mb: stats.memory_usage.used_mb,
    // });
  }

  cleanup(): void {
    if (this.systemMonitoringInterval) {
      clearInterval(this.systemMonitoringInterval);
      this.systemMonitoringInterval = null;
    }

    // Stop all monitors
    for (const monitorId of this.monitors.keys()) {
      try {
        this.stopProcessMonitor(monitorId);
      } catch (error) {
        // Record error to internal log (avoid stdout)
        // console.error(`Failed to stop monitor ${monitorId}:`, error);
      }
    }

    this.monitors.clear();
    this.intervals.clear();
    this.processMetrics.clear();
  }
}
