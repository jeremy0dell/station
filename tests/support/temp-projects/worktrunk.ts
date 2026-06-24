import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TempWorktrunkProject = {
  root: string;
  projectRoot: string;
  configPath: string;
  worktrunkConfigPath: string;
  stateDir: string;
  socketPath: string;
};

export async function createTempWorktrunkProject(): Promise<TempWorktrunkProject> {
  const root = await mkdtemp(join(tmpdir(), "station-wt-project-"));
  const projectRoot = join(root, "repo");
  const stateDir = join(root, "state");
  const socketPath = join(root, "run", "observer.sock");
  const worktrunkConfigPath = join(root, "worktrunk", "config.toml");
  const configPath = join(root, "config.toml");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(socketPath)}`,
      `state_dir = ${JSON.stringify(stateDir)}`,
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "tmux"',
      'harness = "codex"',
      'layout = "agent-shell"',
      "",
      "[worktree.worktrunk]",
      `config_path = ${JSON.stringify(worktrunkConfigPath)}`,
      "",
      "[[projects]]",
      'id = "web"',
      'label = "web"',
      `root = ${JSON.stringify(projectRoot)}`,
      "",
      "[projects.defaults]",
      'harness = "codex"',
      'terminal = "tmux"',
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      'base = "main"',
      "",
    ].join("\n"),
  );

  return {
    root,
    projectRoot,
    configPath,
    worktrunkConfigPath,
    stateDir,
    socketPath,
  };
}
