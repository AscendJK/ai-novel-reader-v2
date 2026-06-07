import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useAPIStore } from "@/stores/api-store";
import { Badge } from "@/components/ui/badge";

export function ProviderSelect() {
  const { providers, activeProviderId, setActiveProvider } = useAPIStore();
  const configured = providers.filter((p) => p.apiKey);

  return (
    <div className="space-y-2">
    <Label htmlFor="active-provider">API 提供商</Label>
    <Select
      value={activeProviderId || undefined}
      onValueChange={(v) => setActiveProvider(v)}
    >
      <SelectTrigger id="active-provider" name="active-provider" className="w-full">
        <SelectValue placeholder="选择 API 提供商" />
      </SelectTrigger>
      <SelectContent>
        {configured.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            <div className="flex items-center gap-2">
              <span>{p.name || "未命名"}</span>
              <Badge variant="outline" className="text-[10px]">
                {p.format === "anthropic" ? "Anthropic" : "OpenAI"}
              </Badge>
              <span className="text-xs text-muted-foreground">({p.model})</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    </div>
  );
}
