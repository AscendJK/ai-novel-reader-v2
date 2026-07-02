/**
 * AudioPlayer - TTS 播放栏组件
 * 固定在阅读界面底部，显示播放控制和进度
 */

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Play, Pause, Square, SkipForward, SkipBack,
  Loader2, RefreshCw, Timer, TimerOff, X,
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
const SLEEP_OPTIONS = [15, 30, 60, 90];

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatMinutes(m: number): string {
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm > 0 ? `${h}小时${rm}分钟` : `${h}小时`;
  }
  return `${m}分钟`;
}

export function AudioPlayer({
  novelId,
  chapterContent,
  chapterIndex,
  chapterTitle,
  onPrevChapter,
  onNextChapter,
}: AudioPlayerProps) {
  const generating = useTTSStore(s => s.generating);
  const generateProgress = useTTSStore(s => s.generateProgress);
  const currentParagraph = useTTSStore(s => s.currentParagraph);
  const totalParagraphs = useTTSStore(s => s.totalParagraphs);
  const speed = useTTSStore(s => s.speed);
  const setSpeed = useTTSStore(s => s.setSpeed);

  const { play, togglePause, stop, isActive, isPaused, isPlaying, error, retryCount, seekToParagraph } = useAudioPlayer({
    chapterContent,
    chapterIndex,
    novelId,
    chapterTitle,
    onPrevChapter,
    onNextChapter,
  });

  const canPlay = chapterContent && chapterContent.length > 0 && !generating;

  // 顶栏"朗读"按钮触发
  const startRequested = useTTSStore(s => s.startRequested);
  const prevStartRef = useRef(startRequested);
  useEffect(() => {
    if (startRequested > prevStartRef.current && canPlay) {
      prevStartRef.current = startRequested;
      play();
    }
  }, [startRequested, canPlay, play]);

  // U1: 计时器
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isPlaying) { return; }
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, [isPlaying]);
  useEffect(() => { if (!isActive) setElapsed(0); }, [isActive]);

  // F4: 睡眠定时器
  const [sleepTimer, setSleepTimer] = useState(0);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const sleepTimerRef = useRef(sleepTimer);
  sleepTimerRef.current = sleepTimer;
  useEffect(() => {
    if (sleepTimer > 0 && isPlaying) {
      setSleepRemaining(r => r > 0 ? r : sleepTimer);
      const t = setInterval(() => setSleepRemaining(r => {
        if (r <= 1) { clearInterval(t); if (sleepTimerRef.current > 0) stop(); return 0; }
        return r - 1;
      }), 60000);
      return () => clearInterval(t);
    } else if (sleepTimer === 0) { setSleepRemaining(0); }
  }, [sleepTimer, isPlaying]);

  // 弹出面板状态
  const [showSleepPopup, setShowSleepPopup] = useState(false);
  const [showSpeedPopup, setShowSpeedPopup] = useState(false);

  // 仅在朗读活动时显示播放栏（默认隐藏，需点顶栏"朗读"按钮触发）
  const showBar = isActive || isPaused || generating || !!error;
  if (!showBar) return null;

  // 估算剩余时间
  const estimatedTotal = totalParagraphs > 0 && currentParagraph > 0
    ? (elapsed / currentParagraph) * totalParagraphs
    : 0;
  const remaining = Math.max(0, estimatedTotal - elapsed);

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur border-t shadow-lg safe-area-bottom">
      {/* 生成进度 */}
      {generating && (
        <div className="h-1 bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${generateProgress}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-1 sm:gap-3 px-2 sm:px-4 py-2 max-w-4xl mx-auto">
        {/* 控制按钮 */}
        <div className="flex items-center gap-0.5 sm:gap-1">
          <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-1.5 sm:h-8 sm:w-8 sm:p-0"
            onClick={onPrevChapter} disabled={!onPrevChapter} title="上一章">
            <SkipBack className="h-4 w-4" />
          </Button>

          {isPlaying ? (
            <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-1.5 sm:h-8 sm:w-8 sm:p-0"
              onClick={togglePause} title="暂停">
              <Pause className="h-4 w-4" />
            </Button>
          ) : error ? (
            <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-1.5 sm:h-8 sm:w-8 sm:p-0"
              onClick={play} title="重试">
              <RefreshCw className="h-4 w-4" />
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-1.5 sm:h-8 sm:w-8 sm:p-0"
              onClick={isPaused ? togglePause : play}
              disabled={!canPlay || generating} title={isPaused ? "继续" : "播放"}>
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            </Button>
          )}

          {isActive && (
            <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-1.5 sm:h-8 sm:w-8 sm:p-0"
              onClick={stop} title="停止">
              <Square className="h-4 w-4" />
            </Button>
          )}

          <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-1.5 sm:h-8 sm:w-8 sm:p-0"
            onClick={onNextChapter} disabled={!onNextChapter} title="下一章">
            <SkipForward className="h-4 w-4" />
          </Button>
        </div>

        {/* 进度信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {error ? (
              <span className="text-[11px] sm:text-xs text-destructive truncate">朗读出错{retryCount > 0 ? `（已重试${retryCount}次）` : ""}</span>
            ) : (
              <>
                <span className="text-[11px] sm:text-xs text-muted-foreground truncate">
                  {chapterTitle || "未知章节"}
                </span>
                {isActive && totalParagraphs > 0 && (
                  <span className="text-[11px] sm:text-xs text-muted-foreground shrink-0 hidden sm:inline">
                    {currentParagraph}/{totalParagraphs} 段
                  </span>
                )}
              </>
            )}
          </div>
          {isActive && totalParagraphs > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 sm:h-1 bg-muted rounded-full overflow-hidden cursor-pointer"
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

        {/* U2: 语速按钮 */}
        <div className="shrink-0">
          <Button variant="ghost" size="sm" className="h-6 px-1 text-[11px] sm:text-xs tabular-nums"
            onClick={() => setShowSpeedPopup(v => !v)}
            title={`语速 ${speed}x`}>
            {speed}x
          </Button>
        </div>

        {/* 睡眠定时器按钮 */}
        <div className="shrink-0">
          <Button variant="ghost" size="sm" className="h-6 px-0.5 sm:px-1"
            onClick={() => setShowSleepPopup(v => !v)}
            title={sleepTimer === 0 ? "定时关闭" : `剩余 ${sleepRemaining} 分钟`}>
            {sleepTimer === 0 ? (
              <TimerOff className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <Timer className="h-3.5 w-3.5 text-primary" />
            )}
            {sleepTimer > 0 && (
              <span className="text-[9px] sm:text-[10px] ml-0.5 text-muted-foreground">{sleepRemaining}m</span>
            )}
          </Button>
        </div>

      </div>

      {/* ====== 定时弹出面板（移动端底部弹出，桌面端跟随按钮） ====== */}
      {showSleepPopup && (
        <>
          {/* 遮罩 */}
          <div className="fixed inset-0 z-50 bg-black/20 sm:bg-transparent"
            onClick={() => setShowSleepPopup(false)} />

          {/* 面板 */}
          <div
            className={`
              fixed z-50
              sm:absolute sm:bottom-full sm:right-2 sm:mb-2 sm:w-auto
              bottom-14 left-4 right-4 sm:left-auto sm:right-2
              p-4 rounded-xl border bg-card shadow-2xl
            `}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col gap-3 min-w-[200px]">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">定时关闭</span>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setShowSleepPopup(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {sleepTimer > 0 ? (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    将在 <span className="font-medium text-foreground">{formatMinutes(sleepRemaining)}</span> 后停止播放
                  </p>
                  <Button variant="outline" size="sm" className="w-full"
                    onClick={() => { setSleepTimer(0); setShowSleepPopup(false); }}>
                    取消定时
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {SLEEP_OPTIONS.map(m => (
                    <Button key={m} variant="outline" size="sm"
                      className="h-10 text-sm"
                      onClick={() => { setSleepTimer(m); setShowSleepPopup(false); }}>
                      {formatMinutes(m)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ====== 语速弹出面板 ====== */}
      {showSpeedPopup && (
        <>
          <div className="fixed inset-0 z-50 bg-black/20 sm:bg-transparent"
            onClick={() => setShowSpeedPopup(false)} />
          <div
            className={`
              fixed z-50
              sm:absolute sm:bottom-full sm:right-14 sm:mb-2 sm:w-auto
              bottom-14 left-4 right-4 sm:left-auto sm:right-14
              p-4 rounded-xl border bg-card shadow-2xl
            `}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col gap-3 min-w-[200px]">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">播放语速</span>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setShowSpeedPopup(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {SPEEDS.map(s => (
                  <Button key={s} variant={Math.abs(s - speed) < 0.01 ? "default" : "outline"}
                    size="sm" className="h-9 text-xs tabular-nums"
                    onClick={() => { setSpeed(s); setShowSpeedPopup(false); }}>
                    {s}x
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
