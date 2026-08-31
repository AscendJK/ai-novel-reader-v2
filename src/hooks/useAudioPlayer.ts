/**
 * useAudioPlayer - TTS 播放逻辑 Hook
 * 管理 TTS 播放状态、段落进度、自动翻章
 */

import { useRef, useCallback, useEffect, useState } from "react";
import { useTTSStore } from "@/stores/tts-store";
import { TTSManager, type TTSChunk } from "@/tts/tts-manager";
import { setWorkerPoolSize } from "@/tts/zipvoice-engine";
import { prepareTextForTTS, buildOrderedParaIndices, findChunkIndexByPara } from "@/tts/text-preprocess";
import { useScreenWakeLock } from "@/hooks/useScreenWakeLock";
import { showToast } from "@/lib/toast-store";

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
  // U13: 自动翻章超时兜底（翻章后 20 秒未开始新章则复位）
  const pendingAutoNextTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // B5: 自动翻章后等新章节加载完成再自动播放
  const pendingAutoPlayRef = useRef(false);
  // U14: 自动翻章的目标章节索引。chapterIndex 必须到达该索引后才自动播放，
  // 防止异步加载章节时 addChapters 先替换当前章内容触发误播放（自动翻章概率停止根因）
  const pendingAutoPlayIndexRef = useRef<number | null>(null);
  // 自动播放延迟定时器（stop/卸载时清理；调度建立后不随重渲染取消，避免竞态丢失播放）
  const pendingAutoPlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    playing, paused, generating, speed, playbackRate, pitch, voiceId, engine, autoNextChapter, chunkSize,
    prefetchCount, workerCount,
    currentNovelId, currentChapterIndex,
    setPlaying, setPaused, setCurrentChapter,
    setParagraphProgress, setGenerating, setEngine,
    setModelDownloaded, setModelDownloading, setBrowserVoices, reset,
    setPrepareProgress, setBufferedChunks,
  } = useTTSStore();

  // 初始化/销毁 TTS 管理器
  useEffect(() => {
    return () => {
      if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current);
      if (pendingAutoNextTimeoutRef.current) clearTimeout(pendingAutoNextTimeoutRef.current);
      if (pendingAutoPlayTimerRef.current) clearTimeout(pendingAutoPlayTimerRef.current);
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, []);

  // 朗读/生成期间保持屏幕常亮（防移动端息屏；暂停时释放）
  useScreenWakeLock((playing || generating) && !paused);

  // M19+R7: 翻章时清除定时器+停止旧播放
  useEffect(() => {
    const hadPendingAutoNext = autoNextTimerRef.current !== null;
    if (autoNextTimerRef.current) {
      clearTimeout(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
    if (hadPendingAutoNext) {
      // R13: 自动翻章定时器还没触发 — 用户手动切章，清除自动播放标志
      pendingAutoPlayRef.current = false;
      pendingAutoPlayIndexRef.current = null;
      managerRef.current?.stop();
      reset();
    } else if (pendingAutoPlayRef.current && pendingAutoPlayIndexRef.current !== null
      && pendingAutoPlayIndexRef.current !== chapterIndex) {
      // U14: 自动翻章流程中（定时器已触发）用户手动切到其他章节 → 取消自动播放
      pendingAutoPlayRef.current = false;
      pendingAutoPlayIndexRef.current = null;
      if (pendingAutoPlayTimerRef.current) {
        clearTimeout(pendingAutoPlayTimerRef.current);
        pendingAutoPlayTimerRef.current = null;
      }
      if (pendingAutoNextTimeoutRef.current) {
        clearTimeout(pendingAutoNextTimeoutRef.current);
        pendingAutoNextTimeoutRef.current = null;
      }
      managerRef.current?.stop();
      reset();
    } else if (!pendingAutoPlayRef.current) {
      // R7: 非自动翻章场景，正常停止旧播放（防止旧章音频继续朗读）
      managerRef.current?.stop();
      reset();
    }
    // pendingAutoPlayRef 为 true 且已到达目标章节 → 自动翻章正常流程，autoplay effect 处理
  }, [chapterIndex, reset]);

  const playRef = useRef<typeof play>(null!); // B4+B5: 在 play 定义前声明，定义后赋值
  const chunksRef = useRef<TTSChunk[]>([]); // 存储当前 chunk 列表，供 seekToParagraph 查找
  // 过滤后保留的原始段落索引有序数组（用于进度条/段数显示/seek 的统一坐标）
  const [orderedParaIndices, setOrderedParaIndices] = useState<number[]>([]);

  // 错误状态和重试计数（在 play 前声明，供 play 回调引用）
  const [error, setError] = useState<string | null>(null);
  const retryCountRef = useRef(0);
  const [retryCount, setRetryCount] = useState(0); // 用于渲染层读取

  // 语速/语音变化时同步到管理器
  useEffect(() => {
    if (managerRef.current) {
      managerRef.current.setSpeed(speed);
    }
  }, [speed]);

  // 播放倍速独立同步（ZipVoice 即时生效，WebSpeech 重新 speak）
  useEffect(() => {
    if (managerRef.current) {
      managerRef.current.setPlaybackRate(playbackRate);
    }
  }, [playbackRate]);

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

  // F10: 恢复上次朗读位置（基于原始段落索引）
  const loadPosition = useCallback((): number | null => {
    try {
      const raw = localStorage.getItem(TTS_POS_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (pos.novelId === novelId && pos.chapterIndex === chapterIndex) return pos.paragraph;
    } catch { /* 缓存损坏时忽略 */ }
    return null;
  }, [novelId, chapterIndex]);

  // 播放当前章节
  const play = useCallback(async () => {
    if (!chapterContent || chapterIndex == null || !novelId) return;

    const manager = getManager();
    manager.setEngine(engine);
    manager.setVoice(voiceId);
    manager.setSpeed(speed);
    manager.setPlaybackRate(playbackRate);
    manager.setPitch(pitch);
    manager.setPrefetchCount(prefetchCount);
    // 浏览器推理并行 Worker 数：朗读前应用（模型未加载时生效）
    setWorkerPoolSize(workerCount);
    // 手势窗口内提前创建 AudioContext：首次朗读模型加载需数秒，
    // 若等 speak 内才创建，手势过期 → resume 被拒 → 生成成功但无声
    manager.prewarmZipVoiceAudio();

    setCurrentChapter(novelId, chapterIndex);
    setGenerating(true);

    // 单次生成 ≤chunkSize 字（设置页可调，三引擎各自独立：server 150 / zipvoice 60 / webspeech 300）
    const chunkLimit = chunkSize;
    // server 引擎用段落级生成（每 chunk = 1 段）：chunk 边界 = 段落边界 → 高亮精确，零时间估算。
    // zipvoice 推理慢需合并短段摊薄成本；webspeech 有 onboundary 精确追踪，无需段落级。
    const prepared = prepareTextForTTS(chapterContent, chunkLimit, engine === "server");
    // 从 prepareTextForTTS 结果中提取段落总数（已过滤短段落）
    // 每个 chunk 的 paragraphIndices 长度之和即为实际段落数
    const totalParaCount = prepared.reduce((sum, c) => sum + c.paragraphIndices.length, 0);
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
    // 展开所有 chunk 的段落索引 → 过滤后保留的原始段落索引有序数组
    // 进度条/段数显示/seek 统一用“过滤后序号”（在此数组中的位置），
    // 高亮仍用原始段落索引（store.currentParagraph），两者解耦不再错位
    setOrderedParaIndices(buildOrderedParaIndices(prepared));

    // F10: 恢复上次朗读位置（保存的是原始段落索引）
    const savedPara = loadPosition();
    let startChunkIdx = 0;
    if (savedPara != null && savedPara > 0) {
      // 精确定位：优先找“包含 savedPara 的 chunk”（组内任意段），
      // 避免只用组内第一段比较导致恢复时跳到下一组丢句
      startChunkIdx = findChunkIndexByPara(chunks, savedPara);
    }
    setParagraphProgress(chunks[startChunkIdx]?.paragraphIndex ?? 0, totalParaCount);

    const startChunks = startChunkIdx > 0 ? chunks.slice(startChunkIdx) : chunks;
    await manager.speak(startChunks, {
      onPlay: () => {
        setGenerating(false);
        setPlaying(true);
        setError(null); // R3F3: 手动重试成功，清除错误
        setPrepareProgress(0, 0); // 预生成阶段结束
      },
      onPrepareProgress: (ready, total) => {
        setPrepareProgress(ready, total);
        // 预生成阶段保持"生成中"状态（播放栏显示进度），完成后 onPlay 清掉
        if (total > 0) setGenerating(true);
      },
      onBufferChange: (buffered) => setBufferedChunks(buffered),
      onGenerating: (g) => setGenerating(g),
      onChunkStart: (_i, _total, paraIdx) => setParagraphProgress(paraIdx, totalParaCount),
      onChunkEnd: (_i, _total, paraIdx) => setParagraphProgress(paraIdx, totalParaCount),
      onParagraphChange: (paraIdx) => setParagraphProgress(paraIdx, totalParaCount),
      onEnd: () => {
        setPaused(false);
        if (autoNextChapter && onNextChapter) {
          // 防止重复 onEnd（浏览器偶发）重复调度翻章
          if (pendingAutoPlayRef.current) return;
          // B5: 标记自动翻章进行中，等新章节加载完自动播放
          pendingAutoPlayRef.current = true;
          // U14: 记录目标章节索引，chapterIndex 到达后才自动播放
          pendingAutoPlayIndexRef.current = (chapterIndex ?? 0) + 1;
          // U12: 翻章间隙保持播放栏可见（generating=true 表示“准备下一章”），
          // 避免播放栏消失被用户感知为“退出朗读”；新章 onPlay 后恢复正常
          setGenerating(true);
          autoNextTimerRef.current = setTimeout(() => {
            autoNextTimerRef.current = null;
            onNextChapter();
          }, 500);
          // U13: 若翻章后 20 秒内未成功开始新章播放，恢复未播放状态（防止卡在“生成中”）
          pendingAutoNextTimeoutRef.current = setTimeout(() => {
            if (pendingAutoPlayRef.current) {
              pendingAutoPlayRef.current = false;
              pendingAutoPlayIndexRef.current = null;
              setGenerating(false);
              setPlaying(false);
            }
          }, 20000);
        } else {
          setPlaying(false);
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
          setRetryCount(count + 1);
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
  }, [chapterContent, chapterIndex, novelId, engine, voiceId, speed, playbackRate, pitch, autoNextChapter, getManager, setCurrentChapter, setGenerating, setParagraphProgress, setPlaying, setPaused, onNextChapter, loadPosition, setBrowserVoices, setEngine, setModelDownloaded, setModelDownloading, chunkSize, prefetchCount, workerCount, setPrepareProgress, setBufferedChunks]);

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
      // 精确定位所在 chunk（组内任意段），找不到时回退到最近的后续 chunk
      const chunkIdx = findChunkIndexByPara(chunks, paraIndex);
      if (chunkIdx >= 0) {
        manager.seekToChunk(chunkIdx);
        // C: seek 后立即上报目标段落（而非等 chunk 播放到该段），高亮即时到位不经过组内第一段
        setParagraphProgress(paraIndex, useTTSStore.getState().totalParagraphs || 0);
      }
    } else {
      try { localStorage.setItem(TTS_POS_KEY, JSON.stringify({ novelId, chapterIndex, paragraph: paraIndex })); } catch { /* localStorage 不可用时忽略 */ }
      play();
    }
  }, [getManager, play, novelId, chapterIndex, setParagraphProgress]);

  // F10: 保存/恢复朗读位置（基于原始段落索引）
  const savePosition = useCallback(() => {
    const s = useTTSStore.getState();
    if (s.currentNovelId && s.currentChapterIndex != null) {
      try { localStorage.setItem(TTS_POS_KEY, JSON.stringify({ novelId: s.currentNovelId, chapterIndex: s.currentChapterIndex, paragraph: s.currentParagraph })); } catch { /* localStorage 不可用时忽略 */ }
    }
  }, []);

  // 停止时保存位置
  const stop = useCallback(() => {
    savePosition();
    pendingAutoPlayRef.current = false;
    pendingAutoPlayIndexRef.current = null;
    if (pendingAutoPlayTimerRef.current) {
      clearTimeout(pendingAutoPlayTimerRef.current);
      pendingAutoPlayTimerRef.current = null;
    }
    if (autoNextTimerRef.current) {
      clearTimeout(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
    if (pendingAutoNextTimeoutRef.current) {
      clearTimeout(pendingAutoNextTimeoutRef.current);
      pendingAutoNextTimeoutRef.current = null;
    }
    managerRef.current?.stop();
    reset();
  }, [reset, savePosition]);

  const togglePauseRef = useRef(togglePause);
  useEffect(() => { togglePauseRef.current = togglePause; }, [togglePause]);
  useEffect(() => { playRef.current = play; }, [play]); // B1+B2 fix
  const stopRef = useRef(stop);
  // B2: 自动翻章后章节加载完自动播放
  useEffect(() => {
    if (!pendingAutoPlayRef.current) return;
    // U14: 目标章节未就绪（chapterIndex 未到达目标）时不消费标志。
    // 异步加载章节时 addChapters 会先替换当前章内容并触发重渲染，
    // 若此刻消费标志，后续 setSelectedChapter 的 cleanup 会取消已调度的
    // 播放且无人再调度 → 朗读静默停止（自动翻章概率停止的根因）。
    if (chapterIndex == null || pendingAutoPlayIndexRef.current !== chapterIndex) return;
    if (!chapterContent || chapterContent.length === 0) return; // 内容未加载，继续等待
    if (pendingAutoPlayTimerRef.current) return; // 已为该章节调度过，避免重复
    // 目标章节已就绪，取消 U13 超时兜底（自动播放即将开始）
    if (pendingAutoNextTimeoutRef.current) {
      clearTimeout(pendingAutoNextTimeoutRef.current);
      pendingAutoNextTimeoutRef.current = null;
    }
    // U12: 延迟到 play 引用稳定后再播（play 依赖 chapterContent，
    // 若立即调用可能捕获到旧的闭包导致直接 return）
    const targetIndex = chapterIndex;
    pendingAutoPlayTimerRef.current = setTimeout(() => {
      pendingAutoPlayTimerRef.current = null;
      // 最终校验：期间被 stop/手动切章则不自动播放
      if (!pendingAutoPlayRef.current) return;
      if (pendingAutoPlayIndexRef.current !== targetIndex) return;
      pendingAutoPlayRef.current = false;
      pendingAutoPlayIndexRef.current = null;
      playRef.current();
    }, 350);
    // 注意：不返回 cleanup —— 调度一旦建立，后续重渲染（如同章节内容再次
    // 更新）不得取消自动播放；取消只能通过 stop()/手动切章/组件卸载
  }, [chapterContent, chapterIndex]);
  useEffect(() => { stopRef.current = stop; }, [stop]);
  const onPrevRef = useRef(onPrevChapter);
  useEffect(() => { onPrevRef.current = onPrevChapter; }, [onPrevChapter]);
  const onNextRef = useRef(onNextChapter);
  useEffect(() => { onNextRef.current = onNextChapter; }, [onNextChapter]);

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

  // 当章节变化时重置错误和重试计数
  useEffect(() => {
    retryCountRef.current = 0;
    const raf = requestAnimationFrame(() => {
      setError(null);
      setRetryCount(0);
    });
    return () => cancelAnimationFrame(raf);
  }, [chapterIndex, novelId]);
  const isActive = (playing || !!error) && currentNovelId === novelId && currentChapterIndex === chapterIndex;

  // 定期保存朗读位置（每 10 秒 + 页面卸载时）
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(savePosition, 10000);
    const handleBeforeUnload = () => savePosition();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isActive, savePosition]);

  return {
    play,
    togglePause,
    stop,
    isActive,
    isPaused: paused,
    isPlaying: playing && !paused && isActive,
    error,
    retryCount,
    seekToParagraph,
    /** 跳过剩余预生成，立即开始播放（至少 1 段就绪时有效） */
    skipPrepare: () => getManager().skipPrepare(),
    // 过滤后保留的原始段落索引有序数组，供进度条/段数显示/seek 统一坐标
    orderedParaIndices,
  };
}
