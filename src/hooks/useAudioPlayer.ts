/**
 * useAudioPlayer - TTS 播放逻辑 Hook
 * 管理 TTS 播放状态、段落进度、自动翻章
 */

import { useRef, useCallback, useEffect } from "react";
import { useTTSStore } from "@/stores/tts-store";
import { TTSManager } from "@/tts/tts-manager";
import { prepareTextForTTS } from "@/tts/text-preprocess";

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

  const {
    playing, paused, speed, voiceId, engine, autoNextChapter,
    currentNovelId, currentChapterIndex,
    setPlaying, setPaused, setCurrentChapter,
    setParagraphProgress, setGenerating, setEngine, reset,
  } = useTTSStore();

  // 初始化/销毁 TTS 管理器
  useEffect(() => {
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, []);

  // 语速变化时同步到管理器（清除预生成缓冲使新语速立即生效）
  useEffect(() => {
    if (managerRef.current) {
      managerRef.current.setSpeed(speed);
    }
  }, [speed]);

  // Media Session API（手机锁屏/通知栏控制）
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapterTitle || "AI 小说朗读",
      artist: "AI 小说精读助手",
    });

    navigator.mediaSession.setActionHandler("play", () => play());
    navigator.mediaSession.setActionHandler("pause", () => togglePause());
    navigator.mediaSession.setActionHandler("stop", () => stop());
    navigator.mediaSession.setActionHandler("previoustrack", () => onPrevChapter?.());
    navigator.mediaSession.setActionHandler("nexttrack", () => onNextChapter?.());

    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("stop", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
    };
  }, [chapterTitle, play, togglePause, stop, onPrevChapter, onNextChapter]);

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
    setGenerating(false);

    if (paragraphs.length === 0) {
      setPlaying(false);
      return;
    }

    setPlaying(true);

    const chunks = paragraphs.map((text, i) => ({ text, index: i }));
    await manager.speak(chunks, {
      onPlay: () => setPlaying(true),
      onChunkStart: (i, total) => setParagraphProgress(i, total),
      onChunkEnd: (i, total) => setParagraphProgress(i + 1, total),
      onEnd: () => {
        setPlaying(false);
        if (autoNextChapter && onNextChapter) {
          // 延迟一下再翻章，让用户看到"播放完毕"
          setTimeout(() => onNextChapter(), 500);
        }
      },
      onError: (err) => {
        console.error("[TTS] Error:", err);
        setPlaying(false);
      },
      onStop: () => setPlaying(false),
      onFallback: (_from, to) => {
        // 同步 store 的引擎状态
        setEngine(to);
      },
    });
  }, [chapterContent, chapterIndex, novelId, engine, voiceId, speed, autoNextChapter, getManager, setCurrentChapter, setGenerating, setParagraphProgress, setPlaying, onNextChapter]);

  // 暂停/恢复
  const togglePause = useCallback(() => {
    const manager = getManager();
    if (manager.isPaused()) {
      manager.resume();
      setPaused(false);
    } else if (manager.isPlaying()) {
      manager.pause();
      setPaused(true);
    }
  }, [getManager, setPaused]);

  // 停止
  const stop = useCallback(() => {
    managerRef.current?.stop();
    reset();
  }, [reset]);

  // 是否在当前小说/章节播放
  const isActive = playing && currentNovelId === novelId && currentChapterIndex === chapterIndex;

  return {
    play,
    togglePause,
    stop,
    isActive,
    isPaused: paused,
    isPlaying: playing && isActive,
  };
}
