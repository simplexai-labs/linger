import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export declare function createStaticHost(options?: {
  root?: string;
  controlToken?: string;
  allowedStaticRoot?: string;
  artifactId?: string;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export declare function serviceProxyRoutes(
  environment: Readonly<Record<string, string | undefined>>,
): {
  "/v0": string | undefined;
  "/api/agent": string | undefined;
  "/document-collaboration": string | undefined;
  "/install": string | undefined;
  "/v1/runner-gateway": string | undefined;
  "/v1/local-mcp-relay": string | undefined;
  "/v1/context-content": string | undefined;
};

export declare function createServiceProxy(
  routes: Readonly<Record<string, string | undefined>>,
): {
  request(request: IncomingMessage, response: ServerResponse): boolean;
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
};

export declare function listenOnHosts(
  makeServer: () => Server,
  port: number,
  hosts: string,
): Promise<Server[]>;
