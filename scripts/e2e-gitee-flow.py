# -*- coding: utf-8 -*-
"""端到端验证：模拟 rag.js downloadFromGiteeParts 对新 Kokoro 包的处理"""
import subprocess, os, shutil, sys

root = r"E:\ClaudeCode\ai-novel-reader-v2"
gitee = os.path.join(root, ".fetch", "gitee-verify2")
temp = os.path.join(root, "server", "data", "tts-temp", "e2e-test")
wasm_cache = os.path.join(temp, "cache", "wasm")
model_cache = os.path.join(temp, "cache", "model")

def cleanup():
    if os.path.exists(temp):
        shutil.rmtree(temp)

cleanup()
os.makedirs(wasm_cache, exist_ok=True)
os.makedirs(model_cache, exist_ok=True)

WASM_REQUIRED = {
    "sherpa-onnx-wasm-main-tts.wasm": 1024 * 1024,
    "sherpa-onnx-wasm-main-tts.js": 1024,
    "sherpa-onnx-tts.js": 1024,
    "sherpa-onnx-wasm-main-tts.data": 1024 * 1024,
}
MODEL_REQUIRED = {
    "model.int8.onnx": 1024 * 1024,
    "voices.bin": 1024 * 1024,
    "tokens.txt": 100,
    "lexicon-us-en.txt": 1024 * 1024,
    "lexicon-zh.txt": 1024 * 1024,
    "date-zh.fst": 1024,
    "number-zh.fst": 1024,
    "phone-zh.fst": 1024,
    "dict/jieba.dict.utf8": 1024 * 1024,
    "dict/hmm_model.utf8": 1024 * 256,
    "dict/idf.utf8": 1024 * 512,
    "dict/user.dict.utf8": 1024 * 128,
    "dict/stop_words.utf8": 1024,
    "dict/pos_dict/char_state_tab.utf8": 1024 * 128,
    "dict/pos_dict/prob_emit.utf8": 1024 * 512,
    "dict/pos_dict/prob_start.utf8": 1024,
    "dict/pos_dict/prob_trans.utf8": 1024 * 32,
}

def validate(d, required):
    missing, small = [], []
    for f, mn in required.items():
        p = os.path.join(d, f)
        if not os.path.exists(p):
            missing.append(f)
        elif os.path.getsize(p) < mn:
            small.append(f)
    if missing:
        raise RuntimeError("缺失文件: " + ", ".join(missing))
    if small:
        raise RuntimeError("文件过小: " + ", ".join(small))

def simulate(parts, archive_name, target_dir, required):
    print(f"\n=== 模拟: {archive_name} ({', '.join(parts)}) ===")
    archive_path = os.path.join(temp, archive_name + ".7z")
    extract_root = os.path.join(temp, archive_name + "-extract")
    if os.path.exists(extract_root):
        shutil.rmtree(extract_root)
    os.makedirs(extract_root, exist_ok=True)
    # 1. 拼接
    with open(archive_path, "wb") as out:
        for p in parts:
            with open(os.path.join(gitee, p), "rb") as f:
                out.write(f.read())
    size = os.path.getsize(archive_path)
    with open(archive_path, "rb") as f:
        head = f.read(6)
    ok = head == bytes([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])
    print(f"  拼接大小: {size} 头校验: {'OK' if ok else 'FAIL'}")
    if not ok:
        raise RuntimeError("7z 头校验失败")
    # 2. 解压到独立子目录（与服务器新逻辑一致）
    r = subprocess.run(["7z", "x", archive_path, f"-o{extract_root}", "-y"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("7z 解压失败: " + (r.stdout[-300:] + r.stderr[-200:]))
    # 3. 检测结构后整体复制（dict/ 等子目录全部保留）
    entries = os.listdir(extract_root)
    copy_src = extract_root
    if len(entries) == 1 and os.path.isdir(os.path.join(extract_root, entries[0])):
        copy_src = os.path.join(extract_root, entries[0])
        print("  顶层目录模式复制 OK")
    else:
        print("  根目录模式复制 OK")
    shutil.copytree(copy_src, target_dir, dirs_exist_ok=True)
    # 4. 校验
    validate(target_dir, required)
    print("  必需文件校验 OK")
    # 5. 额外：dict 全目录检查（模型包应有完整 jieba dict + pos_dict）
    if "model.int8.onnx" in required:
        dict_files = []
        for dp, dn, fn in os.walk(os.path.join(target_dir, "dict")):
            for f in fn:
                dict_files.append(os.path.relpath(os.path.join(dp, f), os.path.join(target_dir, "dict")))
        print(f"  dict/ 文件数: {len(dict_files)} -> {', '.join(sorted(dict_files)[:5])}...")
        if len(dict_files) < 11:
            raise RuntimeError(f"dict/ 不完整: 只有 {len(dict_files)} 个文件")

try:
    simulate(["sherpa-onnx-wasm-simd-1.13.6-kokoro-slim.7z"],
             "sherpa-onnx-wasm-simd-1.13.6-kokoro-slim", wasm_cache, WASM_REQUIRED)
    simulate(["kokoro-multi-lang-v1_0.7z.001", "kokoro-multi-lang-v1_0.7z.002"],
             "kokoro-multi-lang-v1_0", model_cache, MODEL_REQUIRED)
    print("\n✅ 端到端模拟全部通过：服务器新逻辑可正确处理新 Kokoro 包")
except Exception as e:
    print("❌ 失败:", e)
    sys.exit(1)
finally:
    cleanup()
