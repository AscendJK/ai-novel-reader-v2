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

def clean_text(text):
    """清洗 TTS 输入文本：剔除无法正常合成的无效字符。

    1. 孤立代理项（\ud800-\udfff）：pybind11 把 Python str 转 C++ std::string 时
       按 UTF-8 编码，遇到孤立代理项会抛 "incompatible function arguments"，
       导致整条请求 500。
    2. U+FFFD 替换字符（�）：小说源数据损坏的标记，Kokoro 词表无此字符，
       会把每个 � 读成一串怪音（中英混合胡话），必须一并剔除。
    """
    text = text.encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")
    return text.replace("\ufffd", "")

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
