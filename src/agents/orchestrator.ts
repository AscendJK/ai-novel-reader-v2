import type { Agent, OrchestratorTask } from "./types";
import { summarizerAgent, globalSummarizerAgent } from "./summarizer";
import { chunkerAgent } from "./chunker";

const agents: Record<string, Agent> = {
  summarizer: summarizerAgent,
  "global-summarizer": globalSummarizerAgent,
  chunker: chunkerAgent,
};

export function getAgent(name: string): Agent | undefined {
  return agents[name];
}

export function registerAgent(agent: Agent): void {
  agents[agent.name] = agent;
}

export class Orchestrator {
  private tasks: OrchestratorTask[] = [];
  private running = false;
  private onTaskUpdate?: (task: OrchestratorTask) => void;

  onUpdate(callback: (task: OrchestratorTask) => void) {
    this.onTaskUpdate = callback;
  }

  addTask(task: Omit<OrchestratorTask, "status">) {
    this.tasks.push({ ...task, status: "pending" });
  }

  async executeAll(): Promise<OrchestratorTask[]> {
    if (this.running) return this.tasks;
    this.running = true;

    const completed = new Set<string>();
    const remaining = [...this.tasks];

    while (remaining.length > 0) {
      const readyIdx = remaining.findIndex((t) => {
        if (!t.dependsOn || t.dependsOn.length === 0) return true;
        return t.dependsOn.every((d) => completed.has(d));
      });

      if (readyIdx === -1) {
        // Circular dependency or all remaining are blocked
        console.warn("Orchestrator: possible circular dependency, breaking");
        break;
      }

      const task = remaining.splice(readyIdx, 1)[0];
      const agent = getAgent(task.agentName);

      if (!agent) {
        task.status = "failed";
        task.result = { success: false, error: `Agent "${task.agentName}" 未注册` };
        this.notify(task);
        continue;
      }

      task.status = "running";
      this.notify(task);

      try {
        task.result = await agent.run(task.context);
        task.status = task.result.success ? "completed" : "failed";
      } catch (err) {
        task.status = "failed";
        task.result = {
          success: false,
          error: err instanceof Error ? err.message : "未知错误",
        };
      }

      completed.add(task.id);
      this.notify(task);
    }

    this.running = false;
    this.tasks = [];
    return this.tasks;
  }

  private notify(task: OrchestratorTask) {
    this.onTaskUpdate?.(task);
  }

  reset() {
    this.tasks = [];
    this.running = false;
  }
}

export const orchestrator = new Orchestrator();
