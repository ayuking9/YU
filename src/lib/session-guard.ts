import type { SupabaseClient } from "@supabase/supabase-js";

const TIMEOUT_MS = 2 * 60 * 60 * 1000;
const ACTIVITY_KEY = "yu_vault_last_activity_v1";
const CHECK_INTERVAL_MS = 15 * 1000;
const SAVE_INTERVAL_MS = 5 * 1000;

type GuardedWindow = Window & {
  __yuVaultSessionGuardInstalled?: boolean;
};

export function installSessionGuard(
  client: SupabaseClient
): void {
  if (typeof window === "undefined") {
    return;
  }

  const guardedWindow = window as GuardedWindow;

  if (guardedWindow.__yuVaultSessionGuardInstalled) {
    return;
  }

  guardedWindow.__yuVaultSessionGuardInstalled = true;

  const BASE = import.meta.env.BASE_URL;
  const loginUrl = new URL(
    `${BASE}login/`,
    window.location.origin
  );

  const currentPath = window.location.pathname.replace(/\/+$/, "");
  const loginPath = loginUrl.pathname.replace(/\/+$/, "");
  const isLoginPage = currentPath === loginPath;

  let initialized = false;
  let signingOut = false;
  let lastSavedAt = 0;
  let logoutButton: HTMLButtonElement | null = null;
  let checkTimer: number | undefined;

  function readLastActivity(): number | null {
    try {
      const stored = localStorage.getItem(ACTIVITY_KEY);

      if (!stored) {
        return null;
      }

      const timestamp = Number(stored);

      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return null;
      }

      return timestamp;
    } catch {
      return null;
    }
  }

  function saveLastActivity(timestamp: number): void {
    try {
      localStorage.setItem(
        ACTIVITY_KEY,
        String(timestamp)
      );
    } catch (error) {
      console.error("无法保存登录活动时间：", error);
    }
  }

  function removeLastActivity(): void {
    try {
      localStorage.removeItem(ACTIVITY_KEY);
    } catch (error) {
      console.error("无法清除登录活动时间：", error);
    }
  }

  function addLogoutButton(): void {
    if (logoutButton || !document.body) {
      return;
    }

    logoutButton = document.createElement("button");
    logoutButton.type = "button";
    logoutButton.textContent = "退出登录";
    logoutButton.setAttribute("aria-label", "退出登录");

    logoutButton.style.cssText = `
      appearance: none;
      border: 1px solid rgba(173, 160, 226, 0.38);
      border-radius: 2px;
      padding: 7px 11px;
      margin-left: 8px;
      background: rgba(125, 103, 176, 0.10);
      color: #d9d2e8;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.2s ease, border-color 0.2s ease;
    `;

    logoutButton.addEventListener("mouseenter", () => {
      if (!logoutButton) return;

      logoutButton.style.background =
        "rgba(125, 103, 176, 0.22)";
      logoutButton.style.borderColor =
        "rgba(173, 160, 226, 0.65)";
    });

    logoutButton.addEventListener("mouseleave", () => {
      if (!logoutButton) return;

      logoutButton.style.background =
        "rgba(125, 103, 176, 0.10)";
      logoutButton.style.borderColor =
        "rgba(173, 160, 226, 0.38)";
    });

    logoutButton.addEventListener("click", () => {
      void logout();
    });

    const nav = document.querySelector("nav");

    if (nav) {
      const links = Array.from(
        nav.querySelectorAll("a")
      );

      const loginLink = links.find((link) => {
        try {
          const path = new URL(
            link.href,
            window.location.href
          ).pathname.replace(/\/+$/, "");

          return path === loginPath;
        } catch {
          return false;
        }
      });

      if (loginLink) {
        loginLink.replaceWith(logoutButton);
      } else {
        nav.appendChild(logoutButton);
      }

      return;
    }

    const header = document.querySelector(
      ".topbar, header"
    );

    if (header) {
      header.appendChild(logoutButton);
      return;
    }

    logoutButton.style.position = "fixed";
    logoutButton.style.top = "16px";
    logoutButton.style.right = "16px";
    logoutButton.style.zIndex = "9999";

    document.body.appendChild(logoutButton);
  }

  async function logout(): Promise<void> {
    if (signingOut) {
      return;
    }

    signingOut = true;

    if (checkTimer !== undefined) {
      window.clearInterval(checkTimer);
    }

    if (logoutButton) {
      logoutButton.disabled = true;
      logoutButton.textContent = "正在退出…";
    }

    removeLastActivity();

    try {
      const { error } = await client.auth.signOut({
        scope: "local"
      });

      if (error) {
        console.error("退出登录提示：", error);
      }
    } catch (error) {
      console.error("退出登录请求异常：", error);
    }

    window.location.replace(loginUrl.href);
  }

  function checkTimeout(): void {
    if (!initialized || signingOut) {
      return;
    }

    const lastActivity = readLastActivity();

    if (
      lastActivity === null ||
      Date.now() - lastActivity >= TIMEOUT_MS
    ) {
      void logout();
    }
  }

  function recordActivity(): void {
    if (!initialized || signingOut) {
      return;
    }

    const now = Date.now();
    const lastActivity = readLastActivity();

    // 先检查是否已经超时，不能靠过期后的一次点击续命。
    if (
      lastActivity === null ||
      now - lastActivity >= TIMEOUT_MS
    ) {
      void logout();
      return;
    }

    // 限制写入频率，避免每次操作都写入 localStorage。
    if (now - lastSavedAt >= SAVE_INTERVAL_MS) {
      saveLastActivity(now);
      lastSavedAt = now;
    }
  }

  // 登录成功时记录新的会话起点。
  // INITIAL_SESSION 和 TOKEN_REFRESHED 不会重置闲置计时。
  client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session) {
      saveLastActivity(Date.now());
    }

    if (event === "SIGNED_OUT") {
      removeLastActivity();
    }
  });

  // 登录页不自动添加退出按钮，也不执行闲置登出检查。
  if (isLoginPage) {
    return;
  }

  async function initialize(): Promise<void> {
    const { data, error } = await client.auth.getSession();

    if (error) {
      console.error("检查登录状态失败：", error);
      return;
    }

    if (!data.session) {
      return;
    }

    const now = Date.now();
    const lastActivity = readLastActivity();

    // 如果是启用此功能前遗留的旧会话，因为无法确定闲置时长，
    // 要求重新登录一次，之后才开始计算两小时。
    if (lastActivity === null) {
      await logout();
      return;
    }

    if (now - lastActivity >= TIMEOUT_MS) {
      await logout();
      return;
    }

    initialized = true;
    lastSavedAt = lastActivity;

    addLogoutButton();

    document.addEventListener(
      "pointerdown",
      recordActivity,
      true
    );

    document.addEventListener(
      "keydown",
      recordActivity,
      true
    );

    document.addEventListener(
      "touchstart",
      recordActivity,
      { capture: true, passive: true }
    );

    document.addEventListener(
      "scroll",
      recordActivity,
      { capture: true, passive: true }
    );

    document.addEventListener(
      "wheel",
      recordActivity,
      { capture: true, passive: true }
    );

    checkTimer = window.setInterval(
      checkTimeout,
      CHECK_INTERVAL_MS
    );

    window.addEventListener("focus", checkTimeout);
    window.addEventListener("pageshow", checkTimeout);

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") {
          checkTimeout();
        }
      }
    );
  }

  void initialize();
}