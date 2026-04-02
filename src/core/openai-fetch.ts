type RequestFunction = (
	options: {
		hostname: string;
		port: string | number;
		path: string;
		method: string;
		headers: Record<string, string>;
	},
	callback: (response: NodeLikeIncomingMessage) => void,
) => NodeLikeClientRequest;

interface NodeLikeIncomingMessage {
	headers: Record<string, string | string[] | undefined>;
	statusCode?: number;
	statusMessage?: string;
	on(event: "data", listener: (chunk: unknown) => void): void;
	on(event: "end", listener: () => void): void;
	on(event: "error", listener: (error: Error) => void): void;
}

interface NodeLikeClientRequest {
	on(event: "error", listener: (error: Error) => void): void;
	write(chunk: string | Uint8Array): void;
	end(): void;
	destroy(error?: Error): void;
}

interface NodeHttpRuntime {
	httpRequest: RequestFunction;
	httpsRequest: RequestFunction;
	URL: typeof URL;
}

interface CreateOpenAIFetchAdapterOptions {
	fetchImpl?: typeof fetch;
	nodeRuntime?: NodeHttpRuntime | null;
}

export function createOpenAIFetchAdapter(options: CreateOpenAIFetchAdapterOptions = {}): typeof fetch {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const nodeRuntime = options.nodeRuntime ?? getNodeHttpRuntime();

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (nodeRuntime) {
			return requestViaNodeHttp(input, init, nodeRuntime);
		}

		return fetchImpl(input, init);
	};
}

export function getNodeHttpRuntime(nodeRequire: unknown = (globalThis as { require?: unknown }).require): NodeHttpRuntime | null {
	if (typeof nodeRequire !== "function") {
		return null;
	}

	try {
		const http = nodeRequire("http") as { request?: RequestFunction };
		const https = nodeRequire("https") as { request?: RequestFunction };
		const url = nodeRequire("url") as { URL?: typeof URL };

		if (!http.request || !https.request || !url.URL) {
			return null;
		}

		return {
			httpRequest: http.request,
			httpsRequest: https.request,
			URL: url.URL,
		};
	} catch {
		return null;
	}
}

async function requestViaNodeHttp(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	runtime: NodeHttpRuntime,
): Promise<Response> {
	const url = toUrlString(input);
	const urlObject = new runtime.URL(url);
	const isHttps = urlObject.protocol === "https:";
	const request = isHttps ? runtime.httpsRequest : runtime.httpRequest;
	const headers = normalizeHeaders(init?.headers);
	const body = await normalizeBody(init?.body);

	return new Promise<Response>((resolve, reject) => {
		const clientRequest = request(
			{
				hostname: urlObject.hostname === "localhost" ? "127.0.0.1" : urlObject.hostname,
				port: urlObject.port || (isHttps ? 443 : 80),
				path: `${urlObject.pathname}${urlObject.search}`,
				method: init?.method ?? "GET",
				headers,
			},
			(response) => {
				const abortError = new Error("Request aborted");
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						response.on("data", (chunk) => {
							controller.enqueue(toUint8Array(chunk));
						});

						response.on("end", () => {
							controller.close();
						});

						response.on("error", (error) => {
							controller.error(error);
						});

						if (init?.signal) {
							init.signal.addEventListener(
								"abort",
								() => {
									controller.error(abortError);
								},
								{ once: true },
							);
						}
					},
				});

				resolve(
					new Response(stream, {
						status: response.statusCode ?? 0,
						statusText: response.statusMessage ?? "",
						headers: new Headers(flattenHeaders(response.headers)),
					}),
				);
			},
		);

		const abort = () => {
			clientRequest.destroy(new Error("Request aborted"));
			reject(new Error("Request aborted"));
		};

		if (init?.signal?.aborted) {
			abort();
			return;
		}

		clientRequest.on("error", (error) => {
			reject(error);
		});

		if (init?.signal) {
			init.signal.addEventListener("abort", abort, { once: true });
		}

		if (body !== undefined) {
			clientRequest.write(body);
		}

		clientRequest.end();
	});
}

function toUrlString(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}

	if (input instanceof URL) {
		return input.toString();
	}

	return input.url;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
	if (!headers) {
		return {};
	}

	if (headers instanceof Headers) {
		const entries: Record<string, string> = {};
		headers.forEach((value, key) => {
			entries[key] = value;
		});
		return entries;
	}

	if (Array.isArray(headers)) {
		return Object.fromEntries(headers);
	}

	return { ...headers };
}

async function normalizeBody(body: BodyInit | null | undefined): Promise<string | Uint8Array | undefined> {
	if (body == null) {
		return undefined;
	}

	if (typeof body === "string") {
		return body;
	}

	if (body instanceof URLSearchParams) {
		return body.toString();
	}

	if (body instanceof ArrayBuffer) {
		return new Uint8Array(body);
	}

	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}

	if (typeof Blob !== "undefined" && body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}

	return new TextEncoder().encode(String(body));
}

function flattenHeaders(headers: NodeLikeIncomingMessage["headers"]): Record<string, string> {
	const flattened: Record<string, string> = {};

	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) {
			continue;
		}

		flattened[key] = Array.isArray(value) ? value.join(", ") : value;
	}

	return flattened;
}

function toUint8Array(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) {
		return chunk;
	}

	if (chunk instanceof ArrayBuffer) {
		return new Uint8Array(chunk);
	}

	if (ArrayBuffer.isView(chunk)) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	}

	if (typeof chunk === "string") {
		return new TextEncoder().encode(chunk);
	}

	return new TextEncoder().encode(String(chunk));
}
