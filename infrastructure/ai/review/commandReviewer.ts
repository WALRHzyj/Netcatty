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
// Review system prompt — kept concise to minimise per-review token cost.
// The model receives this ONCE per session in the constructor; subsequent
// reviews append user/assistant pairs so the model remembers the format
// without re-sending the full prompt each time (prompt-cache friendly).
// ---------------------------------------------------------------------------
const REVIEW_SYSTEM_PROMPT = [
  '你是命令安全审查助手。严格按以下标准评估风险，只返回 JSON：',
  '',
  'safe — 无破坏性：',
  '  只读操作（cat, less, head, tail, grep, find, ls, ps, df, du, top, who, echo, date, pwd, stat, file, uname, id, env）',
  '  状态查询（systemctl status, service status, journalctl 只读）',
  '  容器/K8s 只读查询（docker ps/inspect/logs, kubectl get/describe/logs）',
  '  Git 只读（log, status, diff, show）, 网络诊断（ping, traceroute, dig, nslookup, curl -I）',
  '  包管理查询（apt-cache search, yum list, brew info）',
  '',
  'caution — 有影响但非灾难：',
  '  文件修改（sed -i, awk 写入, tee, 重定向写入非系统文件）',
  '  包管理操作（apt/apt-get install/upgrade, yum install/update, pip/npm install）',
  '  服务管理（systemctl start/stop/restart, service restart）',
  '  进程管理（kill 非 -9, pkill 非强制）, 用户管理（useradd, usermod 非删除）',
  '  Docker 操作（restart/stop/start, exec 非特权）, 非 root 的文件写入',
  '',
  'dangerous — 显著破坏性：',
  '  递归强制删除（rm -rf, find -delete）, 磁盘操作（mkfs, fdisk, parted, dd 写磁盘）',
  '  系统关机/重启（shutdown, reboot, halt, poweroff）, fork 炸弹/资源耗尽',
  '  权限过度开放（chmod 777 -R /, chmod -R 777 系统目录）',
  '  数据库破坏（DROP DATABASE, DROP TABLE, TRUNCATE）, 防火墙清空（iptables -F/-X, ufw disable）',
  '  编码/混淆命令（base64 -d, eval, xxd -r）, sudo 配合危险操作',
  '  覆盖系统关键文件（> /etc/passwd, > /etc/shadow）, 敏感数据外传',
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
   * The first call sends the full system prompt. Subsequent calls include the
   * conversation history so the model already knows the format, which reduces
   * effective per-command token cost when the provider supports prompt caching.
   */
  async review(command: string, signal?: AbortSignal): Promise<ReviewResult> {
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

      return this.parseResult(text, command);
    } catch (err: unknown) {
      // Review failed — fail open (caution) so the user can decide.
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

  private parseResult(text: string, _command: string): ReviewResult {
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
