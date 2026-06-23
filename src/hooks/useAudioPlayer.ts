/**
 * useAudioPlayer - TTS 播放逻辑 Hook
 * 管理 TTS 播放状态、段落进度、自动翻章
 */

import { useRef, useCallback, useEffect, useState } from "react";
import { useTTSStore } from "@/stores/tts-store";
import { TTSManager } from "@/tts/tts-manager";
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
    playing, paused, speed, volume, pitch, voiceId, engine, autoNextChapter,
    currentNovelId, currentChapterIndex,
    setPlaying, setPaused, setCurrentChapter,
    setParagraphProgress, setGenerating, setEngine,
    setModelDownloaded, setModelDownloading, reset,
  } = useTTSStore();

  // 初始化/销毁 TTS 管理器
  useEffect(() => {
    return () => {
      if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current);
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, []);

  // M19: 手动翻章时清除自动翻章定时器
  useEffect(() => {
    if (autoNextTimerRef.current) {
      clearTimeout(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
  }, [chapterIndex]);

  // B5: 自动翻章后等新章节内容加载完成，自动恢复播放
  useEffect(() => {
    if (pendingAutoPlayRef.current && chapterContent) {
      pendingAutoPlayRef.current = false;
      // 延迟一小段确保章节切换完成
      setTimeout(() => play(), 300);
    }
  }, [chapterContent, chapterIndex]);

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
    if (managerRef.current) managerRef.current.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    if (managerRef.current) managerRef.current.setPitch(pitch);
  }, [pitch]);

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

    setCurrentChapter(novelId, chapterIndex);
    setGenerating(true);

    const paragraphs = prepareTextForTTS(chapterContent);
    setParagraphProgress(0, paragraphs.length);
    if (paragraphs.length === 0) {
      setGenerating(false);
      return;
    }

    // F10: 恢复上次朗读位置
    const savedPara = loadPosition();
    const startIndex = savedPara && savedPara > 0 && savedPara < paragraphs.length ? savedPara : 0;
    setParagraphProgress(startIndex, paragraphs.length);

    const chunks = paragraphs.map((text, i) => ({ text, index: i }));
    // F10: 从保存位置开始
    const startChunks = startIndex > 0 ? chunks.slice(startIndex) : chunks;
    await manager.speak(startChunks, {
      onPlay: () => {
        setGenerating(false);
        setPlaying(true);
      },
      onChunkStart: (i, total) => setParagraphProgress(startIndex + i, startIndex + total),
      onChunkEnd: (i, total) => setParagraphProgress(startIndex + i + 1, startIndex + total),
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
    }).catch((err) => {
      console.error("[TTS] speak failed:", err);
      setGenerating(false);
      setPlaying(false);
    });
  }, [chapterContent, chapterIndex, novelId, engine, voiceId, speed, autoNextChapter, getManager, setCurrentChapter, setGenerating, setParagraphProgress, setPlaying, onNextChapter]);

  // 暂停/恢复
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

  // F2+F3: 跳到指定段落并开始朗读
  const seekToParagraph = useCallback((index: number) => {
    const manager = getManager();
    if (manager.isPlaying() || manager.isPaused()) {
      manager.seekToChunk(index);
    } else {
      // 保存目标位置，play 时会从 saved 位置开始（F10 LoadPosition 已处理）
      try { localStorage.setItem(TTS_POS_KEY, JSON.stringify({ novelId, chapterIndex, paragraph: index })); } catch {}
      play();
    }
  }, [getManager, play, novelId, chapterIndex]);

  // F10: 保存/恢复朗读位置
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

  // B4: 用 ref 存最新回调，避免 Media Session 闭包捕获旧章节引用
  const playRef = useRef(play);
  playRef.current = play;
  const togglePauseRef = useRef(togglePause);
  togglePauseRef.current = togglePause;
  const stopRef = useRef(stop);
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
  const maxRetries = 3;

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
