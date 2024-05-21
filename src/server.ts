import { Serve, Server } from "bun";

interface Dependency {
  dependents: Set<string>;
  dependencies: Set<string>;
  isHmrEnabled: boolean;
  isHmrAccepted: boolean;
  needsReplacement: boolean;
}

export class BunHmrEngine<T = unknown> {
  clients: Set<WebSocket> = new Set();
  dependencyTree = new Map<string, Dependency>();
  server: Server;

  constructor(serve: Serve<T> & { hmrEndpoint: string }) {
    this.server = Bun.serve({
      ...serve,
      websocket: {
        message(ws, message) {},

        open: (ws) => {
          this.registerListener(ws);
        },
      },
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (
          pathname != serve.hmrEndpoint ||
          request.headers.get("sec-websocket-protocol") !== "esm-hmr"
        )
          return serve.fetch.call(this, request, this) as Response;

        const upgraded = this.upgrade(request, {
          headers: { "sec-websocket-protocol": "esm-hmr" },
        });

        if (!upgraded) return new Response("Upgrade failed", { status: 400 });

        return new Response(null, { status: 204 });
      },
    });
  }

  registerListener(client: WebSocket) {
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "hotAccept") {
        const entry = this.getEntry(message.id, true) as Dependency;
        entry.isHmrAccepted = true;
      }
    });
  }

  createEntry(sourceUrl: string) {
    const newEntry: Dependency = {
      dependencies: new Set(),
      dependents: new Set(),
      needsReplacement: false,
      isHmrEnabled: false,
      isHmrAccepted: false,
    };
    this.dependencyTree.set(sourceUrl, newEntry);
    return newEntry;
  }

  getEntry(sourceUrl: string, createIfNotFound = false) {
    const result = this.dependencyTree.get(sourceUrl);
    if (result) {
      return result;
    }
    if (createIfNotFound) {
      return this.createEntry(sourceUrl);
    }
    return null;
  }

  setEntry(sourceUrl: string, imports: string[], isHmrEnabled = false) {
    const result = this.getEntry(sourceUrl, true)!;
    const outdatedDependencies = new Set(result.dependencies);
    result.isHmrEnabled = isHmrEnabled;
    for (const importUrl of imports) {
      this.addRelationship(sourceUrl, importUrl);
      outdatedDependencies.delete(importUrl);
    }
    for (const importUrl of outdatedDependencies) {
      this.removeRelationship(sourceUrl, importUrl);
    }
  }

  removeRelationship(sourceUrl: string, importUrl: string) {
    let importResult = this.getEntry(importUrl);
    importResult && importResult.dependents.delete(sourceUrl);
    const sourceResult = this.getEntry(sourceUrl);
    sourceResult && sourceResult.dependencies.delete(importUrl);
  }

  addRelationship(sourceUrl: string, importUrl: string) {
    if (importUrl !== sourceUrl) {
      let importResult = this.getEntry(importUrl, true)!;
      importResult.dependents.add(sourceUrl);
      const sourceResult = this.getEntry(sourceUrl, true)!;
      sourceResult.dependencies.add(importUrl);
    }
  }

  markEntryForReplacement(entry: Dependency, state: boolean) {
    entry.needsReplacement = state;
  }

  broadcastMessage(data: object) {
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      } else {
        this.disconnectClient(client);
      }
    });
  }

  connectClient(client: WebSocket) {
    this.clients.add(client);
  }

  disconnectClient(client: WebSocket) {
    client.terminate();
    this.clients.delete(client);
  }

  disconnectAllClients() {
    for (const client of this.clients) {
      this.disconnectClient(client);
    }
  }
}
