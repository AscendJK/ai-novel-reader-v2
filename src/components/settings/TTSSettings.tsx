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
    voiceId, speed, pitch, autoNextChapter, browserVoices,
    setVoiceId, setSpeed, setPitch, setAutoNextChapter, setBrowserVoices,
  } = useTTSStore();

  const [loading, setLoading] = useState(false);
  const [loadAttempted, setLoadAttempted] = useState(false);

  // 持续轮询语音列表（不依赖 voiceschanged，每 2 秒检查一次）
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const tryRead = () => {
      const all = speechSynthesis.getVoices();
      if (all.length > 0) setBrowserVoices(all);
    };
    tryRead();
    const poll = setInterval(tryRead, 2000);
    return () => clearInterval(poll);
  }, [setBrowserVoices]);

  const voicesLoaded = browserVoices.length > 0;

  // 语音列表加载 — 零宽空格无声触发 Chrome 引擎初始化
  const loadVoicesRef = useRef<{ poll: ReturnType<typeof setInterval> | null; fallback: ReturnType<typeof setTimeout> | null }>({ poll: null, fallback: null });
  useEffect(() => () => {
    const r = loadVoicesRef.current;
    if (r.poll) clearInterval(r.poll);
    if (r.fallback) clearTimeout(r.fallback);
  }, []);

  const loadVoices = useCallback(() => {
    if (voicesLoaded) return;
    setLoading(true);
    setLoadAttempted(true);
    // 零宽空格 — 触发 Chrome 引擎但不产生 audible 声音
    const dummy = new SpeechSynthesisUtterance("​");
    dummy.lang = "zh-CN";
    dummy.onstart = () => {
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        const all = speechSynthesis.getVoices();
        if (all.length > 0) {
          setBrowserVoices(all);
          clearInterval(poll);
          loadVoicesRef.current.poll = null;
          setLoading(false);
        } else if (attempts > 40) {
          clearInterval(poll);
          loadVoicesRef.current.poll = null;
          setLoading(false);
        }
      }, 250);
      loadVoicesRef.current.poll = poll;
    };
    dummy.onerror = () => setLoading(false);
    speechSynthesis.speak(dummy);
    const fb = setTimeout(() => setLoading(false), 12000);
    loadVoicesRef.current.fallback = fb;
  }, [voicesLoaded, setBrowserVoices]);

  // 语音试听
  const [previewing, setPreviewing] = useState(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
  }, []);

  const previewVoice = useCallback((previewVoiceId: string) => {
    if (previewing) return;
    const state = useTTSStore.getState();
    if (state.playing) {
      speechSynthesis.cancel();
      state.reset();
    }
    const utterance = new SpeechSynthesisUtterance("各位村民，大家新年好。近期，湖北省武汉市等多个地区。");
    utterance.lang = "zh-CN";
    const voice = browserVoices.find(v => v.voiceURI === previewVoiceId);
    if (voice) utterance.voice = voice;
    utterance.onend = () => { if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; } setPreviewing(false); };
    utterance.onerror = () => { if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; } setPreviewing(false); };
    setPreviewing(true);
    speechSynthesis.speak(utterance);
    previewTimerRef.current = setTimeout(() => { speechSynthesis.cancel(); previewTimerRef.current = null; setPreviewing(false); }, 30000);
  }, [browserVoices, previewing]);

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
        {voicesLoaded ? (
          <div className="flex gap-2">
            <select
              className="flex-1 text-xs border rounded px-2 py-1.5 bg-background"
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              {browserVoices.map((v) => (
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
          <div className="space-y-2">
            {loadAttempted && !loading ? (
              <p className="text-xs text-muted-foreground">
                当前浏览器未返回语音列表，将使用系统默认语音朗读（不影响朗读功能）
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {loading ? "正在加载语音列表..." : "未检测到语音，点击下方按钮加载"}
                </p>
                <Button variant="outline" size="sm" className="h-7 text-[10px]"
                  onClick={loadVoices} disabled={loading}>
                  {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                  {loading ? "加载中..." : "加载语音列表"}
                </Button>
              </>
            )}
          </div>
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
