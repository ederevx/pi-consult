/**
 * pi-consult — high-confidence secret screening.
 *
 * A brief leaves the machine, so obvious credential material is refused
 * before any consultant is spawned. Only high-confidence patterns are
 * screened; the excerpt shown to the model is the rule and line, never the
 * matched value.
 */

/** One detected secret pattern. */
export interface SecretHit {
	rule: string;
	line: number;
}

export class SecretScreen {
	private static readonly RULES: ReadonlyArray<{ name: string; pattern: RegExp; ignore?: RegExp }> = [
		{ name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/ },
		{ name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
		{ name: "aws-temp-key", pattern: /\bASIA[0-9A-Z]{16}\b/ },
		{
			name: "aws-secret-key",
			pattern: /(?:aws_secret_access_key|secret_access_key)["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i,
		},
		{ name: "github-token", pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/ },
		{ name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
		{ name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
		{ name: "openai-key", pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b/ },
		{ name: "openai-legacy-key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
		{ name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
		{ name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
		{ name: "slack-app-token", pattern: /\bxapp-[A-Za-z0-9-]{10,}\b/ },
		{ name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
		{ name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
		{ name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
		{ name: "url-credentials", pattern: /\bhttps?:\/\/[^\s:@/]+:[^\s@/]+@/i },
		{
			name: "credential-assignment",
			pattern:
				/(?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[A-Za-z0-9_+/=.-]{16,})/i,
			ignore: /[:=]\s*["']?(?:changeme|placeholder|example|redacted|your[_-]?\w*|x{4,}|\*{3,}|<[^>]+>|\$\{[^}]+\})/i,
		},
		{
			name: "connection-string",
			pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/i,
		},
	];

	/** Every high-confidence secret hit in the text. */
	scan(text: string): SecretHit[] {
		const hits: SecretHit[] = [];
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			for (const rule of SecretScreen.RULES) {
				if (rule.ignore?.test(lines[index])) continue;
				if (rule.pattern.test(lines[index])) {
					hits.push({ rule: rule.name, line: index + 1 });
					break;
				}
			}
		}
		return hits;
	}
}
