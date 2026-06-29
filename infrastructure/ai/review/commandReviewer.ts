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
// Review system prompt — rule-based, not enumeration-based.
//
// The AI has broad knowledge of shell commands; we give it PRINCIPLES and
// let it apply them.  Never enumerate specific commands here — that would
// be both incomplete and brittle.  The AI knows more commands than we do.
// ---------------------------------------------------------------------------
const REVIEW_SYSTEM_PROMPT = [
  '你是运维命令安全审查助手。根据以下原则评估命令风险，只返回 JSON：',
  '',
  '## 判断原则',
  '',
  '**safe — 无破坏性，自动放行：**',
  '- 命令只读取/查询/展示信息，不修改系统状态',
  '- 查看文件内容、列出目录、搜索文本、显示进程/磁盘/内存/网络状态',
  '- 查询服务状态、容器状态、K8s 资源、数据库（只读 SELECT）',
  '- 网络诊断（ping、DNS 查询、路由追踪、HTTP HEAD 请求）',
  '- 查看日志、系统信息、硬件信息、内核参数',
  '- 任何命令的 --help / --version / -h / -V 调用',
  '- 包管理器的搜索/查看/列表操作（不安装不卸载）',
  '- Git 的只读操作（log、status、diff、show）',
  '- 用 2>/dev/null 抑制错误、|| 回退到安全命令，这些不影响风险判定',
  '',
  '**caution — 有影响但非灾难，需用户确认：**',
  '- 命令会修改文件、安装软件、变更服务状态',
  '- 文件写入（包括重定向 > / >>）、文件内容替换（sed -i）',
  '- 包安装/升级/卸载、服务启动/停止/重启',
  '- 进程终止（kill / pkill）、用户/组管理、权限修改',
  '- 容器/镜像的创建、启动、停止、删除',
  '- 非特权环境下的常规运维操作',
  '',
  '**dangerous — 显著破坏性，直接拒绝：**',
  '- 命令会导致不可逆的数据丢失或系统不可用',
  '- 递归/批量强制删除、磁盘格式化/分区、dd 直接写块设备',
  '- 系统关机/重启、内核模块装卸、防火墙规则清空',
  '- 权限过度开放（chmod 777 递归系统目录）',
  '- 数据库/表的删除或清空（DROP / TRUNCATE）',
  '- 覆盖系统关键文件（/etc/passwd、/etc/shadow、/etc/sudoers）',
  '- 任何经过编码/混淆的命令（base64 -d 后执行、eval 动态代码、xxd 反向）',
  '- fork 炸弹、无限循环、资源耗尽攻击',
  '- 敏感数据外传（curl/wget POST 机密文件到外部地址）',
  '',
  '## 注意事项',
  '- 不要被命令名称迷惑——关注命令的实际操作和参数',
  '- 管道中的每个命令段独立评估，取最高风险等级',
  '- sudo 本身不改变风险等级，但 sudo 后面跟危险操作就是 dangerous',
  '- 不确定时宁可判为 caution，让用户决定',
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => Promise<any>;

export interface ReviewModel {
  readonly modelId: string;
  readonly provider: string;
  doGenerate?: AnyFunction;
  doStream?: AnyFunction;
}

// ---------------------------------------------------------------------------
// CommandReviewSession
// ---------------------------------------------------------------------------

/**
 * A long-lived review session that reuses a single model instance and grows a
 * conversation transcript so the model remembers the classification principles
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
  /** Accumulated conversation — keeps the model's context across calls. */
  private transcript: Array<{ role: 'user' | 'assistant'; content: string }> = [];
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
   * Every command goes through the AI review model — we rely on its broad
   * knowledge of shell commands rather than hardcoded lists.  The first call
   * sends the full system prompt; subsequent calls include conversation
   * history so the model already knows the principles.
   */
  async review(command: string, signal?: AbortSignal): Promise<ReviewResult> {
    console.log('[CommandReview] Reviewing:', command.slice(0, 80));
    const userMessage = `审查命令：\n\`\`\`\n${command}\n\`\`\``;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      ...this.transcript,
      { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);

    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const result = await generateText({
        model: this.model as any,
        messages: messages as any,
        temperature: 0,
        maxOutputTokens: REVIEW_MAX_TOKENS,
        abortSignal: controller.signal,
      });
      /* eslint-enable @typescript-eslint/no-explicit-any */

      const text = result.text?.trim() ?? '';
      const parsed = this.parseResult(text);

      console.log('[CommandReview] Result:', parsed.risk, '|', parsed.reason);

      // Record the turn so the model retains context across calls.
      this.transcript.push({ role: 'user', content: userMessage });
      this.transcript.push({ role: 'assistant', content: text });
      this.pruneTranscript();

      return parsed;
    } catch (err: unknown) {
      console.error('[CommandReview] Review call FAILED:', err);
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

  /** Reset transcript — called when the chat session is cleared. */
  reset(): void {
    this.transcript = [];
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private parseResult(text: string): ReviewResult {
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
        // JSON parse failed — fall through to keyword fallback.
      }
    }

    // Keyword fallback when the model doesn't return valid JSON.
    const lower = text.toLowerCase();
    if (lower.includes('dangerous')) return { risk: 'dangerous', reason: '审查判断为危险操作' };
    if (lower.includes('safe')) return { risk: 'safe', reason: '审查判断为安全操作' };
    return { risk: 'caution', reason: '审查 AI 返回格式异常，需人工确认' };
  }

  private pruneTranscript(): void {
    const maxMessages = CommandReviewSession.MAX_TRANSCRIPT_TURNS * 2;
    if (this.transcript.length > maxMessages) {
      this.transcript = this.transcript.slice(-maxMessages);
    }
  }
}

// ---------------------------------------------------------------------------
// Side-channel: review result tracking.
//
// When the review AI approves or denies a command, we stash the result here
// so the stream processor can show a visible indicator in the chat.
// ---------------------------------------------------------------------------
const reviewResults = new Map<string, ReviewResult>();

/** Record a review result for a tool call (called from the approval handler). */
export function recordReviewResult(toolCallId: string, result: ReviewResult): void {
  reviewResults.set(toolCallId, result);
}

/** Consume and remove a review result (called from the stream processor). */
export function consumeReviewResult(toolCallId: string): ReviewResult | undefined {
  const result = reviewResults.get(toolCallId);
  reviewResults.delete(toolCallId);
  return result;
}
