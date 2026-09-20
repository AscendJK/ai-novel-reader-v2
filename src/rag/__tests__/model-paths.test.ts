/**
 * /model-proxy 的白名单与缓存路径判定（批次 G）
 *
 * 这条路由是局域网里"替客户端去取文件"的开放代理：白名单只放行 Xenova/ 与
 * onnx-community/ 两个命名空间，但它对 `resolve/main/` 后面的字符不作限制——
 * `../..` 这类穿越完全能过白名单，唯一的拦阻是 resolve 之后跟缓存目录的比较。
 * 那道比较一旦被改窄或删掉，症状是"什么都没发生"，所以两种路径分隔符下都要钉住。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";

// @ts-expect-error - 后端 JS 模块无类型声明
const paths = await import("../../../server/lib/model-paths.mjs");
const { isAllowedModelPath, toCachePath, resolveModelCachePath } = paths as {
  isAllowedModelPath: (s: unknown) => boolean;
  toCachePath: (s: string) => string;
  resolveModelCachePath: (o: { modelDir: string; subPath: string; pathImpl?: typeof path }) => string | null;
};

const DIR = "/srv/app/server/data/models-cache";
const resolveIn = (subPath: string, impl = path.posix, modelDir = DIR) =>
  resolveModelCachePath({ modelDir, subPath, pathImpl: impl });

describe("模型路径白名单", () => {
  it("放行两个命名空间下 resolve/main 的文件", () => {
    expect(isAllowedModelPath("Xenova/bge-small-zh-v1.5/resolve/main/config.json")).toBe(true);
    expect(isAllowedModelPath("onnx-community/x/resolve/main/onnx/model.onnx")).toBe(true);
  });

  it("拒掉其他命名空间——这条路由不许变成任意 URL 的正代理", () => {
    expect(isAllowedModelPath("evilorg/x/resolve/main/y.bin")).toBe(false);
    expect(isAllowedModelPath("../Xenova/x/resolve/main/y")).toBe(false);
    expect(isAllowedModelPath("")).toBe(false);
    expect(isAllowedModelPath(undefined)).toBe(false);
  });

  it("拒掉没有 resolve/main 段的写法（少一段就不该落到缓存目录里）", () => {
    expect(isAllowedModelPath("Xenova/bge-small-zh-v1.5/config.json")).toBe(false);
    expect(isAllowedModelPath("Xenova/bge-small-zh-v1.5/resolve/master/config.json")).toBe(false);
  });

  it("白名单只认正斜杠：反斜杠形式直接拒，不靠后面那道 resolve 兜", () => {
    expect(isAllowedModelPath("Xenova\\b\\resolve\\main\\x.json")).toBe(false);
  });
});

describe("缓存路径不得越出缓存目录", () => {
  it("正常路径落在目录内并剥掉 resolve/main", () => {
    const got = resolveIn("Xenova/bge-small-zh-v1.5/resolve/main/config.json");
    expect(got).toBe(`${DIR}/Xenova/bge-small-zh-v1.5/config.json`);
  });

  it("白名单能过的 ../../ 穿越必须被判 null（POSIX）", () => {
    expect(resolveIn("Xenova/b/resolve/main/../../../../server/data/key.pem")).toBeNull();
    expect(resolveIn("Xenova/b/resolve/main/../../../etc/passwd")).toBeNull();
  });

  it("少爬一级的 `..` 只是回到缓存目录内——那是合法路径，不能误判成穿越", () => {
    expect(resolveIn("Xenova/b/resolve/main/../../other/config.json"))
      .toBe(`${DIR}/other/config.json`);
  });

  it("Windows 分隔符与 .. 组合同样判越界", () => {
    const winDir = "E:\\srv\\app\\server\\data\\models-cache";
    expect(resolveModelCachePath({
      modelDir: winDir,
      subPath: "Xenova/b/resolve/main/..\\..\\..\\..\\server\\data\\key.pem",
      pathImpl: path.win32,
    })).toBeNull();
    expect(resolveModelCachePath({
      modelDir: winDir,
      subPath: "Xenova/b/resolve/main/config.json",
      pathImpl: path.win32,
    })).toBe("E:\\srv\\app\\server\\data\\models-cache\\Xenova\\b\\config.json");
  });

  it("同名前缀的兄弟目录不算在目录内（少一个分隔符就比较穿了）", () => {
    expect(resolveModelCachePath({
      modelDir: "/srv/models-cache",
      subPath: "Xenova/b/resolve/main/../../../models-cache-secret/key.pem",
      pathImpl: path.posix,
    })).toBeNull();
  });
});

describe("toCachePath", () => {
  it("只剥掉 Transformers.js 结构里那段 resolve/main", () => {
    expect(toCachePath("Xenova/m/resolve/main/onnx/model.onnx")).toBe("Xenova/m/onnx/model.onnx");
    expect(toCachePath("Xenova/m/config.json")).toBe("Xenova/m/config.json");
  });
});
