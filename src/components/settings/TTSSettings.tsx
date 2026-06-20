/**
 * TTS 语音朗读设置
 * 显示 WebGPU 兼容性、语音选择、语速、自动翻章等
 */

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, Volume2, CheckCircle2, AlertTriangle, Cpu, Zap, Play } from "lucide-react";
import { useTTSStore } from "@/stores/tts-store";
import { detectTTSCapability, getWebGPUBrowserHint } from "@/tts/capability";
import { ZH_VOICES } from "@/tts/kokoro-engine";

export function TTSSettings() {
  const {
    capability, capabilityChecked, engine,
    voiceId, speed, autoNextChapter,
    modelDownloaded, modelDownloading, modelDownloadProgress,
    setCapability, setEngine, setVoiceId, setSpeed, setAutoNextChapter,
  } = useTTSStore();

  const [detecting, setDetecting] = useState(false);

  // 检测浏览器能力
  useEffect(() => {
    if (capabilityChecked) return;
    setDetecting(true);
    detectTTSCapability().then((cap) => {
      setCapability(cap);
      setDetecting(false);
    });
  }, [capabilityChecked, setCapability]);

  const isWebGPU = capability?.device === "webgpu";
  const browserHint = getWebGPUBrowserHint();

  // Web Speech API 可用语音列表（中文）
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const updateVoices = () => {
      setVoices(speechSynthesis.getVoices().filter(v => v.lang.startsWith("zh")));
    };
    updateVoices(); // 首次尝试（部分浏览器同步加载）
    speechSynthesis.addEventListener("voiceschanged", updateVoices);
    return () => speechSynthesis.removeEventListener("voiceschanged", updateVoices);
  }, []);

  // 语音试听
  const [previewing, setPreviewing] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<string>("");

  const previewVoice = useCallback((previewVoiceId: string) => {
    if (previewing) return;

    if (engine === "kokoro") {
      // Kokoro 试听：先加载模型，再生成短音频并播放
      setPreviewing(true);
      setPreviewStatus("正在加载模型...");
      import("@/tts/kokoro-engine").then(({ loadKokoroModel, generateAudio, isKokoroLoaded }) => {
        const modelReady = isKokoroLoaded();
        if (!modelReady) {
          setPreviewStatus("首次使用，正在下载模型（约 100MB）...");
        }
        loadKokoroModel({
          onProgress: (p) => {
            if (!modelReady) setPreviewStatus(`正在下载模型 ${p}%...`);
          }
        }).then(() => {
          setPreviewStatus("正在生成音频...");
          return generateAudio("你好，我是你的小说朗读助手。这是一段语音试听，你可以通过这段文字感受不同语音的音色效果。", { voice: previewVoiceId, speed: 1.0 });
        })
          .then(async (result) => {
            setPreviewStatus("");
            const ctx = new AudioContext();
            try {
              if (ctx.state === "suspended") await ctx.resume();
              const buffer = ctx.createBuffer(1, result.audio.length, result.sampleRate);
              buffer.copyToChannel(new Float32Array(result.audio), 0);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => {
                ctx.close();
                setPreviewing(false);
              };
              source.start();
            } catch (e) {
              ctx.close();
              setPreviewing(false);
              setPreviewStatus("");
              console.error("[TTS] Preview playback failed:", e);
            }
          })
          .catch((err) => {
            setPreviewing(false);
            setPreviewStatus(`加载失败: ${err instanceof Error ? err.message : "未知错误"}`);
            console.error("[TTS] Preview failed:", err);
          });
      });
    } else {
      // Web Speech API 试听
      const utterance = new SpeechSynthesisUtterance("你好，我是你的小说朗读助手。");
      utterance.lang = "zh-CN";
      const voice = voices.find(v => v.voiceURI === previewVoiceId);
      if (voice) utterance.voice = voice;
      utterance.onend = () => setPreviewing(false);
      utterance.onerror = () => setPreviewing(false);
      setPreviewing(true);
      speechSynthesis.speak(utterance);
    }
  }, [engine, voices, previewing]);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-medium text-sm">语音朗读</p>
        <p className="text-xs text-muted-foreground">使用 AI 语音合成朗读小说内容</p>
      </div>

      {/* 浏览器兼容性 */}
      <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
        {detecting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">正在检测浏览器能力...</span>
          </>
        ) : isWebGPU ? (
          <>
            <Zap className="h-4 w-4 text-green-500" />
            <div className="flex-1">
              <span className="text-xs text-green-600 font-medium">{capability?.detail}</span>
              <span className="text-xs text-muted-foreground ml-2">· fp16 (164MB) · WebGPU 推理</span>
            </div>
          </>
        ) : (
          <>
            <Cpu className="h-4 w-4 text-amber-500" />
            <div className="flex-1">
              <span className="text-xs text-amber-600 font-medium">{capability?.detail}</span>
              <span className="text-xs text-muted-foreground ml-2">· quantized (127MB) · WASM 推理</span>
              {browserHint && (
                <p className="text-[10px] text-muted-foreground mt-1">💡 {browserHint}</p>
              )}
            </div>
          </>
        )}
      </div>

      <Separator />

      {/* TTS 引擎选择 */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">语音引擎</p>
        <div className="flex gap-2">
          <Button
            variant={engine === "kokoro" ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs"
            onClick={() => setEngine("kokoro")}
          >
            <Zap className="h-3 w-3 mr-1" />
            Kokoro（推荐）
          </Button>
          <Button
            variant={engine === "webspeech" ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs"
            onClick={() => setEngine("webspeech")}
          >
            <Volume2 className="h-3 w-3 mr-1" />
            Web Speech API
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {engine === "kokoro"
            ? "Kokoro 高质量语音，首次使用需下载模型文件"
            : "浏览器内置语音，无需下载，质量一般"
          }
        </p>
      </div>

      <Separator />

      {/* 语音选择 */}
      {engine === "kokoro" ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">语音选择</p>
          <div className="flex gap-2">
            <select
              className="flex-1 text-xs border rounded px-2 py-1.5 bg-background"
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              {Object.entries(ZH_VOICES).map(([id, v]) => (
                <option key={id} value={id}>
                  {v.name}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px] px-2"
              onClick={() => previewVoice(voiceId)}
              disabled={previewing}
            >
              {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              <span className="ml-1">试听</span>
            </Button>
          </div>
          {previewStatus && (
            <p className={`text-[10px] ${previewStatus.includes("失败") ? "text-destructive" : "text-muted-foreground"}`}>
              {previewStatus}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground">Kokoro 中文语音，首次使用需下载 127MB 模型</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">语音选择</p>
          {voices.length > 0 ? (
            <div className="flex gap-2">
              <select
                className="flex-1 text-xs border rounded px-2 py-1.5 bg-background"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
              >
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[10px] px-2"
                onClick={() => previewVoice(voiceId)}
                disabled={previewing}
              >
                {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                <span className="ml-1">试听</span>
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">未检测到中文语音，使用系统默认</p>
          )}
        </div>
      )}

      {/* 语速 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">语速</p>
          <span className="text-xs text-muted-foreground">{speed.toFixed(1)}x</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={3.0}
          step={0.25}
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          className="w-full h-1.5"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>0.5x</span>
          <span>1.0x</span>
          <span>2.0x</span>
          <span>3.0x</span>
        </div>
      </div>

      {/* 自动翻章 */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground">自动翻章</p>
          <p className="text-[10px] text-muted-foreground">当前章播放完毕后自动播放下一章</p>
        </div>
        <button
          className={`w-10 h-5 rounded-full transition-colors ${autoNextChapter ? "bg-primary" : "bg-muted"}`}
          onClick={() => setAutoNextChapter(!autoNextChapter)}
        >
          <div className={`w-4 h-4 rounded-full bg-white transition-transform ${autoNextChapter ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </div>

      {/* 模型状态（仅 Kokoro） */}
      {engine === "kokoro" && (
        <>
          <Separator />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">模型状态</p>
            {modelDownloaded ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-xs text-green-600">已下载</span>
                <span className="text-xs text-muted-foreground">
                  ({capability ? Math.round(capability.modelSize / 1024 / 1024) : "?"}MB)
                </span>
              </div>
            ) : modelDownloading ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-xs">正在下载模型 {modelDownloadProgress}%</span>
                </div>
                <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${modelDownloadProgress}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <span className="text-xs text-amber-600">未下载（首次播放时自动下载）</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
