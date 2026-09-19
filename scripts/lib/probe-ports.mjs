/**
 * 探针公用：向系统要一个当前空闲的端口。
 *
 * 为什么必须有：server/index.js 无条件在 8443 起 HTTPS，而探针只改 PORT 不改
 * HTTPS_PORT。于是"后端正在跑"的时候任何探针都会启动失败，症状还是一句
 * `fetch failed / ECONNREFUSED 127.0.0.1:<http 端口>`，完全看不出是端口撞了。
 */
import net from "node:net";

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
