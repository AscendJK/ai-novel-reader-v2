/**
 * TTS 语音朗读设置
 * 使用浏览器内置 Web Speech API
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, Play } from "lucide-react";
import { useTTSStore } from "@/stores/tts-store";

export function TTSSettings() {
  const {
    voiceId, speed, volume, pitch, autoNextChapter,
    setVoiceId, setSpeed, setVolume, setPitch, setAutoNextChapter,
  } = useTTSStore();

  // Web Speech API 可用语音列表（中文）
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const updateVoices = () => {
      setVoices(speechSynthesis.getVoices().filter(v => v.lang.startsWith("zh")));
    };
    updateVoices();
    speechSynthesis.addEventListener("voiceschanged", updateVoices);
    return () => speechSynthesis.removeEventListener("voiceschanged", updateVoices);
  }, []);

  // 语音试听
  const [previewing, setPreviewing] = useState(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
  }, []);

  const previewVoice = useCallback((previewVoiceId: string) => {
    if (previewing) return;
    // B2+B3+EC3+EC5b: 如果正在播放，通过 store 通知停止
    const state = useTTSStore.getState();
    if (state.playing) {
      speechSynthesis.cancel();
      state.reset(); // 清洗 store 状态，防止 UI 卡在"播放中"
    }
    const utterance = new SpeechSynthesisUtterance("各位村民，大家新年好。近期，湖北省武汉市等多个地区。");
    utterance.lang = "zh-CN";
    const voice = voices.find(v => v.voiceURI === previewVoiceId);
    if (voice) utterance.voice = voice;
    utterance.onend = () => { if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; } setPreviewing(false); };
    utterance.onerror = () => { if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; } setPreviewing(false); };
    setPreviewing(true);
    speechSynthesis.speak(utterance);
    previewTimerRef.current = setTimeout(() => { speechSynthesis.cancel(); previewTimerRef.current = null; setPreviewing(false); }, 30000);
  }, [voices, previewing]);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-medium text-sm">语音朗读</p>
        <p className="text-xs text-muted-foreground">使用浏览器内置 Web Speech API 进行中文语音朗读</p>
      </div>

      <Separator />

      {/* 语音选择 */}
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
                <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
              ))}
            </select>
            <Button variant="outline" size="sm" className="h-7 text-[10px] px-2"
              onClick={() => previewVoice(voiceId)} disabled={previewing}>
              {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              <span className="ml-1">试听</span>
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">未检测到中文语音，使用系统默认</p>
        )}
      </div>

      {/* 语速 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">语速</p>
          <span className="text-xs text-muted-foreground">{speed.toFixed(1)}x</span>
        </div>
        <input type="range" min={0.5} max={3.0} step={0.25} value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))} className="w-full h-1.5" />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>0.5x</span><span>1.0x</span><span>2.0x</span><span>3.0x</span>
        </div>
      </div>

      {/* F7: 音量 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">音量</p>
          <span className="text-xs text-muted-foreground">{(volume * 100).toFixed(0)}%</span>
        </div>
        <input type="range" min={0} max={1} step={0.05} value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))} className="w-full h-1.5" />
      </div>

      {/* F8: 音调 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">音调</p>
          <span className="text-xs text-muted-foreground">{pitch.toFixed(1)}</span>
        </div>
        <input type="range" min={0.5} max={2.0} step={0.1} value={pitch}
          onChange={(e) => setPitch(parseFloat(e.target.value))} className="w-full h-1.5" />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>低</span><span>正常</span><span>高</span>
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
    </div>
  );
}
