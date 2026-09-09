export interface WorkspaceStatus {
  name: string;
  ok: boolean;
}

export function getWorkspaceStatus(): WorkspaceStatus {
  return { name: "ai-coding-base", ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const status = getWorkspaceStatus();
  console.log(`${status.name}: ${status.ok ? "ok" : "not ok"}`);
}
