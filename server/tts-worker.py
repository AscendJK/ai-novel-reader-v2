#!/usr/bin/env python3
"""
Kokoro TTS 服务端推理常驻进程（sherpa-onnx 原生多线程）
由 server/routes/rag.js 的 /api/rag/tts/synthesize 管理（spawn + stdin/stdout JSON 行协议）。

通信协议：
  输入（stdin，每行一个 JSON）:
    {"id": 1, "text": "...", "sid": 45, "speed": 1.0}
  输出（stdout，每行一个 JSON）:
    {"type": "ready", "numSpeakers": 53}                      # 模型加载完成
    {"type": "result", "id": 1, "sampleRate": 24000, "wavBase64": "..."}  # 生成完成（16-bit PCM WAV）
    {"type": "error", "id": 1, "message": "..."}              # 生成失败

用法: python tts-worker.py <model_dir> [num_threads]
"""

import sys
import os
import json
import base64
import io
import wave

def emit(obj):
    """写一行 JSON 到 stdout 并 flush（Node 侧按行读取）"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

# 保留字符白名单（实测校准，Kokoro fp32 v1.0 + espeak-ng）：
# 只放行能正确朗读的字符，其余替换为空格。Kokoro 词表外字符不会被跳过，
# 而是被 espeak-ng 硬拼成一串怪音（症状：音色正确但内容乱读、中英混合、
# 时长膨胀）。典型乱读字符：U+FFFD、CJK 兼容汉字（F900 区）、CJK 扩展 A
# （3400 区）、全角字母、假名、々〇〆〰・、带圈字符、罗马数字、emoji、
# ©®¤¨¬± 等 Latin-1 符号、数学/箭头符号。
_KEEP_RANGES = [
    (0x0020, 0x007E),    # ASCII 空格 + 可打印字符
    (0x00A2, 0x00A3),    # ¢ £（实测正常朗读）
    (0x00A5, 0x00A7),    # ¥ ¦ §（实测正常/停顿）
    (0x00AA, 0x00AA),    # ª
    (0x00B0, 0x00B0),    # °（"37.5°C" 读"度"，合理）
    (0x00B5, 0x00B7),    # µ ¶ ·（"三·国" 常见中点，停顿）
    (0x00BA, 0x00BA),    # º
    (0x00C0, 0x00FF),    # Latin-1 字母（é ü ö ß 等，espeak 标准支持）
    (0x2013, 0x2014),    # – —
    (0x2018, 0x201D),    # ‘ ’ “ ”（引号，停顿）
    (0x2022, 0x2022),    # •（停顿）
    (0x2026, 0x2027),    # … ‧（停顿）
    (0x203B, 0x203B),    # ※（停顿）
    (0x3001, 0x3002),    # 、。
    (0x3008, 0x3011),    # 〈〉《》「」『』【】（停顿）
    (0x3014, 0x3015),    # 〔〕（停顿）
    (0x301C, 0x301C),    # ～（停顿）
    (0x303F, 0x303F),    # 〿（停顿）
    (0x4E00, 0x9FFF),    # CJK 统一表意文字（基本区，覆盖小说正文）
    (0xFF01, 0xFF19),    # 全角标点 + 全角数字 ０-９（保留；全角数字读中文数字正常）
    (0xFF1A, 0xFF1F),    # ：；＜＝＞？（停顿）
    (0xFF3B, 0xFF40),    # ［＼］＾＿｀（停顿）
    (0xFF5B, 0xFF5E),    # ｛｜｝～（停顿）
]


def _is_keep_char(cp):
    for lo, hi in _KEEP_RANGES:
        if lo <= cp <= hi:
            return True
    return False


def clean_text(text):
    """清洗 TTS 输入文本：白名单过滤，剔除会导致乱读的词表外字符。

    1. 孤立代理项（\ud800-\udfff）：pybind11 把 Python str 转 C++ std::string 时
       按 UTF-8 编码，遇到孤立代理项会抛 "incompatible function arguments"，
       导致整条请求 500 —— encode(errors="ignore") 直接丢弃。
    2. 词表外字符（U+FFFD、CJK 兼容/扩展、假名、emoji 等）会被 espeak-ng
       硬拼成怪音（中英混合胡话），统一替换为空格（保留停顿感）。
    3. 全角字母 Ａ-Ｚ ａ-ｚ 映射回 ASCII（实测全角字母逐字乱读，映射后正常）。
    """
    text = text.encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")
    out = []
    for ch in text:
        cp = ord(ch)
        if 0xFF21 <= cp <= 0xFF3A or 0xFF41 <= cp <= 0xFF5A:
            out.append(chr(cp - 0xFEE0))   # 全角字母 → ASCII
        elif cp == 0x3000:
            out.append(" ")                # 全角空格 → 半角
        elif _is_keep_char(cp):
            out.append(ch)
        else:
            out.append(" ")                # 词表外 → 空格（防乱读）
    return "".join(out)

def samples_to_wav(samples, sample_rate):
    """float32 样本 → 16-bit PCM mono WAV bytes"""
    import numpy as np
    pcm = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()

def main():
    model_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "data", "tts-cache", "model"
    )
    num_threads = int(sys.argv[2]) if len(sys.argv) > 2 else 8

    import sherpa_onnx  # 延迟导入：未安装时在启动阶段报错（Node 侧可捕获）

    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=os.path.join(model_dir, "model.onnx"),
                voices=os.path.join(model_dir, "voices.bin"),
                tokens=os.path.join(model_dir, "tokens.txt"),
                data_dir=os.path.join(model_dir, "espeak-ng-data"),
                lexicon=",".join([
                    os.path.join(model_dir, "lexicon-us-en.txt"),
                    os.path.join(model_dir, "lexicon-zh.txt"),
                ]),
                dict_dir=os.path.join(model_dir, "dict"),
            ),
            num_threads=num_threads,
        ),
        rule_fsts="",
        rule_fars="",
        max_num_sentences=1,
    )
    tts = sherpa_onnx.OfflineTts(config)
    emit({"type": "ready", "numSpeakers": tts.num_speakers})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            text = clean_text(req.get("text", ""))
            if not text:
                raise ValueError("text is required")
            sid = int(req.get("sid", 45))
            speed = float(req.get("speed", 1.0))
            if not (0.4 <= speed <= 3.5):
                raise ValueError("speed must be in [0.4, 3.5]")
            audio = tts.generate(text=text, sid=sid, speed=speed)
            wav = samples_to_wav(audio.samples, audio.sample_rate)
            emit({
                "type": "result",
                "id": req.get("id"),
                "sampleRate": audio.sample_rate,
                "wavBase64": base64.b64encode(wav).decode("ascii"),
            })
        except Exception as e:  # noqa: BLE001 — 常驻进程必须吞掉单条错误继续服务
            emit({"type": "error", "id": (req or {}).get("id"), "message": str(e)})

if __name__ == "__main__":
    main()
