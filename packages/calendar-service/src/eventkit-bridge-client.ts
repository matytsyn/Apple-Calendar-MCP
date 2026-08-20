import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket, createConnection } from "node:net";

export type EventKitBridgeMethod =
  | "permission_status"
  | "request_permission"
  | "list_calendars"
  | "list_events"
  | "get_event"
  | "create_event"
  | "update_event"
  | "delete_event";

export type EventKitBridgeClientOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  launchMode?: "auto" | "direct" | "app";
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type ActiveBridge = {
  write(payload: string, callback: (error?: Error | null) => void): void;
  close(): void;
};

export class EventKitBridgeCallError extends Error {
  readonly code: string;
  readonly suggestedAction: string;
  readonly retryable: boolean;

  constructor(error: {
    code: string;
    message: string;
    suggested_action: string;
    retryable: boolean;
  }) {
    super(error.message);
    this.name = "EventKitBridgeCallError";
    this.code = error.code;
    this.suggestedAction = error.suggested_action;
    this.retryable = error.retryable;
  }
}

export class EventKitBridgeClient {
  private active: ActiveBridge | undefined;
  private starting: Promise<ActiveBridge> | undefined;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: EventKitBridgeClientOptions) {}

  async call(method: EventKitBridgeMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const bridge = await this.ensureStarted();
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      bridge.write(`${payload}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  permissionStatus(): Promise<unknown> {
    return this.call("permission_status");
  }

  requestPermission(): Promise<unknown> {
    return this.call("request_permission");
  }

  listCalendars(): Promise<unknown> {
    return this.call("list_calendars");
  }

  listEvents(params: Record<string, unknown>): Promise<unknown> {
    return this.call("list_events", params);
  }

  getEvent(params: Record<string, unknown>): Promise<unknown> {
    return this.call("get_event", params);
  }

  createEvent(params: Record<string, unknown>): Promise<unknown> {
    return this.call("create_event", params);
  }

  updateEvent(params: Record<string, unknown>): Promise<unknown> {
    return this.call("update_event", params);
  }

  deleteEvent(params: Record<string, unknown>): Promise<unknown> {
    return this.call("delete_event", params);
  }

  close(): void {
    if (!this.active) {
      return;
    }

    this.active.close();
    this.active = undefined;
    this.starting = undefined;
  }

  private async ensureStarted(): Promise<ActiveBridge> {
    if (this.active) {
      return this.active;
    }

    if (!this.starting) {
      this.starting = this.startBridge();
    }

    this.active = await this.starting;
    this.starting = undefined;
    return this.active;
  }

  private async startBridge(): Promise<ActiveBridge> {
    if (this.shouldLaunchApp()) {
      return this.startAppBridge();
    }

    return this.startDirectBridge();
  }

  private startDirectBridge(): ActiveBridge {
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.on("error", (error) => this.rejectAll(error));
    child.on("exit", () => {
      this.rejectAll(new Error("EventKit bridge process exited."));
      this.active = undefined;
    });

    return {
      write: (payload, callback) => {
        child.stdin.write(payload, "utf8", callback);
      },
      close: () => {
        child.kill();
      }
    };
  }

  private async startAppBridge(): Promise<ActiveBridge> {
    const appPath = appBundlePathForCommand(this.options.command);
    if (!appPath) {
      throw new Error("EventKit app bridge launch mode requires a .app helper path.");
    }

    const directory = mkdtempSync(join(tmpdir(), "apple-calendar-mcp-bridge-"));
    const socketPath = join(directory, "bridge.sock");
    const child = spawn(
      "/usr/bin/open",
      ["-W", "-n", appPath, "--args", "--bridge-socket", socketPath],
      {
        cwd: this.options.cwd,
        stdio: ["ignore", "ignore", "pipe"]
      }
    );

    child.stderr?.resume();
    child.on("error", (error) => this.rejectAll(error));
    child.on("exit", () => {
      this.rejectAll(new Error("EventKit app bridge process exited."));
      this.active = undefined;
      rmSync(directory, { recursive: true, force: true });
    });

    const socket = await connectUnixSocket(socketPath, child);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleStdout(chunk));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => {
      this.rejectAll(new Error("EventKit app bridge socket closed."));
      this.active = undefined;
      rmSync(directory, { recursive: true, force: true });
    });

    return {
      write: (payload, callback) => {
        socket.write(payload, "utf8", callback);
      },
      close: () => {
        socket.end();
        socket.destroy();
        killIfRunning(child);
        rmSync(directory, { recursive: true, force: true });
      }
    };
  }

  private shouldLaunchApp(): boolean {
    if (this.options.launchMode === "direct") {
      return false;
    }
    if (this.options.launchMode === "app") {
      return true;
    }
    return appBundlePathForCommand(this.options.command) !== null;
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let response: unknown;

    try {
      response = JSON.parse(line);
    } catch {
      this.rejectAll(new Error("EventKit bridge returned invalid JSON."));
      return;
    }

    if (!isBridgeResponse(response)) {
      this.rejectAll(new Error("EventKit bridge returned an invalid response shape."));
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);

    if (response.success) {
      pending.resolve(response.data);
    } else {
      pending.reject(new EventKitBridgeCallError(response.error));
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isBridgeResponse(value: unknown): value is
  | { id: string; success: true; data: unknown }
  | {
      id: string;
      success: false;
      error: {
        code: string;
        message: string;
        suggested_action: string;
        retryable: boolean;
      };
    } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.success !== "boolean") {
    return false;
  }

  if (record.success === true) {
    return "data" in record;
  }

  const error = record.error;
  if (!error || typeof error !== "object") {
    return false;
  }

  const errorRecord = error as Record<string, unknown>;
  return (
    typeof errorRecord.code === "string" &&
    typeof errorRecord.message === "string" &&
    typeof errorRecord.suggested_action === "string" &&
    typeof errorRecord.retryable === "boolean"
  );
}

function appBundlePathForCommand(command: string): string | null {
  if (command.endsWith(".app")) {
    return command;
  }

  const marker = ".app/Contents/MacOS/";
  const markerIndex = command.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  return command.slice(0, markerIndex + ".app".length);
}

async function connectUnixSocket(socketPath: string, child: ChildProcess): Promise<Socket> {
  const deadline = Date.now() + 5000;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("EventKit app bridge exited before opening its socket.");
    }

    try {
      return await tryConnectUnixSocket(socketPath);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await delay(50);
    }
  }

  throw lastError ?? new Error("Timed out waiting for EventKit app bridge socket.");
}

function tryConnectUnixSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);

    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function killIfRunning(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
}
