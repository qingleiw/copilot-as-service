import * as vscode from "vscode";
import * as http from "http";
import * as net from "net";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

// ─── Server State ─────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let statusBarItem: vscode.StatusBarItem;
const activeConnections = new Set<net.Socket>();

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "copilot-as-service.status";
  context.subscriptions.push(statusBarItem);
  updateStatusBar(false);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("copilot-as-service.start", startServer),
    vscode.commands.registerCommand("copilot-as-service.stop", stopServer),
    vscode.commands.registerCommand("copilot-as-service.status", showStatus)
  );

  // Auto-start
  const config = vscode.workspace.getConfiguration("copilotAsService");
  if (config.get<boolean>("autoStart", true)) {
    startServer();
  }
}

export function deactivate() {
  stopServer();
}

// ─── Server ───────────────────────────────────────────────────────────────────

function startServer() {
  if (server) {
    vscode.window.showInformationMessage("Copilot as Service is already running.");
    return;
  }

  const config = vscode.workspace.getConfiguration("copilotAsService");
  const port = config.get<number>("port", 3000);
  const host = config.get<string>("host", "127.0.0.1");

  server = http.createServer(handleRequest);

  server.on("connection", (socket: net.Socket) => {
    activeConnections.add(socket);
    socket.once("close", () => activeConnections.delete(socket));
  });

  server.listen(port, host, () => {
    updateStatusBar(true, port);
    console.log(`[Copilot as Service] Listening on http://${host}:${port}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      vscode.window.showErrorMessage(
        `Copilot as Service: Port ${port} is already in use. Change the port in settings.`
      );
    } else {
      vscode.window.showErrorMessage(`Copilot as Service error: ${err.message}`);
    }
    server = null;
    updateStatusBar(false);
  });
}

function stopServer() {
  if (!server) return;
  // Destroy all open sockets so in-flight streaming responses are closed immediately
  for (const socket of activeConnections) {
    socket.destroy();
  }
  activeConnections.clear();
  server.close(() => {
    console.log("[Copilot as Service] Server stopped.");
  });
  server = null;
  updateStatusBar(false);
}

function showStatus() {
  const config = vscode.workspace.getConfiguration("copilotAsService");
  const port = config.get<number>("port", 3000);
  const host = config.get<string>("host", "127.0.0.1");

  if (server) {
    vscode.window.showInformationMessage(
      `✅ Copilot as Service running on http://${host}:${port}`,
      "Stop Server",
      "Copy URL"
    ).then((choice) => {
      if (choice === "Stop Server") stopServer();
      if (choice === "Copy URL") {
        vscode.env.clipboard.writeText(`http://${host}:${port}/v1`);
        vscode.window.showInformationMessage("URL copied to clipboard!");
      }
    });
  } else {
    vscode.window.showInformationMessage(
      "❌ Copilot as Service is not running.",
      "Start Server"
    ).then((choice) => {
      if (choice === "Start Server") startServer();
    });
  }
}

// ─── Request Handler ──────────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth check
  const config = vscode.workspace.getConfiguration("copilotAsService");
  const authToken = config.get<string>("authToken", "");
  if (authToken) {
    const authHeader = req.headers["authorization"] || "";
    if (authHeader !== `Bearer ${authToken}`) {
      sendJson(res, 401, { error: { message: "Unauthorized", type: "auth_error" } });
      return;
    }
  }

  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  try {
    if (pathname === "/v1/models" && req.method === "GET") {
      await handleModels(res);
    } else if (pathname === "/v1/chat/completions" && req.method === "POST") {
      await handleChatCompletions(req, res);
    } else if (pathname === "/" || pathname === "/health") {
      sendJson(res, 200, { status: "ok", service: "copilot-as-service" });
    } else {
      sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("[Copilot as Service] Error:", err);
    sendJson(res, 500, { error: { message, type: "server_error" } });
  }
}

// ─── /v1/models ───────────────────────────────────────────────────────────────

async function handleModels(res: http.ServerResponse) {
  let models: vscode.LanguageModelChat[] = [];
  try {
    const timeout = new Promise<[]>((resolve) => setTimeout(() => resolve([]), 3000));
    models = await Promise.race([vscode.lm.selectChatModels({}), timeout]);
  } catch {
    // lm API not available
  }

  const data = models.map((m) => ({
    id: m.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: m.vendor || "copilot",
  }));

  // Fallback list if no models found
  if (data.length === 0) {
    ["gpt-4o", "gpt-4", "gpt-3.5-turbo", "claude-opus-4.6", "claude-sonnet-4.6"].forEach((id) => {
      data.push({ id, object: "model", created: 0, owned_by: "copilot" });
    });
  }

  sendJson(res, 200, { object: "list", data });
}

// ─── /v1/chat/completions ─────────────────────────────────────────────────────

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const body = await readBody(req);
  let payload: ChatCompletionRequest;

  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON", type: "invalid_request" } });
    return;
  }

  const { messages, stream = false, model } = payload;
  if (!messages || !Array.isArray(messages)) {
    sendJson(res, 400, { error: { message: "messages is required", type: "invalid_request" } });
    return;
  }

  // Build VS Code LM messages
  const lmMessages: vscode.LanguageModelChatMessage[] = messages
    .filter((m) => m.role !== "system")
    .map((m) =>
      m.role === "user"
        ? vscode.LanguageModelChatMessage.User(m.content)
        : vscode.LanguageModelChatMessage.Assistant(m.content)
    );

  // System message → prepend to first user message
  const systemMsg = messages.find((m) => m.role === "system");
  if (systemMsg && lmMessages.length > 0) {
    const first = lmMessages[0];
    lmMessages[0] = vscode.LanguageModelChatMessage.User(
      `[System]: ${systemMsg.content}\n\n${(first.content as any)[0]?.value || ""}`
    );
  }

  // Select model
  const config = vscode.workspace.getConfiguration("copilotAsService");
  const defaultModel = config.get<string>("defaultModel", "copilot-gpt-4o");
  const requestedModel = model || defaultModel;

  let selectedModel: vscode.LanguageModelChat | undefined;
  try {
    const timeout = new Promise<[]>((resolve) => setTimeout(() => resolve([]), 5000));
    const available = await Promise.race([vscode.lm.selectChatModels({}), timeout]);
    selectedModel =
      available.find((m) => m.id === requestedModel) ||
      available.find((m) => m.id.includes("gpt-4")) ||
      available[0];
  } catch (err) {
    sendJson(res, 503, {
      error: {
        message: "GitHub Copilot is not available. Make sure you are signed in.",
        type: "service_unavailable",
      },
    });
    return;
  }

  if (!selectedModel) {
    sendJson(res, 503, {
      error: {
        message: "No Copilot models available. Please sign in to GitHub Copilot.",
        type: "service_unavailable",
      },
    });
    return;
  }

  const completionId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  try {
    const response = await selectedModel.sendRequest(
      lmMessages,
      {},
      new vscode.CancellationTokenSource().token
    );

    if (stream) {
      // Streaming response
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      for await (const chunk of response.text) {
        if (res.destroyed || res.writableEnded) break;
        const data = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: selectedModel.id,
          choices: [
            {
              index: 0,
              delta: { content: chunk },
              finish_reason: null,
            },
          ],
        };
        await writeSSE(res, `data: ${JSON.stringify(data)}\n\n`);
      }

      if (!res.destroyed && !res.writableEnded) {
        // Final chunk
        const finalData = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: selectedModel.id,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        await writeSSE(res, `data: ${JSON.stringify(finalData)}\n\n`);
        await writeSSE(res, "data: [DONE]\n\n");
        res.end();
      }
    } else {
      // Non-streaming: collect full response
      let fullText = "";
      for await (const chunk of response.text) {
        fullText += chunk;
      }

      sendJson(res, 200, {
        id: completionId,
        object: "chat.completion",
        created,
        model: selectedModel.id,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fullText },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: -1,
          completion_tokens: -1,
          total_tokens: -1,
        },
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Copilot request failed";
    sendJson(res, 502, { error: { message, type: "upstream_error" } });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Awaitable SSE write — waits for the kernel buffer to drain before resolving,
 * preventing "Overlapping flush calls" warnings.
 */
function writeSSE(res: http.ServerResponse, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (res.destroyed || res.writableEnded) {
      resolve();
      return;
    }
    const ok = res.write(data, (err) => {
      if (err) reject(err);
      else resolve();
    });
    // If the internal buffer is full, wait for it to drain first
    if (!ok) {
      res.once("drain", resolve);
    }
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function updateStatusBar(running: boolean, port?: number) {
  if (running) {
    statusBarItem.text = `$(broadcast) Copilot API :${port}`;
    statusBarItem.tooltip = `Copilot as Service running on port ${port}. Click for options.`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(circle-slash) Copilot API`;
    statusBarItem.tooltip = "Copilot as Service is stopped. Click to start.";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }
  statusBarItem.show();
}
