/**
 * pi-consult — consultant child environment.
 *
 * One owner for what a consultant process can see. Consultants receive the
 * minimum needed to run and authenticate: shell basics plus provider
 * credentials for their own vendor. Unrelated secrets in the parent
 * environment never reach them.
 */

export class ConsultantEnv {
	private static readonly COMMON = [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"LANG",
		"TERM",
		"TMPDIR",
		"TZ",
		"NO_COLOR",
		"DISPLAY",
		"SSH_AUTH_SOCK",
	];
	private static readonly COMMON_PREFIX = ["LC_", "XDG_"];
	private static readonly CLAUDE_PREFIX = [
		"ANTHROPIC_",
		"CLAUDE_",
		"AWS_REGION",
		"AWS_PROFILE",
		"AWS_DEFAULT_REGION",
		"CLOUD_ML_REGION",
		"GOOGLE_",
	];
	private static readonly CODEX_PREFIX = ["OPENAI_", "CODEX_", "AZURE_OPENAI_"];

	/** The environment for a Claude Code child. */
	static claude(): NodeJS.ProcessEnv {
		const env = ConsultantEnv.build(ConsultantEnv.CLAUDE_PREFIX);
		delete env.CLAUDECODE;
		delete env.CLAUDE_CODE_ENTRYPOINT;
		return env;
	}

	/** The environment for a Codex child. */
	static codex(): NodeJS.ProcessEnv {
		return ConsultantEnv.build(ConsultantEnv.CODEX_PREFIX);
	}

	private static build(providerPrefixes: readonly string[]): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
		for (const [key, value] of Object.entries(process.env)) {
			if (value === undefined) continue;
			if (
				ConsultantEnv.COMMON.includes(key) ||
				ConsultantEnv.matches(key, ConsultantEnv.COMMON_PREFIX) ||
				ConsultantEnv.matches(key, providerPrefixes)
			) {
				env[key] = value;
			}
		}
		return env;
	}

	private static matches(key: string, prefixes: readonly string[]): boolean {
		return prefixes.some((prefix) => key.startsWith(prefix));
	}
}
