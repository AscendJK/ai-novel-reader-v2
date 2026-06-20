/**
 * AudioPlayer - TTS 播放栏组件
 * 固定在阅读界面底部，显示播放控制和进度
 */

import { Button } from "@/components/ui/button";
import {
  Play, Pause, Square, SkipForward, SkipBack,
  Volume2, Loader2, Cpu, Zap,
} from "lucide-react";
import { useTTSStore } from "@/stores/tts-store";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";

interface AudioPlayerProps {
  /** 小说 ID */
  novelId: string;
  /** 当前章节内容 */
  chapterContent: string | null;
  /** 当前章节索引 */
  chapterIndex: number;
  /** 当前章节标题 */
  chapterTitle?: string;
  /** 翻到上一章 */
  onPrevChapter?: () => void;
  /** 翻到下一章 */
  onNextChapter?: () => void;
}

export function AudioPlayer({
  novelId,
  chapterContent,
  chapterIndex,
  chapterTitle,
  onPrevChapter,
  onNextChapter,
}: AudioPlayerProps) {
  const {
    generating, generateProgress,
    currentParagraph, totalParagraphs,
    capability, speed, engine,
    setSpeed,
  } = useTTSStore();

  const { play, togglePause, stop, isActive, isPaused, isPlaying } = useAudioPlayer({
    chapterContent,
    chapterIndex,
    novelId,
    chapterTitle,
    onPrevChapter,
    onNextChapter,
  });

  const canPlay = chapterContent && chapterContent.length > 0;
  const isWebGPU = capability?.device === "webgpu";

  // 不显示播放栏的情况
  if (!canPlay && !isActive) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur border-t shadow-lg">
      {/* 生成进度 */}
      {generating && (
        <div className="h-1 bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${generateProgress}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-3 px-4 py-2 max-w-4xl mx-auto">
        {/* 控制按钮 */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onPrevChapter}
            disabled={!onPrevChapter}
            title="上一章"
          >
            <SkipBack className="h-4 w-4" />
          </Button>

          {isPlaying ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={togglePause}
              title="暂停"
            >
              <Pause className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={isPaused ? togglePause : play}
              disabled={!canPlay || generating}
              title={isPaused ? "继续" : "播放"}
            >
              {generating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
          )}

          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={stop}
              title="停止"
            >
              <Square className="h-4 w-4" />
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onNextChapter}
            disabled={!onNextChapter}
            title="下一章"
          >
            <SkipForward className="h-4 w-4" />
          </Button>
        </div>

        {/* 段落进度 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground truncate">
              {chapterTitle || "未知章节"}
            </span>
            {isActive && totalParagraphs > 0 && (
              <span className="text-xs text-muted-foreground shrink-0">
                {currentParagraph}/{totalParagraphs} 段
              </span>
            )}
          </div>
          {isActive && totalParagraphs > 0 && (
            <div className="w-full h-1 bg-muted rounded-full mt-1 overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${(currentParagraph / totalParagraphs) * 100}%` }}
              />
            </div>
          )}
        </div>

        {/* 语速 */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            className="text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted"
            onClick={() => {
              const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
              const current = speeds.indexOf(speed);
              const next = speeds[(current + 1) % speeds.length];
              setSpeed(next);
            }}
            title="点击切换语速"
          >
            {speed}x
          </button>
        </div>

        {/* 推理模式指示 */}
        <div className="shrink-0">
          {engine === "kokoro" ? (
            isWebGPU ? (
              <Zap className="h-3.5 w-3.5 text-green-500" title="WebGPU 加速" />
            ) : (
              <Cpu className="h-3.5 w-3.5 text-amber-500" title="CPU 推理" />
            )
          ) : (
            <Volume2 className="h-3.5 w-3.5 text-muted-foreground" title="Web Speech API" />
          )}
        </div>
      </div>
    </div>
  );
}
