import { useState, useEffect, useMemo } from "react";
import { Search, ArrowLeft, Trash2, StickyNote, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { loadAllNotes, deleteNote, loadAllNovelMeta, type NoteItem } from "@/db/repositories";
import type { NovelMeta } from "@/parsers/types";
import { syncClient } from "@/sync/sync-client";

interface Props {
  onBack: () => void;
}

export function GlobalNotes({ onBack }: Props) {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [novels, setNovels] = useState<NovelMeta[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [novelFilter, setNovelFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "user" | "ai">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadAllNotes().then(setNotes);
    loadAllNovelMeta().then(setNovels);
  }, []);

  const novelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of novels) m.set(n.id, n.title);
    return m;
  }, [novels]);

  const filtered = useMemo(() => {
    return notes.filter((n) => {
      if (novelFilter !== "all" && n.novelId !== novelFilter) return false;
      if (sourceFilter !== "all" && n.source !== sourceFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const title = novelMap.get(n.novelId)?.toLowerCase() || "";
        return n.content.toLowerCase().includes(q) || n.chapterTitle.toLowerCase().includes(q) || title.includes(q);
      }
      return true;
    });
  }, [notes, novelFilter, sourceFilter, searchQuery, novelMap]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除这条笔记？")) return;
    await deleteNote(id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
    syncClient.pushNow();
  };

  return (
    <div className="h-full flex flex-col p-4 md:p-6">
      <div className="flex items-center gap-3 mb-4 shrink-0">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> 返回
        </Button>
        <StickyNote className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">全部笔记</h2>
        <span className="text-sm text-muted-foreground">({filtered.length})</span>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            id="notes-search" name="notes-search"
            placeholder="搜索笔记内容、章节、书名..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <select
          id="notes-novel-filter" name="notes-novel-filter"
          value={novelFilter}
          onChange={(e) => setNovelFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border bg-background"
        >
          <option value="all">全部小说</option>
          {novels.map((n) => (
            <option key={n.id} value={n.id}>{n.title}</option>
          ))}
        </select>
        <select
          id="notes-source-filter" name="notes-source-filter"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as "all" | "user" | "ai")}
          className="px-3 py-2 text-sm rounded-md border bg-background"
        >
          <option value="all">全部来源</option>
          <option value="user">用户笔记</option>
          <option value="ai">AI 笔记</option>
        </select>
      </div>

      {/* Notes list */}
      <div className="flex-1 overflow-auto space-y-2">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
            {notes.length === 0 ? "暂无笔记" : "没有匹配的笔记"}
          </div>
        ) : (
          filtered.map((note) => {
            const isExpanded = expanded.has(note.id);
            const novelTitle = novelMap.get(note.novelId) || "未知小说";
            return (
              <Card key={note.id} className="group">
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <Badge variant={note.source === "ai" ? "secondary" : "outline"} className="text-[10px]">
                          {note.source === "ai" ? "AI" : "笔记"}
                        </Badge>
                        <span className="text-xs text-muted-foreground truncate">{novelTitle}</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground truncate">{note.chapterTitle}</span>
                        <span className="text-xs text-muted-foreground ml-auto shrink-0">
                          {new Date(note.updatedAt || note.createdAt).toLocaleString("zh-CN")}
                        </span>
                      </div>
                      <p className={`text-sm whitespace-pre-wrap ${isExpanded ? "" : "line-clamp-2"}`}>
                        {note.content}
                      </p>
                      {note.content.length > 100 && (
                        <button
                          className="text-xs text-primary mt-1 hover:underline flex items-center gap-0.5"
                          onClick={() => toggleExpand(note.id)}
                        >
                          {isExpanded ? <><ChevronUp className="h-3 w-3" /> 收起</> : <><ChevronDown className="h-3 w-3" /> 展开</>}
                        </button>
                      )}
                    </div>
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleDelete(note.id)} title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
