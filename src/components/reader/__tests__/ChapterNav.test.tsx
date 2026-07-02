import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChapterNav } from "../ChapterNav";
import { useNovelStore } from "@/stores/novel-store";

// Mock loadChapters
vi.mock("@/db/repositories", () => ({
  loadChapters: vi.fn().mockResolvedValue([]),
}));

// Mock ScrollArea to just render children
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, ...props }: any) => <div data-testid="scroll-area" {...props}>{children}</div>,
}));

const mockNovel = {
  id: "novel-1",
  title: "测试小说",
  author: "作者",
  fileName: "test.txt",
  fileFormat: "txt",
  totalChars: 10000,
  chapterCount: 3,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  chapters: [
    { id: "ch-1", title: "第一章", index: 0, content: "内容1" },
    { id: "ch-2", title: "第二章", index: 1, content: "" },
    { id: "ch-3", title: "第三章", index: 2, content: "" },
  ],
};

describe("ChapterNav", () => {
  beforeEach(() => {
    // Reset store
    useNovelStore.setState({
      currentNovel: null,
      selectedChapterId: null,
      readingPositions: {},
    });
  });

  it("没有小说时不渲染", () => {
    const { container } = render(<ChapterNav />);
    expect(container.innerHTML).toBe("");
  });

  it("有小说时显示章节列表", () => {
    useNovelStore.setState({ currentNovel: mockNovel, selectedChapterId: "ch-1" });
    render(<ChapterNav />);
    expect(screen.getByText("《测试小说》")).toBeDefined();
    expect(screen.getByText("共 3 章")).toBeDefined();
    expect(screen.getByText("第一章")).toBeDefined();
    expect(screen.getByText("第二章")).toBeDefined();
    expect(screen.getByText("第三章")).toBeDefined();
  });

  it("选中的章节高亮显示", () => {
    useNovelStore.setState({ currentNovel: mockNovel, selectedChapterId: "ch-2" });
    render(<ChapterNav />);
    const ch2Button = screen.getByText("第二章").closest("button")!;
    expect(ch2Button.className).toContain("bg-primary/10");
    expect(ch2Button.className).toContain("text-primary");
  });

  it("未加载的章节显示(未加载)标签", () => {
    useNovelStore.setState({ currentNovel: mockNovel, selectedChapterId: "ch-1" });
    render(<ChapterNav />);
    // ch-2 and ch-3 have empty content, both show "(未加载)"
    const unloadedLabels = screen.getAllByText("(未加载)");
    expect(unloadedLabels.length).toBe(2);
  });

  it("已加载的章节不显示(未加载)标签", () => {
    useNovelStore.setState({ currentNovel: mockNovel, selectedChapterId: "ch-1" });
    render(<ChapterNav />);
    // ch-1 has content, should not show "(未加载)"
    const ch1Button = screen.getByText("第一章").closest("button")!;
    expect(ch1Button.textContent).not.toContain("未加载");
  });

  it("点击已加载的章节调用 setSelectedChapter", async () => {
    const setSelectedChapter = vi.fn();
    useNovelStore.setState({
      currentNovel: mockNovel,
      selectedChapterId: "ch-1",
      setSelectedChapter,
    });
    render(<ChapterNav />);
    fireEvent.click(screen.getByText("第一章"));
    expect(setSelectedChapter).toHaveBeenCalledWith("ch-1");
  });

  it("点击收起按钮切换为折叠状态", () => {
    useNovelStore.setState({ currentNovel: mockNovel, selectedChapterId: "ch-1" });
    render(<ChapterNav />);
    const collapseButton = screen.getByTitle("收起目录");
    fireEvent.click(collapseButton);
    // After collapse, chapter list should not be visible
    expect(screen.queryByText("第一章")).toBeNull();
    // Expand button should appear
    expect(screen.getByTitle("展开目录")).toBeDefined();
  });

  it("折叠后点击展开按钮恢复目录", () => {
    useNovelStore.setState({ currentNovel: mockNovel, selectedChapterId: "ch-1" });
    render(<ChapterNav />);
    // Collapse first
    fireEvent.click(screen.getByTitle("收起目录"));
    expect(screen.queryByText("第一章")).toBeNull();
    // Expand
    fireEvent.click(screen.getByTitle("展开目录"));
    expect(screen.getByText("第一章")).toBeDefined();
  });
});
