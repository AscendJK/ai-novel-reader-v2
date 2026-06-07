/**
 * 笔记 Tab 组件
 * 从 SummaryPanel.tsx 中提取
 */

import {
  ChevronRight, ChevronDown,
  Trash2, StickyNote, Pencil, X, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { useNotes } from "../hooks/useNotes";
import type { NoteItem } from "@/db/repositories";

interface NotesTabProps {
  /** Notes hook 返回值 */
  notesHook: ReturnType<typeof useNotes>;
  /** 过滤后的笔记列表 */
  filteredNotes: NoteItem[];
}

export function NotesTab({ notesHook, filteredNotes }: NotesTabProps) {
  return (
    <>
      {/* 笔记类型切换 */}
      <div className="px-2.5 pb-1 flex gap-1 border-b">
        <Button
          variant={notesHook.noteTab === "chapter" ? "secondary" : "ghost"}
          size="sm"
          className="text-xs h-6"
          onClick={() => notesHook.setNoteTab("chapter")}
        >
          本章笔记
        </Button>
        <Button
          variant={notesHook.noteTab === "book" ? "secondary" : "ghost"}
          size="sm"
          className="text-xs h-6"
          onClick={() => notesHook.setNoteTab("book")}
        >
          全书笔记
        </Button>
      </div>

      {/* 笔记内容 */}
      <div className="px-2.5 pt-2 pb-2 space-y-2">
        {/* 输入区域 */}
        <div className="space-y-1.5">
          <Textarea
            id="note-input"
            name="note-input"
            className="text-xs min-h-[50px]"
            placeholder="写笔记..."
            value={notesHook.noteContent}
            onChange={(e) => notesHook.setNoteContent(e.target.value)}
          />
          <Button
            size="sm"
            className="h-6 text-xs w-full"
            onClick={notesHook.handleSaveNote}
            disabled={notesHook.savingNote || !notesHook.noteContent.trim()}
          >
            <StickyNote className="h-3 w-3 mr-1" />
            保存笔记
          </Button>
        </div>

        {/* 空状态 */}
        {filteredNotes.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            暂无{notesHook.noteTab === "chapter" ? "本章" : "全书"}笔记
          </p>
        )}

        {/* 笔记列表 */}
        {filteredNotes.map((n) => {
          const isExpanded =
            notesHook.noteTab === "chapter"
              ? notesHook.expandedChapter === n.id
              : notesHook.expandedBook === n.id;
          const setExpanded =
            notesHook.noteTab === "chapter"
              ? notesHook.setExpandedChapter
              : notesHook.setExpandedBook;
          const isEditing = notesHook.editingNoteId === n.id;

          return (
            <Card
              key={n.id}
              className="shadow-none overflow-hidden min-w-0"
              style={{ cursor: isEditing ? "default" : "pointer" }}
              onClick={() => {
                if (!isEditing) setExpanded(isExpanded ? null : n.id);
              }}
            >
              <CardHeader className="p-2 pb-0.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1 min-w-0">
                    {isEditing ? null : isExpanded ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <Badge
                      variant={n.source === "ai" ? "secondary" : "outline"}
                      className="text-xs shrink-0"
                    >
                      {n.source === "ai" ? "AI" : "笔记"}
                    </Badge>
                    <CardTitle className="text-xs truncate">
                      {n.sourceLabel}
                    </CardTitle>
                  </div>
                  <div
                    className="flex items-center gap-0.5 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isEditing ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-primary shrink-0"
                          onClick={notesHook.handleSaveEditNote}
                          title="保存"
                        >
                          <Check className="h-2.5 w-2.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 shrink-0"
                          onClick={notesHook.handleCancelEdit}
                          title="取消"
                        >
                          <X className="h-2.5 w-2.5" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-muted-foreground hover:text-primary shrink-0"
                          onClick={() => notesHook.handleEditNote(n)}
                          title="编辑"
                        >
                          <Pencil className="h-2.5 w-2.5" />
                        </Button>
                        {notesHook.noteTab === "chapter" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 text-xs text-muted-foreground hover:text-primary"
                            onClick={() => notesHook.handleMoveToBook(n)}
                            title="移入全书笔记"
                          >
                            移入全书
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 hover:text-destructive shrink-0"
                          onClick={() => notesHook.handleDeleteNote(n.id)}
                        >
                          <Trash2 className="h-2.5 w-2.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(n.updatedAt || n.createdAt).toLocaleString("zh-CN")}
                </p>
              </CardHeader>
              <CardContent className="p-2 pt-0">
                {isEditing ? (
                  <Textarea
                    className="text-xs min-h-[60px]"
                    value={notesHook.editingContent}
                    onChange={(e) => notesHook.setEditingContent(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        notesHook.handleSaveEditNote();
                      }
                    }}
                  />
                ) : (
                  <div
                    className={`text-xs leading-relaxed text-foreground/80 ${
                      isExpanded
                        ? "whitespace-pre-wrap break-all"
                        : "line-clamp-2 break-all"
                    }`}
                  >
                    {n.content}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
