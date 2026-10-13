import { SecretScreen } from "../src/secret-screen.ts";
import { assert, assertEq, test } from "./harness.ts";

test("secret screen: flags high-confidence credential material", () => {
	const screen = new SecretScreen();
	const samples = [
		"-----BEGIN RSA PRIVATE KEY-----",
		"-----BEGIN PGP PRIVATE KEY BLOCK-----",
		"AKIAIOSFODNN7EXAMPLE",
		`ASIA${"A".repeat(16)}`,
		`sk-proj-${"a".repeat(24)}`,
		"Bearer abcdefghijklmnopqrstuvwxyz123456",
		"https://user:tok3nvalue@example.com/repo.git",
		`ghp_${"a".repeat(36)}`,
		`sk-ant-${"a".repeat(24)}`,
		"xoxb-1234567890-abcdefghij",
		'password = "hunter2secret"',
		'{"password":"hunter2secret"}',
		"API_KEY=abcd1234efgh5678",
		"postgres://user:pa55word@db.internal:5432/app",
	];
	for (const sample of samples) {
		assert(screen.scan(sample).length > 0, `expected a hit for ${sample}`);
	}
});

test("secret screen: placeholder assignments are not hits", () => {
	const screen = new SecretScreen();
	assertEq(screen.scan('password = "changeme"').length, 0);
	assertEq(screen.scan("api_key = ${API_KEY_FROM_ENV}").length, 0);
});

test("secret screen: leaves ordinary prose and code alone", () => {
	const screen = new SecretScreen();
	assertEq(screen.scan("see src/config.ts for how the key is loaded").length, 0);
	assertEq(screen.scan("const total = compute(1, 2); // password hashing path").length, 0);
});

test("secret screen: reports the rule and line, not the value", () => {
	const screen = new SecretScreen();
	const hits = screen.scan(`line one\npassword = "hunter2secret"\nline three`);
	assertEq(hits.length, 1);
	assertEq(hits[0].rule, "credential-assignment");
	assertEq(hits[0].line, 2);
	assert(!JSON.stringify(hits).includes("hunter2"), "the value must not be echoed");
});
