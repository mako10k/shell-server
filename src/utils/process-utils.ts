import * as fs from 'fs';
import * as path from 'path';
import { IPty } from 'node-pty';
import { SystemProcessInfo, ForegroundProcessInfo } from '../types/index.js';

export class ProcessUtils {
  private static processInfoCache = new Map<
    number,
    { info: SystemProcessInfo; timestamp: number }
  >();
  private static readonly CACHE_TTL = 1000; // 1 second cache

  /**
   * Retrieve process information
   */
  static async getProcessInfo(pid: number): Promise<SystemProcessInfo | null> {
    // Check cache
    const cached = this.processInfoCache.get(pid);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.info;
    }

    try {
      const statPath = `/proc/${pid}/stat`;
      const commPath = `/proc/${pid}/comm`;
      const exePath = `/proc/${pid}/exe`;

      // Check if process exists
      if (!fs.existsSync(statPath)) {
        return null;
      }

      // Retrieve session information from /proc/{pid}/stat
      const statContent = fs.readFileSync(statPath, 'utf8');
      const statFields = statContent.split(' ');

      if (statFields.length < 22) {
        return null;
      }

      const sessionId = parseInt(statFields[5] || '0');
      const parentPid = parseInt(statFields[3] || '0');

      // Get process name
      let name = 'unknown';
      try {
        name = fs.readFileSync(commPath, 'utf8').trim();
      } catch {
        // fallback: extract process name from stat
        const procName = statFields[1];
        if (procName) {
          const commMatch = procName.match(/^\((.+)\)$/);
          if (commMatch && commMatch[1]) {
            name = commMatch[1];
          }
        }
      }

      // Resolve full path (resolve symlink)
      let fullPath: string | undefined;
      try {
        fullPath = fs.readlinkSync(exePath);
      } catch {
        // If path cannot be resolved, leave undefined
      }

      const processInfo: SystemProcessInfo = {
        pid,
        name,
        isSessionLeader: sessionId === pid,
      };

      // Add optional properties
      if (fullPath) {
        processInfo.path = fullPath;
      }
      if (sessionId > 0) {
        processInfo.sessionId = sessionId;
      }
      if (parentPid > 0) {
        processInfo.parentPid = parentPid;
      }

      // Save to cache
      this.processInfoCache.set(pid, {
        info: processInfo,
        timestamp: Date.now(),
      });

      return processInfo;
    } catch (error) {
      console.error(`Failed to get process info for PID ${pid}:`, error);
      return null;
    }
  }

  /**
   * Get the terminal's foreground process
   */
  static async getForegroundProcess(terminalPty: IPty): Promise<ForegroundProcessInfo> {
    try {
      // Obtain PTY file descriptor
      const ptyWithFd = terminalPty as IPty & { _fd?: number; fd?: number };
      const fd = ptyWithFd._fd || ptyWithFd.fd;
      if (!fd) {
        return {
          available: false,
          error: 'PTY file descriptor not available',
        };
      }

      // Use /proc/tty/drivers as an alternative to tcgetpgrp()
      // First, determine the PTY device number
      let foregroundPid: number | null = null;

      try {
        // More direct approach: inspect PTY process group
        const ptyProcess = terminalPty.pid;
        if (ptyProcess) {
          // Find child processes and treat the most recently created as the foreground
          foregroundPid = await this.findLatestChildProcess(ptyProcess);
        }
      } catch (error) {
        console.error('Failed to get foreground process:', error);
      }

      if (!foregroundPid) {
        return {
          available: false,
          error: 'Could not determine foreground process',
        };
      }

      const processInfo = await this.getProcessInfo(foregroundPid);
      if (!processInfo) {
        return {
          available: false,
          error: `Process ${foregroundPid} not found`,
        };
      }

      return {
        process: processInfo,
        available: true,
      };
    } catch (error) {
      return {
        available: false,
        error: `Error getting foreground process: ${error}`,
      };
    }
  }

  /**
   * Find the most recently created child process for a given PID
   */
  private static async findLatestChildProcess(parentPid: number): Promise<number | null> {
    try {
      const procDir = '/proc';
      const entries = fs.readdirSync(procDir);

      let latestChild: { pid: number; startTime: number } | null = null;

      for (const entry of entries) {
        const pid = parseInt(entry);
        if (isNaN(pid)) continue;

        try {
          const statPath = path.join(procDir, entry, 'stat');
          const statContent = fs.readFileSync(statPath, 'utf8');
          const statFields = statContent.split(' ');

          if (statFields.length < 22) continue;

          const ppid = parseInt(statFields[3] || '0');
          if (ppid === parentPid) {
            // child process found
            const startTime = parseInt(statFields[21] || '0');
            if (!latestChild || startTime > latestChild.startTime) {
              latestChild = { pid, startTime };
            }
          }
        } catch {
          // skip this process
          continue;
        }
      }

      return latestChild ? latestChild.pid : null;
    } catch (error) {
      console.error('Error finding child processes:', error);
      return null;
    }
  }

  /**
   * Check program guard conditions
   */
  static checkProgramGuard(processInfo: SystemProcessInfo | undefined, sendTo: string): boolean {
    if (sendTo === '*') {
      return true; // no condition
    }

    if (!processInfo) {
      return false; // deny if process information is not available
    }

    // Session leader check
    if (sendTo === 'sessionleader:' || sendTo === 'loginshell:') {
      return processInfo.isSessionLeader;
    }

    // PID check
    if (sendTo.startsWith('pid:')) {
      const targetPid = parseInt(sendTo.substring(4));
      return processInfo.pid === targetPid;
    }

    // Full path check
    if (sendTo.startsWith('/')) {
      return processInfo.path === sendTo;
    }

    // Process name check
    return processInfo.name === sendTo;
  }

  /**
   * Clear the cache
   */
  static clearCache(): void {
    this.processInfoCache.clear();
  }

  /**
   * Remove stale cache entries
   */
  static cleanupCache(): void {
    const now = Date.now();
    for (const [pid, cached] of this.processInfoCache.entries()) {
      if (now - cached.timestamp > this.CACHE_TTL * 2) {
        this.processInfoCache.delete(pid);
      }
    }
  }
}
