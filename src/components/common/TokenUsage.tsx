import { Badge } from "@/components/ui/badge";

interface TokenUsageProps {
  tokens: number;
  className?: string;
}

export function TokenUsage({ tokens, className }: TokenUsageProps) {
  return (
    <Badge variant="outline" className={className}>
      🪙 ~{tokens} tokens
    </Badge>
  );
}
