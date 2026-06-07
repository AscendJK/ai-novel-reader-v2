/**
 * useNotes hook - 笔记管理逻辑
 * 从 SummaryPanel.tsx 中提取
 */

import { useState, useCallback } from "react";
import { loadNotes, saveNote, deleteNote } from "@/db/repositories";
import type { NoteItem } from "@/db/repositories";
import { syncClient } from "@/sync/sync-client";

interface UseNotesOptions {
  /** 小说 ID */
  novelId: string;
  /** 当前选中的章节 ID */
  selectedChapterId: string | null;
  /** 章节列表 */
  chapters: { id: string; title: string }[];
}

interface UseNotesReturn {
  /** 笔记列表 */
  notes: NoteItem[];
  /** 设置笔记列表 */
  setNotes: React.Dispatch<React.SetStateAction<NoteItem[]>>;
  /** 笔记内容 */
  noteContent: string;
  /** 设置笔记内容 */
  setNoteContent: React.Dispatch<React.SetStateAction<string>>;
  /** 笔记 tab（章节/全书） */
  noteTab: "chapter" | "book";
  /** 设置笔记 tab */
  setNoteTab: React.Dispatch<React.SetStateAction<"chapter" | "book">>;
  /** 是否正在保存 */
  savingNote: boolean;
  /** 展开的章节 ID */
  expandedChapter: string | null;
  /** 设置展开的章节 ID */
  setExpandedChapter: React.Dispatch<React.SetStateAction<string | null>>;
  /** 展开的全书笔记 */
  expandedBook: string | null;
  /** 设置展开的全书笔记 */
  setExpandedBook: React.Dispatch<React.SetStateAction<string | null>>;
  /** 正在编辑的笔记 ID */
  editingNoteId: string | null;
  /** 正在编辑的内容 */
  editingContent: string;
  /** 设置正在编辑的内容 */
  setEditingContent: React.Dispatch<React.SetStateAction<string>>;
  /** 加载笔记 */
  loadNotesList: () => Promise<void>;
  /** 保存笔记 */
  handleSaveNote: () => Promise<void>;
  /** 删除笔记 */
  handleDeleteNote: (noteId: string) => Promise<void>;
  /** 开始编辑笔记 */
  handleEditNote: (note: NoteItem) => void;
  /** 保存编辑的笔记 */
  handleSaveEditNote: () => Promise<void>;
  /** 取消编辑 */
  handleCancelEdit: () => void;
  /** 移动到全书笔记 */
  handleMoveToBook: (note: NoteItem) => Promise<void>;
}

export function useNotes({
  novelId,
  selectedChapterId,
  chapters,
}: UseNotesOptions): UseNotesReturn {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [noteContent, setNoteContent] = useState("");
  const [noteTab, setNoteTab] = useState<"chapter" | "book">("chapter");
  const [savingNote, setSavingNote] = useState(false);
  const [expandedChapter, setExpandedChapter] = useState<string | null>(null);
  const [expandedBook, setExpandedBook] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");

  // 加载笔记列表
  const loadNotesList = useCallback(async () => {
    try {
      const loadedNotes = await loadNotes(novelId);
      setNotes(loadedNotes);
    } catch (err) {
      console.error("[useNotes] loadNotes error:", err);
    }
  }, [novelId]);

  // 保存笔记
  const handleSaveNote = useCallback(async () => {
    if (!noteContent.trim()) return;
    setSavingNote(true);
    try {
      const chapterId = noteTab === "chapter" && selectedChapterId ? selectedChapterId : "__book__";
      const chapterTitle = noteTab === "chapter"
        ? chapters.find((c) => c.id === selectedChapterId)?.title || "当前章节"
        : "全书笔记";

      const note: NoteItem = {
        id: crypto.randomUUID(),
        novelId,
        chapterId,
        chapterTitle,
        content: noteContent.trim(),
        source: "user",
        sourceLabel: noteTab === "chapter" ? "用户笔记" : "全书笔记",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await saveNote(note);
      setNotes((prev) => [note, ...prev]);
      setNoteContent("");
      syncClient.pushNow();
    } catch (err) {
      console.error("[useNotes] saveNote error:", err);
    } finally {
      setSavingNote(false);
    }
  }, [noteContent, noteTab, selectedChapterId, novelId, chapters]);

  // 删除笔记
  const handleDeleteNote = useCallback(async (noteId: string) => {
    if (!confirm("确定删除这条笔记？")) return;
    try {
      await deleteNote(noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      syncClient.pushNow();
    } catch (err) {
      console.error("[useNotes] deleteNote error:", err);
    }
  }, []);

  // 开始编辑笔记
  const handleEditNote = useCallback((note: NoteItem) => {
    setEditingNoteId(note.id);
    setEditingContent(note.content);
  }, []);

  // 保存编辑的笔记
  const handleSaveEditNote = useCallback(async () => {
    if (!editingNoteId || !editingContent.trim()) return;
    const note = notes.find((n) => n.id === editingNoteId);
    if (!note) return;

    try {
      const updated: NoteItem = {
        ...note,
        content: editingContent.trim(),
        updatedAt: Date.now(),
      };
      await saveNote(updated);
      setNotes((prev) => prev.map((n) => n.id === editingNoteId ? updated : n));
      setEditingNoteId(null);
      setEditingContent("");
      syncClient.pushNow();
    } catch (err) {
      console.error("[useNotes] saveEditNote error:", err);
    }
  }, [editingNoteId, editingContent, notes]);

  // 取消编辑
  const handleCancelEdit = useCallback(() => {
    setEditingNoteId(null);
    setEditingContent("");
  }, []);

  // 移动到全书笔记
  const handleMoveToBook = useCallback(async (note: NoteItem) => {
    try {
      const updated: NoteItem = {
        ...note,
        chapterId: "__book__",
        chapterTitle: "全书笔记",
        sourceLabel: "从章节移入",
        updatedAt: Date.now(),
      };
      await saveNote(updated);
      setNotes((prev) => prev.map((n) => n.id === note.id ? updated : n));
      syncClient.pushNow();
    } catch (err) {
      console.error("[useNotes] moveToBook error:", err);
    }
  }, []);

  return {
    notes,
    setNotes,
    noteContent,
    setNoteContent,
    noteTab,
    setNoteTab,
    savingNote,
    expandedChapter,
    setExpandedChapter,
    expandedBook,
    setExpandedBook,
    editingNoteId,
    editingContent,
    setEditingContent,
    loadNotesList,
    handleSaveNote,
    handleDeleteNote,
    handleEditNote,
    handleSaveEditNote,
    handleCancelEdit,
    handleMoveToBook,
  };
}
