/**
 * useAudioPlayer - TTS 播放逻辑 Hook
 * 管理 TTS 播放状态、段落进度、自动翻章
 */

import { useRef, useCallback, useEffect, useState } from "react";
import { useTTSStore } from "@/stores/tts-store";
import { TTSManager, type TTSChunk } from "@/tts/tts-manager";
import { prepareTextForTTS } from "@/tts/text-preprocess";
import { showToast } from "@/components/common/Toast";

const TTS_POS_KEY = "novel-reader-tts-position";

interface UseAudioPlayerOptions {
  /** 当前章节内容 */
  chapterContent: string | null;
  /** 当前章节索引 */
  chapterIndex: number | null;
  /** 小说 ID */
  novelId: string | null;
  /** 当前章节标题 */
  chapterTitle?: string;
  /** 翻到上一章的回调 */
  onPrevChapter?: () => void;
  /** 翻到下一章的回调 */
  onNextChapter?: () => void;
}

export function useAudioPlayer({
  chapterContent,
  chapterIndex,
  novelId,
  chapterTitle,
  onPrevChapter,
  onNextChapter,
}: UseAudioPlayerOptions) {
  const managerRef = useRef<TTSManager | null>(null);
  // H11 fix: 追踪自动翻章定时器，stop 时清除
  const autoNextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // B5: 自动翻章后等新章节加载完成再自动播放
  const pendingAutoPlayRef = useRef(false);

  const {
    playing, paused, speed, pitch, voiceId, engine, autoNextChapter,
    currentNovelId, currentChapterIndex,
    setPlaying, setPaused, setCurrentChapter,
    setParagraphProgress, setGenerating, setEngine,
    setModelDownloaded, setModelDownloading, setBrowserVoices, reset,
  } = useTTSStore();

  // 初始化/销毁 TTS 管理器
  useEffect(() => {
    return () => {
      if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current);
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, []);

  // M19+R7: 手动翻章时清除定时器+停止旧播放
  useEffect(() => {
    if (autoNextTimerRef.current) {
      clearTimeout(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
    // R7: 非自动翻章时停止旧播放（防止旧章音频继续朗读）
    if (!pendingAutoPlayRef.current) {
      managerRef.current?.stop();
      reset();
    }
  }, [chapterIndex]);

  const playRef = useRef<typeof play>(null!); // B4+B5: 在 play 定义前声明，定义后赋值
  const chunksRef = useRef<TTSChunk[]>([]); // 存储当前 chunk 列表，供 seekToParagraph 查找

  // 语速/语音变化时同步到管理器
  useEffect(() => {
    if (managerRef.current) {
      managerRef.current.setSpeed(speed);
    }
  }, [speed]);

  useEffect(() => {
    if (managerRef.current) {
      managerRef.current.setVoice(voiceId);
    }
  }, [voiceId]);

  useEffect(() => {
    if (managerRef.current) managerRef.current.setPitch(pitch);
  }, [pitch]);

  // B8: 引擎切换时同步到 manager
  useEffect(() => {
    if (managerRef.current) managerRef.current.setEngine(engine);
  }, [engine]);

  // 确保管理器存在
  const getManager = useCallback(() => {
    if (!managerRef.current) {
      managerRef.current = new TTSManager();
    }
    return managerRef.current;
  }, []);

  // 播放当前章节
  const play = useCallback(async () => {
    if (!chapterContent || chapterIndex == null || !novelId) return;

    const manager = getManager();
    manager.setEngine(engine);
    manager.setVoice(voiceId);
    manager.setSpeed(speed);
    manager.setPitch(pitch);

    setCurrentChapter(novelId, chapterIndex);
    setGenerating(true);

    const prepared = prepareTextForTTS(chapterContent);
    // 用原始段落数（/\n+/ 分割）做进度条分母
    const totalParaCount = chapterContent.split(/\n+/).filter(p => p.trim().length > 0).length;
    setParagraphProgress(0, totalParaCount);
    if (prepared.length === 0) {
      setGenerating(false);
      return;
    }

    // 构建 chunk 列表，保留段落追踪字段用于 UI 高亮
    const chunks: TTSChunk[] = prepared.map((c, i) => ({
      text: c.text, index: i,
      paragraphIndex: c.paragraphIndex,
      paragraphIndices: c.paragraphIndices,
      paragraphBreaks: c.paragraphBreaks,
    }));
    chunksRef.current = chunks;

    // F10: 恢复上次朗读位置（保存的是原始段落索引）
    const savedPara = loadPosition();
    let startChunkIdx = 0;
    if (savedPara != null && savedPara > 0) {
      const found = chunks.findIndex(c => c.paragraphIndex >= savedPara);
      if (found >= 0) startChunkIdx = found;
    }
    setParagraphProgress(chunks[startChunkIdx]?.paragraphIndex ?? 0, totalParaCount);

    const startChunks = startChunkIdx > 0 ? chunks.slice(startChunkIdx) : chunks;
    await manager.speak(startChunks, {
      onPlay: () => {
        setGenerating(false);
        setPlaying(true);
        setError(null); // R3F3: 手动重试成功，清除错误
      },
      onChunkStart: (_i, _total, paraIdx) => setParagraphProgress(paraIdx, totalParaCount),
      onChunkEnd: (_i, _total, paraIdx) => setParagraphProgress(paraIdx, totalParaCount),
      onParagraphChange: (paraIdx) => setParagraphProgress(paraIdx, totalParaCount),
      onEnd: () => {
        setPlaying(false);
        if (autoNextChapter && onNextChapter) {
          // B5: 标记自动翻章进行中，等新章节加载完自动播放
          pendingAutoPlayRef.current = true;
          autoNextTimerRef.current = setTimeout(() => {
            autoNextTimerRef.current = null;
            onNextChapter();
          }, 500);
        }
      },
      onError: (err) => {
        console.error("[TTS] Error:", err);
        setGenerating(false);
        setPlaying(false);
        const count = retryCountRef.current;
        // U5: 自动重试（Web Speech API 常见瞬时错误）
        if (count < 3) {
          retryCountRef.current = count + 1;
          setError(`${err}（自动重试 ${count + 1}/3...）`);
          const retryGen = manager.getCurrentGenerationId(); // H6: 防止并发重试
          setTimeout(() => {
            if (managerRef.current && manager.getCurrentGenerationId() === retryGen) {
              setError(null);
              setGenerating(true);
              managerRef.current.seekToChunk(managerRef.current.getCurrentChunkIndex());
            }
          }, 2000);
        } else {
          setError(err);
          showToast(`朗读出错: ${err}`, "warn");
        }
      },
      onStop: () => {
        setGenerating(false);
        setPlaying(false);
        setError(null);
      },
      onFallback: (_from, to) => {
        // 同步 store 的引擎状态，重置下载状态
        setModelDownloading(false);
        setEngine(to);
      },
      onModelProgress: (progress) => {
        setModelDownloading(true, progress);
      },
      onModelLoaded: () => {
        setModelDownloading(false);
        setModelDownloaded(true);
      },
      onVoicesLoaded: (voices) => {
        // U8: 朗读时加载好的语音列表同步到 store，设置页直接读取
        setBrowserVoices(voices);
      },
    }).catch((err) => {
      console.error("[TTS] speak failed:", err);
      setGenerating(false);
      setPlaying(false);
    });
  }, [chapterContent, chapterIndex, novelId, engine, voiceId, speed, pitch, autoNextChapter, getManager, setCurrentChapter, setGenerating, setParagraphProgress, setPlaying, onNextChapter]);

  // R13: 暂停/恢复（WebSpeech 使用 cancel+re-speak 模式，绕过移动端 resume bug）
  const togglePause = useCallback(async () => {
    const manager = getManager();
    if (manager.isPaused()) {
      await manager.resume();
      setPaused(false);
    } else if (manager.isPlaying()) {
      manager.pause();
      setPaused(true);
    }
  }, [getManager, setPaused]);

  // F2+F3: 跳到指定原始段落并开始朗读
  const seekToParagraph = useCallback((paraIndex: number) => {
    const manager = getManager();
    if (manager.isPlaying() || manager.isPaused()) {
      const chunks = chunksRef.current;
      const chunkIdx = chunks.findIndex(c => c.paragraphIndex >= paraIndex);
      // 超出范围时定位到最后一段
      if (chunkIdx >= 0) manager.seekToChunk(chunkIdx);
      else if (chunks.length > 0) manager.seekToChunk(chunks.length - 1);
    } else {
      try { localStorage.setItem(TTS_POS_KEY, JSON.stringify({ novelId, chapterIndex, paragraph: paraIndex })); } catch {}
      play();
    }
  }, [getManager, play, novelId, chapterIndex]);

  // F10: 保存/恢复朗读位置（基于原始段落索引）
  const savePosition = useCallback(() => {
    const s = useTTSStore.getState();
    if (s.currentNovelId && s.currentChapterIndex != null) {
      try { localStorage.setItem(TTS_POS_KEY, JSON.stringify({ novelId: s.currentNovelId, chapterIndex: s.currentChapterIndex, paragraph: s.currentParagraph })); } catch {}
    }
  }, []);
  const loadPosition = useCallback((): number | null => {
    try {
      const raw = localStorage.getItem(TTS_POS_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (pos.novelId === novelId && pos.chapterIndex === chapterIndex) return pos.paragraph;
    } catch {}
    return null;
  }, [novelId, chapterIndex]);

  // 停止时保存位置
  const stop = useCallback(() => {
    savePosition();
    pendingAutoPlayRef.current = false;
    if (autoNextTimerRef.current) {
      clearTimeout(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
    managerRef.current?.stop();
    reset();
  }, [reset, savePosition]);

  const togglePauseRef = useRef(togglePause);
  togglePauseRef.current = togglePause;
  playRef.current = play; // B1+B2 fix
  const stopRef = useRef(stop);
  // B2: 自动翻章后章节加载完自动播放
  useEffect(() => {
    if (pendingAutoPlayRef.current && chapterContent) {
      pendingAutoPlayRef.current = false;
      setTimeout(() => playRef.current(), 300);
    }
  }, [chapterContent, chapterIndex]);
  stopRef.current = stop;
  const onPrevRef = useRef(onPrevChapter);
  onPrevRef.current = onPrevChapter;
  const onNextRef = useRef(onNextChapter);
  onNextRef.current = onNextChapter;

  // Media Session API（手机锁屏/通知栏控制）
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapterTitle || "AI 小说朗读",
      artist: "AI 小说精读助手",
    });

    navigator.mediaSession.setActionHandler("play", () => playRef.current());
    navigator.mediaSession.setActionHandler("pause", () => togglePauseRef.current());
    navigator.mediaSession.setActionHandler("stop", () => stopRef.current());
    navigator.mediaSession.setActionHandler("previoustrack", () => onPrevRef.current?.());
    navigator.mediaSession.setActionHandler("nexttrack", () => onNextRef.current?.());

    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("stop", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
    };
  }, [chapterTitle]);

  // U5: 错误状态和自动重试
  const [error, setError] = useState<string | null>(null);
  const retryCountRef = useRef(0);

  // 当章节变化时重置错误
  useEffect(() => { setError(null); retryCountRef.current = 0; }, [chapterIndex, novelId]);

  // 是否在当前小说/章节播放
  const isActive = (playing || !!error) && currentNovelId === novelId && currentChapterIndex === chapterIndex;

  return {
    play,
    togglePause,
    stop,
    isActive,
    isPaused: paused,
    isPlaying: playing && !paused && isActive,
    error,
    retryCount: retryCountRef.current,
    seekToParagraph,
  };
}
