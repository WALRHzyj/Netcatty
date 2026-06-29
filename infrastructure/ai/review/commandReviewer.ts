import { generateText } from 'ai';

/**
 * Risk level assigned to a shell command by the review AI.
 *
 * - safe:      read-only or informational, no side effects → auto-approve
 * - caution:   may have impact but not immediately catastrophic → confirm
 * - dangerous: destructive or irreversible → auto-deny
 */
export type ReviewRisk = 'safe' | 'caution' | 'dangerous';

export interface ReviewResult {
  risk: ReviewRisk;
  reason: string;
}

// ---------------------------------------------------------------------------
// Quick pre-filter — catches obviously-safe commands without an AI round-trip.
// These are common read-only diagnostics that the blocklist already won't
// flag but that the review AI might conservatively mark as caution.
// ---------------------------------------------------------------------------

/** Known read-only binaries — no side effects, safe to execute. */
const SAFE_BINARIES = new Set([
  // File / directory listing
  'ls', 'dir', 'tree', 'stat', 'file', 'realpath', 'readlink',
  // Content viewing
  'cat', 'head', 'tail', 'less', 'more', 'nl', 'od', 'hexdump', 'xxd',
  // Searching
  'grep', 'egrep', 'fgrep', 'find', 'locate', 'which', 'whereis', 'type',
  // System info
  'uname', 'hostname', 'hostnamectl', 'uptime', 'date', 'cal', 'who', 'w',
  'whoami', 'id', 'groups', 'env', 'printenv', 'locale', 'ulimit',
  // Process info
  'ps', 'pgrep', 'pidof', 'top', 'htop', 'pstree',
  // Disk / device info (READ-ONLY variants)
  'df', 'du', 'lsblk', 'blkid', 'findmnt', 'mount', 'losetup',
  // Hardware info
  'lscpu', 'lsmem', 'lsusb', 'lspci', 'lshw', 'dmidecode',
  // Network diagnostics (read-only)
  'ping', 'ping6', 'traceroute', 'traceroute6', 'tracepath', 'dig', 'nslookup',
  'host', 'ss', 'netstat', 'ip', 'ifconfig', 'iwconfig', 'ethtool',
  // Package queries
  'dpkg-query', 'rpm', 'apk', 'snap', 'flatpak',
  // Git read-only
  'git',
]);
/** Commands that are safe ONLY with read-only flags. */
const SAFE_BINARIES_READONLY_FLAGS = new Set([
  'systemctl', 'service', 'journalctl', 'docker', 'kubectl', 'podman',
  'apt-cache', 'apt', 'apt-get', 'yum', 'dnf', 'zypper', 'brew', 'pacman',
  'pip', 'pip3', 'npm', 'cargo',
]);

/** Flags that indicate read-only intent. */
const READONLY_FLAGS = /^--?(help|version|list|info|query|search|show|get|cat|inspect|logs|events|display|print|check|verify|test|status|history|config)\b/i;

