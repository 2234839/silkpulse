/**
 * clipboard —— 复制文本到剪贴板的通用工具
 *
 * 优先用 navigator.clipboard（安全上下文 HTTPS），失败时降级为
 * textarea + execCommand（兼容 HTTP 环境如 http://server-ip:8080，
 * 以及无头测试环境）。
 */

/**
 * 复制文本到剪贴板
 *
 * 安全覆盖上下文走 Clipboard API；非安全上下文（HTTP）自动降级。
 * 返回是否复制成功。
 */
export async function copyText(text: string): Promise<boolean> {
  /** 优先走标准 Clipboard API（需要 secure context） */
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /** 权限拒绝或 API 不可用，走降级 */
    }
  }
  /** 降级：临时 textarea + execCommand('copy') */
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
