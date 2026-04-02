import { describe, expect, it } from "vitest";
import { findNoteReferences } from "../core/context-resolver";

describe("context resolver", () => {
	it("finds wiki links and markdown note links", () => {
		const refs = findNoteReferences("[[Note]] and [Other](folder/file)");
		expect(refs).toHaveLength(2);
		expect(refs[0]?.path).toBe("Note");
		expect(refs[1]?.path).toBe("folder/file");
	});

	it("deduplicates references and ignores external urls", () => {
		const refs = findNoteReferences("[[Note]] [Link](https://example.com) [[Note]]");
		expect(refs).toHaveLength(1);
		expect(refs[0]?.path).toBe("Note");
	});
});
