import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <div className="w-full max-w-2xl px-6 py-16 text-center">
        <h1 className="text-3xl font-bold mb-2">欢迎使用 OpenHorn</h1>
        <p className="text-muted-foreground text-lg mb-8">统一会话里的 Chat 与 Agent AI 助手</p>

        <div className="flex justify-center gap-3 mb-12">
          <Button asChild size="lg">
            <Link href="/chat">
              <MessageSquare size={20} />
              进入会话
            </Link>
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border p-5 text-left">
            <h3 className="font-semibold mb-1">统一会话</h3>
            <p className="text-sm text-muted-foreground">
              同一个会话里连续切换 Chat 与 Agent，不再拆成两套侧栏和两套中部页面。
            </p>
          </div>
          <div className="rounded-lg border p-5 text-left">
            <h3 className="font-semibold mb-1">Agent</h3>
            <p className="text-sm text-muted-foreground">
              Agent 执行过程折叠在消息下方，默认展示最终回答，需要时再展开细节。
            </p>
          </div>
          <div className="rounded-lg border p-5 text-left">
            <h3 className="font-semibold mb-1">渠道与工具</h3>
            <p className="text-sm text-muted-foreground">
              在设置里统一管理模型渠道与 MCP 工具能力，保持使用路径简单。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
