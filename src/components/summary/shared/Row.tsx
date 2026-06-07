/**
 * Row 组件 - 简单的行布局
 * 用于显示可删除的项目
 */

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RowProps {
  /** 标签文本 */
  label: string;
  /** 删除回调 */
  onDelete: () => void;
}

export function Row({ label, onDelete }: RowProps) {
  return (
    <div className="flex items-center justify-between py-0.5 px-1.5 rounded hover:bg-muted/50">
      <span>{label}</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 hover:text-destructive"
        onClick={onDelete}
      >
        <Trash2 className="h-2.5 w-2.5" />
      </Button>
    </div>
  );
}
