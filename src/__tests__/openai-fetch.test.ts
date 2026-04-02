import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIFetchAdapter } from "../core/openai-fetch";

describe("createOpenAIFetchAdapter", () => {
	it("falls back to fetch when node http modules are unavailable", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
		const adapter = createOpenAIFetchAdapter({
			fetchImpl,
			nodeRuntime: null,
		});

		const response = await adapter("https://api.openai.com/v1/responses", {
			method: "POST",
			body: "{}",
		});

		expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/responses", {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe("ok");
	});

	it("uses node http transport when available", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		const writes: Array<string | Uint8Array> = [];

		const httpsRequest = vi.fn((options, callback) => {
			capturedOptions = options as Record<string, unknown>;

			const request = new EventEmitter() as EventEmitter & {
				write: (chunk: string | Uint8Array) => void;
				end: () => void;
				destroy: (error?: Error) => void;
			};

			request.write = (chunk) => {
				writes.push(chunk);
			};
			request.end = () => {
				const response = new EventEmitter() as EventEmitter & {
					headers: Record<string, string>;
					statusCode: number;
					statusMessage: string;
				};
				response.headers = { "content-type": "application/json" };
				response.statusCode = 200;
				response.statusMessage = "OK";
				callback(response);
				response.emit("data", '{"ok":true}');
				response.emit("end");
			};
			request.destroy = vi.fn();
			return request;
		});

		const adapter = createOpenAIFetchAdapter({
			fetchImpl: vi.fn<typeof fetch>(),
			nodeRuntime: {
				httpRequest: vi.fn(),
				httpsRequest,
				URL,
			},
		});

		const response = await adapter("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: new Headers({ "x-test": "1" }),
			body: '{"prompt":"hi"}',
		});

		expect(httpsRequest).toHaveBeenCalledTimes(1);
		expect(capturedOptions).toMatchObject({
			hostname: "api.openai.com",
			path: "/v1/responses",
			method: "POST",
			headers: { "x-test": "1" },
		});
		expect(writes).toEqual(['{"prompt":"hi"}']);
		expect(await response.text()).toBe('{"ok":true}');
	});
});
