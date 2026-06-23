/**
 * AudioPlayer - TTS 播放栏组件
 * 固定在阅读界面底部，显示播放控制和进度
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Play, Pause, Square, SkipForward, SkipBack,
  Volume2, Loader2, Cpu, ChevronUp, ChevronDown, RefreshCw,
  Timer, TimerOff,
} from "lucide-react";
import { useTTSStore } from "@/stores/tts-store";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";

interface AudioPlayerProps {
  novelId: string;
  chapterContent: string | null;
  chapterIndex: number;
  chapterTitle?: string;
  onPrevChapter?: () => void;
  onNextChapter?: () => void;
}

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
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
    speed, engine,
    setSpeed,
  } = useTTSStore();

  const { play, togglePause, stop, isActive, isPaused, isPlaying, error, retryCount, seekToParagraph } = useAudioPlayer({
    chapterContent,
    chapterIndex,
    novelId,
    chapterTitle,
    onPrevChapter,
    onNextChapter,
  });

  const canPlay = chapterContent && chapterContent.length > 0 && !generating;

  // U1: 计时器
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isPlaying) { if (!isActive) setElapsed(0); return; }
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, [isPlaying, isActive]);

  // F4: 睡眠定时器 (0=关闭, 15/30/60分钟)
  const [sleepTimer, setSleepTimer] = useState(0);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  useEffect(() => {
    if (sleepTimer > 0 && isPlaying) {
      setSleepRemaining(sleepTimer);
      const t = setInterval(() => setSleepRemaining(r => {
        if (r <= 1) { clearInterval(t); stop(); return 0; }
        return r - 1;
      }), 60000);
      return () => clearInterval(t);
    } else { setSleepRemaining(0); }
  }, [sleepTimer, isPlaying]);

  // U4: 播放结束或错误时也保留播放栏
  const showBar = canPlay || isActive || isPaused || generating || error;
  if (!showBar) return null;

  // 估算剩余时间
  const estimatedTotal = totalParagraphs > 0 && currentParagraph > 0
    ? (elapsed / currentParagraph) * totalParagraphs
    : 0;
  const remaining = Math.max(0, estimatedTotal - elapsed);

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
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
            onClick={onPrevChapter} disabled={!onPrevChapter} title="上一章">
            <SkipBack className="h-4 w-4" />
          </Button>

          {isPlaying ? (
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
              onClick={togglePause} title="暂停">
              <Pause className="h-4 w-4" />
            </Button>
          ) : error ? (
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
              onClick={play} title="重试">
              <RefreshCw className="h-4 w-4" />
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
              onClick={isPaused ? togglePause : play}
              disabled={!canPlay || generating} title={isPaused ? "继续" : "播放"}>
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            </Button>
          )}

          {isActive && (
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
              onClick={stop} title="停止">
              <Square className="h-4 w-4" />
            </Button>
          )}

          <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
            onClick={onNextChapter} disabled={!onNextChapter} title="下一章">
            <SkipForward className="h-4 w-4" />
          </Button>
        </div>

        {/* 进度信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {error ? (
              <span className="text-xs text-destructive truncate">朗读出错{retryCount > 0 ? `（已重试${retryCount}次）` : ""}</span>
            ) : (
              <>
                <span className="text-xs text-muted-foreground truncate">
                  {chapterTitle || "未知章节"}
                </span>
                {isActive && totalParagraphs > 0 && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {currentParagraph}/{totalParagraphs} 段
                  </span>
                )}
              </>
            )}
          </div>
          {isActive && totalParagraphs > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden cursor-pointer"
                onClick={(e) => {
                  if (!seekToParagraph || totalParagraphs === 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  const targetPara = Math.floor(ratio * (totalParagraphs - 1));
                  seekToParagraph(targetPara);
                }}
                title="点击跳转到指定段落">
                <div className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${(currentParagraph / totalParagraphs) * 100}%` }} />
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {formatTime(elapsed)}{remaining > 0 ? ` / -${formatTime(remaining)}` : ""}
              </span>
            </div>
          )}
        </div>

        {/* U2: 语速双向调节 */}
        <div className="flex items-center gap-0.5 shrink-0">
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
            onClick={() => {
              const idx = SPEEDS.findIndex(s => Math.abs(s - speed) < 0.01);
              if (idx > 0) setSpeed(SPEEDS[idx - 1]);
            }} title="减速">
            <ChevronDown className="h-3 w-3" />
          </Button>
          <button className="text-xs text-muted-foreground hover:text-foreground px-1 min-w-[2.5rem] text-center"
            onClick={() => {
              const idx = SPEEDS.findIndex(s => Math.abs(s - speed) < 0.01);
              if (idx >= 0) setSpeed(SPEEDS[(idx + 1) % SPEEDS.length]);
            }} title="点击切换语速">
            {speed}x
          </button>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
            onClick={() => {
              const idx = SPEEDS.findIndex(s => Math.abs(s - speed) < 0.01);
              if (idx < SPEEDS.length - 1) setSpeed(SPEEDS[idx + 1]);
            }} title="加速">
            <ChevronUp className="h-3 w-3" />
          </Button>
        </div>

        {/* F4: 睡眠定时器 */}
        <div className="shrink-0">
          <Button variant="ghost" size="sm" className="h-6 px-1"
            onClick={() => setSleepTimer(t => t === 0 ? 15 : t === 15 ? 30 : t === 30 ? 60 : 0)}
            title={sleepTimer === 0 ? "睡眠定时器" : `剩余 ${sleepRemaining} 分钟，点击切换`}>
            {sleepTimer === 0 ? <TimerOff className="h-3 w-3 text-muted-foreground" /> : <Timer className="h-3 w-3 text-primary" />}
            {sleepTimer > 0 && <span className="text-[10px] ml-1 text-muted-foreground">{sleepRemaining}m</span>}
          </Button>
        </div>

        {/* 引擎指示 */}
        <div className="shrink-0">
          {engine === "zipvoice" ? (
            <span title="ZipVoice 离线语音"><Cpu className="h-3.5 w-3.5 text-amber-500" /></span>
          ) : (
            <span title="Web Speech API"><Volume2 className="h-3.5 w-3.5 text-muted-foreground" /></span>
          )}
        </div>
      </div>
    </div>
  );
}