function resolveMainCommand(command: string): string {
  // Strip leading variable assignments, env overrides, and sudo.
  let cmd = command.replace(/^\s*(?:sudo\s+)*/, '');
  cmd = cmd.replace(/^[A-Za-z_][\w]*=\S+\s+/, ''); // FOO=bar cmd
  // Take the first word (accounting for paths like /usr/bin/ls)
  const match = cmd.match(/^([^\s|;&]+)/);
  if (!match) return '';
  const bin = match[1];
  // Strip path prefix, keep basename
  return bin.replace(/^.*\//, '');
}

/**
 * Quick heuristic: is this command OBVIOUSLY read-only?
 * Only returns true when we're very confident — false means "need AI review".
 */
function looksObviouslySafe(command: string): boolean {
  const main = resolveMainCommand(command);
  if (!main) return false;

  // Known safe binary
  if (SAFE_BINARIES.has(main)) return true;

  // Binary that's safe only with read-only flags
  if (SAFE_BINARIES_READONLY_FLAGS.has(main)) {
    // Check if the command uses read-only flags/subcommands
    const afterCmd = command.slice(command.indexOf(main) + main.length);
    const firstArg = afterCmd.trim().split(/\s+/)[0] || '';
    if (READONLY_FLAGS.test(firstArg) || READONLY_FLAGS.test('-' + firstArg)) {
      return true;
    }
    // Also check for subcommands like "docker ps", "kubectl get"
    const knownSafeSubcommands = /^(ps|inspect|logs|images|info|version|get|describe|explain|top|events)\b/i;
    if (knownSafeSubcommands.test(firstArg)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Review system prompt — kept concise to minimise per-review token cost.
// ---------------------------------------------------------------------------
const REVIEW_SYSTEM_PROMPT = [
  '你是命令安全审查助手。严格按以下标准评估风险，只返回 JSON：',
  '',
  'safe — 无破坏性（只读 / 查询 / 诊断）：',
  '  文件/目录查看：cat, less, head, tail, grep, find, ls, tree, stat, file',
  '  磁盘/设备查询：df, du, lsblk, blkid, findmnt, mount（无参数）, losetup -l',
  '  系统信息：uname, hostname, uptime, who, w, date, ps, top, free, vmstat, iostat',
  '  网络诊断：ping, traceroute, dig, nslookup, ss -tlnp, netstat, ip addr/show, curl -I/HEAD',
  '  硬件查询：lscpu, lsmem, lsusb, lspci, dmidecode -t',
  '  服务状态：systemctl status, service status, journalctl（只读）',
  '  容器/K8s只读：docker ps/inspect/logs/images, kubectl get/describe/logs',
  '  Git只读：log, status, diff, show, 任何 --help/--version 命令',
  '  包查询：apt-cache search/show, yum list/info, brew info/search, pip show/list',
  '  注意：2>/dev/null 静默错误输出、|| 回退到安全命令，这些不改变风险等级',
  '',
  'caution — 有影响但非灾难：',
  '  文件修改（sed -i, awk 写入, tee, 重定向>写入非系统文件）',
  '  包安装/更新（apt-get install, yum install, pip install, npm install）',
  '  服务变更（systemctl start/stop/restart, service restart）',
  '  进程管理（kill, pkill）, 用户管理（useradd, usermod）, 文件权限修改',
  '  Docker变更（restart/stop/start/exec, 非特权的docker run）',
  '',
  'dangerous — 显著破坏性：',
  '  递归强删（rm -rf, find -delete）, 磁盘格式化（mkfs, fdisk 写入, parted 写入, dd 写磁盘）',
  '  关机重启（shutdown, reboot, halt, poweroff）, fork炸弹/资源耗尽',
  '  权限开放（chmod 777 -R /, chmod -R 777 系统目录）',
  '  数据库破坏（DROP DATABASE/TABLE, TRUNCATE）',
  '  防火墙清空（iptables -F/-X, ufw disable）',
  '  编码混淆命令（base64 -d, eval, xxd -r）, sudo 配合危险操作',
  '  覆盖系统关键文件（> /etc/passwd, > /etc/shadow）',
  '',
  '返回格式（只返回 JSON，不要其他内容）：',
  '{"risk":"safe|caution|dangerous","reason":"30字以内中文理由"}',
].join('\n');

/** Max tokens the review model may produce — a risk JSON object fits in ~50. */
const REVIEW_MAX_TOKENS = 120;

/** Hard timeout for a single review call. Beyond this the review fails open (→ caution). */
const REVIEW_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Model type — matches the return type of createModelFromConfig.
// ---------------------------------------------------------------------------
export interface ReviewModel {
  readonly modelId: string;
  readonly provider: string;
  doGenerate?: (...args: any[]) => Promise<any>;
  doStream?: (...args: any[]) => Promise<any>;
}

// ---------------------------------------------------------------------------
// CommandReviewSession
// ---------------------------------------------------------------------------

/**
 * A long-lived review session that reuses a single model instance and grows a
 * conversation transcript so the model remembers the classification framework
 * across multiple commands without re-sending the full system prompt every call.
 *
 * Usage:
 * ```ts
 * const session = new CommandReviewSession(model);
 * const result = await session.review('rm -rf /tmp/cache');
 * // result.risk === 'caution' | 'safe' | 'dangerous'
 * ```
 */
export class CommandReviewSession {
  private readonly model: ReviewModel;
  /** Accumulated conversation — first message is the system prompt. */
  private transcript: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  /** Keep the transcript bounded so it never grows unbounded. */
  private static readonly MAX_TRANSCRIPT_TURNS = 20;

  constructor(model: ReviewModel) {
    this.model = model;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Review a shell command for risk.
   *
   * A quick heuristic pre-filter catches obviously-safe commands (known
   * read-only binaries) without an AI round-trip. Everything else goes to
   * the review model.
   *
   * The first AI call sends the full system prompt. Subsequent calls include
   * the conversation history so the model already knows the format, which
   * reduces effective per-command token cost when the provider supports
   * prompt caching.
   */
  async review(command: string, signal?: AbortSignal): Promise<ReviewResult> {
    // ── Quick pre-filter: obviously read-only → safe ─────────────────
    if (looksObviouslySafe(command)) {
      return { risk: 'safe', reason: '已知只读命令，自动放行' };
    }

    // ── AI review ────────────────────────────────────────────────────
    const userMessage = this.buildUserMessage(command);

    // Build messages for this call — include transcript for session persistence.
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      ...this.transcript,
      { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);

    // Link external signal
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const result = await generateText({
        model: this.model as any,
        messages: messages as any,
        temperature: 0,
        maxOutputTokens: REVIEW_MAX_TOKENS,
        abortSignal: controller.signal,
      });

      const text = result.text?.trim() ?? '';

      // Record the turn in transcript
      this.transcript.push({ role: 'user', content: userMessage });
      this.transcript.push({ role: 'assistant', content: text });
      this.pruneTranscript();

      return this.parseResult(text);
    } catch (err: unknown) {
      // Review failed — fail open (caution) so the user can decide.
      console.warn('[CommandReview] Review call failed, falling back to caution:', err);
      const reason =
        err instanceof Error
          ? err.name === 'AbortError'
            ? '审查超时，需人工确认'
            : `审查服务异常: ${err.message.slice(0, 50)}`
          : '审查服务不可用，需人工确认';
      return { risk: 'caution', reason };
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Reset transcript — useful when the chat session context changes. */
  reset(): void {
    this.transcript = [];
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private buildUserMessage(command: string): string {
    return `审查命令：\n\`\`\`\n${command}\n\`\`\``;
  }

  private parseResult(text: string): ReviewResult {
    // Try to extract a JSON object from the response.
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (
          parsed.risk === 'safe' ||
          parsed.risk === 'caution' ||
          parsed.risk === 'dangerous'
        ) {
          return {
            risk: parsed.risk,
            reason:
              typeof parsed.reason === 'string'
                ? parsed.reason.slice(0, 100)
                : '未提供具体原因',
          };
        }
      } catch {
        // JSON parse failed — fall through to fallback.
      }
    }

    // Best-effort keyword fallback when JSON parsing fails.
    const lower = text.toLowerCase();
    if (lower.includes('dangerous')) {
      return { risk: 'dangerous', reason: '审查判断为危险操作' };
    }
    if (lower.includes('safe')) {
      return { risk: 'safe', reason: '审查判断为安全操作' };
    }
    // Default: uncertain → ask user.
    return { risk: 'caution', reason: '审查 AI 返回格式异常，需人工确认' };
  }

  private pruneTranscript(): void {
    const maxMessages = CommandReviewSession.MAX_TRANSCRIPT_TURNS * 2; // user + assistant per turn
    if (this.transcript.length > maxMessages) {
      this.transcript = this.transcript.slice(-maxMessages);
    }
  }
}

// Re-export the pre-filter for use in the approval layer as an additional
// shortcut before the AI review round-trip.
export { looksObviouslySafe };
