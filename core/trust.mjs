/**
 * 窗口可信判定（纯函数、零依赖、可单测）。
 *
 * 背景：inject-main 原先只判 `wc.getType() === "window"` 就往窗口里注入含
 * 桥 token 的 `__ZPE_BOOT__`，而 token 是进程生命周期内永不过期的常量。
 * 只要任一 window 型窗口加载了远程内容（登录页 / 设置页 / webview），
 * 那个页面就能读到 token，并以用户自己的 apiKey 代发增强请求、烧掉额度。
 *
 * 策略：默认只信任本地打包资源协议；远程页面必须显式列进白名单。
 * 宁可因白名单过严导致某窗口没按钮（可配置修复），也不默认放行 http/https。
 */

/** 本地打包资源协议：不经过网络，页面内容由客户端自身提供。 */
export const DEFAULT_PROTOCOLS = ["file:", "app:", "chrome-extension:", "devtools:"];

/**
 * @param {string[]} [allowHosts] 允许注入的远程主机（hostname 或 host，大小写不敏感）
 * @returns {{check: (rawUrl: unknown) => boolean}}
 */
export function createTrustChecker(allowHosts = []) {
  const hosts = new Set(
    (Array.isArray(allowHosts) ? allowHosts : [])
      .map((h) => String(h || "").trim().toLowerCase())
      .filter(Boolean)
  );
  return {
    check(rawUrl) {
      if (typeof rawUrl !== "string" || rawUrl === "") return false;
      let u;
      try {
        u = new URL(rawUrl);
      } catch {
        return false;
      }
      // about:blank / data: 之类没有 hostname 的协议不在本地协议白名单里，
      // 会落到下面的主机判定并被拒——这是有意的：它们无法验证来源。
      if (DEFAULT_PROTOCOLS.includes(u.protocol)) return true;
      return hosts.has(u.hostname.toLowerCase()) || hosts.has(u.host.toLowerCase());
    },
  };
}
