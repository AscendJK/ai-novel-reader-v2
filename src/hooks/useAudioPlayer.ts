/**
 * useAudioPlayer - TTS 播放逻辑 Hook
 * 管理 TTS 播放状态、段落进度、自动翻章
 */

import { useRef, useCallback, useEffect, useState } from "react";
import { useTTSStore } from "@/stores/tts-store";
import { TTSManager } from "@/tts/tts-manager";
import { prepareTextForTTS } from "@/tts/text-preprocess";
import { showToast } from "@/components/common/Toast";

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
    playing, paused, speed, voiceId, engine, autoNextChapter,
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

    const chunks = paragraphs.map((text, i) => ({ text, index: i }));
    await manager.speak(chunks, {
      onPlay: () => {
        setGenerating(false);
        setPlaying(true);
      },
      onChunkStart: (i, total) => setParagraphProgress(i, total),
      onChunkEnd: (i, total) => setParagraphProgress(i + 1, total),
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
        setError(err);
        // U5: 自动重试（Web Speech API 常见瞬时错误）
        if (retryCountRef.current < 3) {
          retryCountRef.current++;
          setTimeout(() => {
            if (managerRef.current) {
              setError(null);
              setGenerating(true);
              // 重试当前段落
              managerRef.current.seekToChunk(
                managerRef.current.getCurrentChunkIndex()
              );
            }
          }, 2000);
        }
        showToast(`朗读出错: ${err}`, "warn");
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

  // 停止
  const stop = useCallback(() => {
    pendingAutoPlayRef.current = false;
    if (autoNextTimerRef.current) {
      clearTimeout(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
    managerRef.current?.stop();
    reset();
  }, [reset]);

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
  };
}
