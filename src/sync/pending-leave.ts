/**
 * `/leave` 的持久化重试队列（round 2 批次 1b / R-17 的删除侧）
 *
 * 离线时从书架移除一本书：本地数据已经删了，但服务器仍认为该用户 joined，
 * 而且没有任何地方记下"用户要求退出这本书"。等下次同步，joined=true 会把整本
 * 书连同云端的摘要/笔记重新下载回来——删除复活。这里把待发的 leave 落到
 * localStorage，等下一次真正联网的同步流程再补发。
 */

import { apiFetch } from "@/lib/api-client";
import { userKey } from "@/lib/user-utils";

const PENDING_LEAVE_KEY = "novel-reader-pending-leave";

export function getPendingLeaves(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(userKey(PENDING_LEAVE_KEY)) || "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function enqueuePendingLeave(novelId: string): void {
  const list = getPendingLeaves();
  if (list.includes(novelId)) return;
  try {
    localStorage.setItem(userKey(PENDING_LEAVE_KEY), JSON.stringify([...list, novelId]));
  } catch {
    // 配额满：最坏退化成修复前的行为（leave 丢失），不该因此让删除操作本身失败
    console.warn("[sync] 无法记录待补发的 leave（localStorage 写入失败）");
  }
}

export function clearPendingLeave(novelId: string): void {
  try {
    localStorage.setItem(
      userKey(PENDING_LEAVE_KEY),
      JSON.stringify(getPendingLeaves().filter((id) => id !== novelId))
    );
  } catch { /* ignore */ }
}

/**
 * 补发积压的 leave。
 * @returns 已送达服务器（可视为完成）的 novelId 列表；网络仍不通时返回空数组，
 *          队列原样保留，下一轮同步再试。
 */
export async function flushPendingLeaves(): Promise<string[]> {
  const pending = getPendingLeaves();
  if (pending.length === 0) return [];

  const done: string[] = [];
  for (const novelId of pending) {
    try {
      const resp = await apiFetch(`/api/novels/${novelId}/leave`, { method: "POST" });
      // 404：服务器上这本书或 join 记录已不存在，目的已达成
      if (resp.ok || resp.status === 404) {
        clearPendingLeave(novelId);
        done.push(novelId);
      }
    } catch {
      break; // 仍然离线，剩下的下一轮再试
    }
  }
  if (done.length) console.log(`[sync] 补发 leave 成功 ${done.length} 本`);
  return done;
}
